import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
const preview = vi.hoisted(() => vi.fn());
const pickWith = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    ImageBatchService: {
      Defaults: async () => ({}),
      Enqueue: (...a: unknown[]) => enqueue(...a),
      Preview: (...a: unknown[]) => preview(...a),
      Fonts: async () => ["Arial", "Georgia"],
    },
    FilesService: {
      Pick: async () => ["/p/a.jpg", "/p/b.jpg"],
      PickWith: (...a: unknown[]) => pickWith(...a),
      Stat: async (p: string[]) => p.map((path) => ({ path, name: path, sizeBytes: 10, exists: true, isDir: false, kind: "image" })),
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
    LibraryService: { Reveal: async () => undefined, Open: async () => undefined, RevealPath: async () => undefined },
  };
});

import { BatchFormat, BatchResize, BatchWatermarkKind, JobStatus, type Job } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import ImageBatchView from "./ImageBatchView";
import { DEFAULT_BATCH_OPTIONS, advancedSummary, optionsProblem, parseBatch, previewKey, sanitizeBatchOptions } from "./options";

describe("image batch options", () => {
  it("defaults match the Go defaults", () => {
    expect(DEFAULT_BATCH_OPTIONS).toMatchObject({
      resize: "longSide",
      longSide: 2048,
      noEnlarge: true,
      format: "jpg",
      quality: 85,
      strip: true,
      name: "{name}",
      watermark: { kind: "none", font: "Arial", corner: "br", opacity: 0.6, size: 5 },
    });
  });

  it("sanitize keeps valid fields only", () => {
    const out = sanitizeBatchOptions(
      { resize: "exact", width: 99999, height: 0, aspect: "7:3", fit: "pad", background: "transparent", format: "gif", quality: 50, watermark: { kind: "text", text: "hi", opacity: 7, corner: "x" } },
      DEFAULT_BATCH_OPTIONS,
    );
    expect(out.resize).toBe("exact");
    expect(out.width).toBe(20_000);
    expect(out.height).toBe(1);
    expect(out.aspect).toBe("");
    expect(out.fit).toBe("pad");
    expect(out.background).toBe("transparent");
    expect(out.format).toBe("jpg");
    expect(out.quality).toBe(50);
    expect(out.watermark).toMatchObject({ kind: "text", text: "hi", opacity: 1, corner: "br" });
    expect(sanitizeBatchOptions("nope", DEFAULT_BATCH_OPTIONS)).toEqual(DEFAULT_BATCH_OPTIONS);
  });

  it("explains what blocks a run", () => {
    expect(optionsProblem(DEFAULT_BATCH_OPTIONS)).toBe("");
    expect(optionsProblem({ ...DEFAULT_BATCH_OPTIONS, watermark: { ...DEFAULT_BATCH_OPTIONS.watermark, kind: BatchWatermarkKind.WatermarkText } })).toBe("Type the watermark text");
    expect(optionsProblem({ ...DEFAULT_BATCH_OPTIONS, watermark: { ...DEFAULT_BATCH_OPTIONS.watermark, kind: BatchWatermarkKind.WatermarkLogo } })).toBe("Choose the logo image");
  });

  it("the preview ignores settings that don't change the picture", () => {
    const base = previewKey("/a.jpg", DEFAULT_BATCH_OPTIONS);
    expect(previewKey("/a.jpg", { ...DEFAULT_BATCH_OPTIONS, quality: 40, strip: false, name: "x" })).toBe(base);
    expect(previewKey("/a.jpg", { ...DEFAULT_BATCH_OPTIONS, longSide: 1000 })).not.toBe(base);
    expect(previewKey("/b.jpg", DEFAULT_BATCH_OPTIONS)).not.toBe(base);
  });

  it("summarises the advanced settings and parses results safely", () => {
    expect(advancedSummary(DEFAULT_BATCH_OPTIONS)).toBe("JPG · quality 85 · no metadata");
    expect(advancedSummary({ ...DEFAULT_BATCH_OPTIONS, aspect: "1:1", format: BatchFormat.FormatPNG, strip: false })).toBe("1:1 crop · PNG · keep metadata");
    expect(parseBatch("nope")).toEqual({ files: [], failed: [] });
    expect(parseBatch('{"files":[{"input":"/i.jpg","output":"/o.jpg","width":10,"height":5,"bytes":99},{"x":1}],"failed":["b.jpg: bad",1]}')).toEqual({
      files: [{ input: "/i.jpg", output: "/o.jpg", width: 10, height: 5, bytes: 99 }],
      failed: ["b.jpg: bad"],
    });
  });
});

describe("ImageBatchView", () => {
  beforeEach(() => {
    enqueue.mockReset();
    preview.mockReset().mockResolvedValue("data:image/jpeg;base64,AAAA");
    pickWith.mockReset();
    useJobs.setState({ byId: {} });
    useModules.setState({
      byId: { imagebatch: { id: "imagebatch", name: "Image Batch", tagline: "t", accepts: { extensions: [".jpg", ".png"] }, maxInputs: 500, requires: [] } },
    } as never);
  });

  async function addFiles() {
    const user = userEvent.setup();
    render(<ImageBatchView moduleId="imagebatch" />);
    await user.click((await screen.findAllByRole("button", { name: /add files/i }))[0]!);
    await screen.findByLabelText("Input files");
    return user;
  }

  it("shows a live preview of the first picture", async () => {
    await addFiles();
    const img = await screen.findByAltText("Preview of the first picture", {}, { timeout: 3000 });
    expect((img as HTMLImageElement).src).toBe("data:image/jpeg;base64,AAAA");
    expect(preview).toHaveBeenCalledWith("/p/a.jpg", DEFAULT_BATCH_OPTIONS);
  });

  it("submits every picture with the chosen size", async () => {
    enqueue.mockResolvedValue([{ id: "j1" }]);
    const user = await addFiles();
    await user.click(screen.getByRole("radio", { name: "Exact size" }));
    await user.click(screen.getByRole("button", { name: /Process 2 pictures/ }));
    await waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(enqueue).toHaveBeenCalledWith(["/p/a.jpg", "/p/b.jpg"], { ...DEFAULT_BATCH_OPTIONS, resize: BatchResize.ResizeExact });
  });

  it("lists finished pictures and what failed", async () => {
    useJobs.getState().upsert({
      id: "j9",
      moduleId: "imagebatch",
      status: JobStatus.JobDone,
      inputs: ["/p/a.jpg"],
      outputs: [{ id: "o1", path: "/out/a.jpg", name: "a.jpg" }],
      resultJson: '{"files":[{"input":"/p/a.jpg","output":"/out/a.jpg","width":2048,"height":1536,"bytes":204800}],"failed":["c.jpg: bad"]}',
      message: "",
    } as unknown as Job);
    render(<ImageBatchView moduleId="imagebatch" />);
    expect(await screen.findByText("a.jpg")).toBeTruthy();
    expect(screen.getByText("2048 × 1536")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("c.jpg: bad");
  });
});
