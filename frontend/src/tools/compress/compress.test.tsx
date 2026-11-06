import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
const estimate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    CompressService: {
      Defaults: async () => ({}),
      Targets: async () => [
        { id: "discord", label: "Discord", group: "Chat", bytes: 20_000_000, note: "Free accounts" },
        { id: "gmail", label: "Gmail", group: "Email", bytes: 18_000_000, note: "" },
      ],
      Estimate: (...a: unknown[]) => estimate(...a),
      Enqueue: (...a: unknown[]) => enqueue(...a),
    },
    FilesService: {
      Pick: async () => ["/a.mp4"],
      Stat: async (p: string[]) => p.map((path) => ({ path, name: path, sizeBytes: 10, exists: true, isDir: false, kind: "video" })),
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
    LibraryService: { Reveal: async () => undefined, Open: async () => undefined, RevealPath: async () => undefined },
  };
});

import { CompressGrade, CompressKind, DepState, JobStatus, type CompressEstimate, type DepStatus, type Job } from "@/lib/api";
import { useDeps } from "@/state/deps";
import { useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { parseCompressStep } from "@/pipelines/steps/compress";
import { stepUI, type StepEditorProps } from "@/pipelines/steps/registry";
import CompressView from "./CompressView";
import {
  DEFAULT_COMPRESS_OPTIONS,
  cantFitLine,
  estimateTotals,
  formatBytes,
  parseCompressResult,
  sanitizeCompressOptions,
  sizeLine,
} from "./options";

afterEach(cleanup);

describe("compress options", () => {
  it("defaults match the Go defaults", () => {
    expect(DEFAULT_COMPRESS_OPTIONS).toEqual({
      targetId: "discord",
      targetMb: 20,
      ifTooSmall: "lower",
      videoCodec: "h264",
      maxHeight: 0,
      keepAudio: true,
      imageFormat: "auto",
      keepMetadata: false,
    });
  });

  it("sanitize keeps valid fields and ignores junk", () => {
    expect(
      sanitizeCompressOptions(
        { targetId: "custom", targetMb: 0.001, ifTooSmall: "split", videoCodec: "av1", maxHeight: 999, keepAudio: false, imageFormat: "webp", keepMetadata: "yes" },
        DEFAULT_COMPRESS_OPTIONS,
      ),
    ).toEqual({ ...DEFAULT_COMPRESS_OPTIONS, targetId: "custom", targetMb: 0.05, ifTooSmall: "split", keepAudio: false, imageFormat: "webp" });
    expect(sanitizeCompressOptions({ maxHeight: 720, targetMb: 1e9 }, DEFAULT_COMPRESS_OPTIONS)).toMatchObject({ maxHeight: 720, targetMb: 100_000 });
    expect(sanitizeCompressOptions(null, DEFAULT_COMPRESS_OPTIONS)).toEqual(DEFAULT_COMPRESS_OPTIONS);
    expect(sanitizeCompressOptions([1], DEFAULT_COMPRESS_OPTIONS)).toEqual(DEFAULT_COMPRESS_OPTIONS);
  });

  it.each([
    [512, "512 B"],
    [850_000, "850 KB"],
    [12_400_000, "12.4 MB"],
    [512_000_000, "512 MB"],
    [1_250_000_000, "1.25 GB"],
    [1_474_560, "1.5 MB"],
    [20_000_000, "20 MB"],
  ])("formatBytes(%i) = %s", (n, want) => {
    expect(formatBytes(n)).toBe(want);
  });

  it("describes estimates", () => {
    const base = { path: "/a", name: "a", kind: CompressKind.KindVideo, originalBytes: 12_400_000, limitBytes: 20_000_000, alreadyFits: false, possible: true, plan: "", grade: CompressGrade.GradeGood, parts: 1, note: "", problem: "" } as CompressEstimate;
    expect(sizeLine(base)).toBe("12.4 MB → under 20 MB");
    expect(sizeLine({ ...base, alreadyFits: true })).toBe("Already fits");
    expect(cantFitLine({ ...base, possible: false }, "lower")).toBe("Can't fit — try Split into parts");
    expect(cantFitLine({ ...base, possible: false }, "split")).toBe("Can't fit");
    expect(cantFitLine({ ...base, possible: false, kind: CompressKind.KindImage }, "lower")).toBe("Can't fit");
    expect(cantFitLine(base, "lower")).toBe("");
    expect(estimateTotals([base, { ...base, alreadyFits: true }, { ...base, possible: false }, base])).toBe("4 files · 1 already fit · 1 can't fit");
    expect(estimateTotals([base])).toBe("1 file");
  });

  it("parses results safely", () => {
    expect(parseCompressResult("nope")).toEqual([]);
    expect(parseCompressResult('{"outputs":null}')).toEqual([]);
    const files = parseCompressResult('{"input":"/a.mp4","outputs":["/o1.mp4","/o2.mp4"],"originalBytes":100,"finalBytes":40,"limitBytes":50,"fits":true,"grade":"good","plan":"p"}');
    expect(files.map((f) => [f.path, f.part, f.parts])).toEqual([["/o1.mp4", 1, 2], ["/o2.mp4", 2, 2]]);
    expect(files[0]).toMatchObject({ originalBytes: 100, finalBytes: 40, limitBytes: 50, fits: true, grade: "good", plan: "p", alreadyFit: false });
  });
});

function dep(id: string): DepStatus {
  return { id, name: id, state: DepState.DepOK, installHint: "", version: "", path: "", requiredBy: [], recommendedBy: [] } as unknown as DepStatus;
}

describe("CompressView", () => {
  beforeEach(() => {
    enqueue.mockReset();
    estimate.mockReset();
    useJobs.setState({ byId: {} });
    useModules.setState({
      byId: { compress: { id: "compress", name: "Compress to Size", tagline: "t", accepts: { any: true, extensions: [] }, maxInputs: 200, requires: ["ffmpeg", "ffprobe"] } },
    } as never);
    useDeps.getState().setAll([dep("ffmpeg"), dep("ffprobe")]);
  });

  const est = (o: Partial<CompressEstimate> = {}): CompressEstimate => ({
    path: "/a.mp4",
    name: "a.mp4",
    kind: CompressKind.KindVideo,
    originalBytes: 52_000_000,
    limitBytes: 20_000_000,
    alreadyFits: false,
    possible: true,
    plan: "1080p → 720p",
    grade: CompressGrade.GradeFair,
    parts: 1,
    note: "",
    problem: "",
    ...o,
  });

  async function addFile() {
    const user = userEvent.setup();
    render(<CompressView moduleId="compress" />);
    await user.click((await screen.findAllByRole("button", { name: /add files/i }))[0]!);
    await screen.findByLabelText("Input files");
    return user;
  }

  it("shows the target picker and the target's note", async () => {
    render(<CompressView moduleId="compress" />);
    const select = (await screen.findByLabelText("Target")) as HTMLSelectElement;
    await screen.findByText("Free accounts");
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["Chat · Discord — 20 MB", "Email · Gmail — 18 MB", "Custom size…"]);
  });

  it("custom size reveals the MB stepper", async () => {
    const user = userEvent.setup();
    render(<CompressView moduleId="compress" />);
    const select = await screen.findByLabelText("Target");
    expect(screen.queryByLabelText("Custom size")).toBeNull();
    await user.selectOptions(select, "custom");
    expect(await screen.findByLabelText("Custom size")).toBeTruthy();
  });

  it("estimates each file", async () => {
    estimate.mockResolvedValue([est(), est({ path: "/b.png", name: "b.png", alreadyFits: true, kind: CompressKind.KindImage })]);
    await addFile();
    expect((await screen.findByTestId("compress-total", {}, { timeout: 3000 })).textContent).toBe("2 files · 1 already fit");
    expect(screen.getAllByTestId("compress-estimate")).toHaveLength(2);
    expect(screen.getByText("52 MB → under 20 MB")).toBeTruthy();
    expect(screen.getByText("Already fits")).toBeTruthy();
    expect(screen.getByText("Fair")).toBeTruthy();
    expect(estimate).toHaveBeenCalledWith(["/a.mp4"], DEFAULT_COMPRESS_OPTIONS);
  });

  it("suggests splitting when a video can't fit", async () => {
    estimate.mockResolvedValue([est({ possible: false })]);
    await addFile();
    expect(await screen.findByText("Can't fit — try Split into parts", {}, { timeout: 3000 })).toBeTruthy();
  });

  it("submits the options", async () => {
    estimate.mockResolvedValue([est()]);
    enqueue.mockResolvedValue([{ id: "j1" }]);
    const user = await addFile();
    await screen.findByTestId("compress-total", {}, { timeout: 3000 });
    await user.click(screen.getByRole("button", { name: /Compress 1 file/ }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(enqueue).toHaveBeenCalledWith(["/a.mp4"], DEFAULT_COMPRESS_OPTIONS);
  });

  it("lists each split part as a result", async () => {
    useJobs.getState().upsert({
      id: "j9",
      moduleId: "compress",
      status: JobStatus.JobDone,
      inputs: ["/a.mp4"],
      outputs: [
        { id: "o1", path: "/out/a-1.mp4", name: "a-1.mp4" },
        { id: "o2", path: "/out/a-2.mp4", name: "a-2.mp4" },
      ],
      resultJson: '{"input":"/a.mp4","outputs":["/out/a-1.mp4","/out/a-2.mp4"],"originalBytes":90000000,"finalBytes":19000000,"limitBytes":20000000,"fits":true,"grade":"good","plan":"p"}',
      message: "",
    } as unknown as Job);
    render(<CompressView moduleId="compress" />);
    expect(await screen.findByText("a-1.mp4 — part 1 of 2")).toBeTruthy();
    expect(screen.getByText("a-2.mp4 — part 2 of 2")).toBeTruthy();
  });
});

describe("compress step", () => {
  it("parse keeps unknown fields and sanitises", () => {
    expect(parseCompressStep('{"targetId":"gmail","maxHeight":5,"future":1}')).toEqual({ ...DEFAULT_COMPRESS_OPTIONS, targetId: "gmail", future: 1 });
    expect(parseCompressStep("not json")).toEqual(DEFAULT_COMPRESS_OPTIONS);
  });

  it("editor shows the custom size only for custom and round-trips changes", async () => {
    const ui = stepUI("compress");
    if (!ui) throw new Error("no editor");
    const Editor = ui.Editor as ComponentType<StepEditorProps<unknown>>;
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Editor value={DEFAULT_COMPRESS_OPTIONS} onChange={onChange} check={undefined} vars={[]} />);
    expect(screen.queryByLabelText("Custom size (MB)")).toBeNull();
    await user.selectOptions(screen.getByLabelText("Target"), "custom");
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({ ...DEFAULT_COMPRESS_OPTIONS, targetId: "custom" });
    rerender(<Editor value={{ ...DEFAULT_COMPRESS_OPTIONS, targetId: "custom" }} onChange={onChange} check={undefined} vars={[]} />);
    expect(screen.getByLabelText("Custom size (MB)")).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Max video height"), "720");
    expect(onChange.mock.calls.at(-1)?.[0]).toMatchObject({ maxHeight: 720 });
    await user.click(screen.getByRole("switch", { name: "Keep sound" }));
    expect(onChange.mock.calls.at(-1)?.[0]).toMatchObject({ keepAudio: false });
  });
});
