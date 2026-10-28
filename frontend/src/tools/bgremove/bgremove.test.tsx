import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
const imageThumb = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    BgRemoveService: {
      Presets: async () => [
        { id: "fast", label: "Fast", downloadBytes: 179e6 },
        { id: "balanced", label: "Balanced", downloadBytes: 224e6 },
        { id: "best", label: "Best", downloadBytes: 973e6 },
      ],
      Enqueue: (...a: unknown[]) => enqueue(...a),
    },
    FilesService: {
      Pick: async () => ["/a.png"],
      Stat: async (p: string[]) =>
        p.map((path) => ({ path, name: path, sizeBytes: 10, exists: true, isDir: false, kind: "image" })),
      ImageThumb: (...a: unknown[]) => imageThumb(...a),
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
    LibraryService: { Reveal: async () => undefined, Open: async () => undefined, RevealPath: async () => undefined },
  };
});

import { BgOutput, ErrorCode, JobStatus } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import BgRemoveView from "./BgRemoveView";
import { DEFAULT_BG_OPTIONS, sanitizeBgOptions, submitOptions, toResultItem } from "./options";

describe("bg-remover options", () => {
  it("sanitizes saved options", () => {
    expect(
      sanitizeBgOptions({ model: "best", output: "color", color: "#ABCDEF", padding: 9999 }, DEFAULT_BG_OPTIONS),
    ).toEqual({
      ...DEFAULT_BG_OPTIONS,
      model: "best",
      output: "color",
      color: "#abcdef",
    });
    expect(sanitizeBgOptions({ model: "x", color: "red" }, DEFAULT_BG_OPTIONS)).toEqual(DEFAULT_BG_OPTIONS);
  });

  it("only submits a custom colour for the colour output", () => {
    const o = { ...DEFAULT_BG_OPTIONS, color: "#123456" };
    expect(submitOptions(o).color).toBe("#ffffff");
    expect(submitOptions({ ...o, output: BgOutput.OutputColor }).color).toBe("#123456");
  });
});

describe("BgRemoveView", () => {
  beforeEach(() => {
    enqueue.mockReset();
    imageThumb.mockReset().mockResolvedValue("data:image/png;base64,AAAA");
    useJobs.setState({ byId: {} });
  });

  it("shows the colour picker only for the colour background and enqueues", async () => {
    enqueue.mockResolvedValue([{}]);
    const user = userEvent.setup();
    render(<BgRemoveView moduleId="bg-remover" />);
    await screen.findByRole("radio", { name: /Best/ });
    expect(screen.queryByLabelText("Hex colour")).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Colour" }));
    expect(screen.getByLabelText("Hex colour")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Black" }));
    await user.click(screen.getByRole("switch", { name: "Crop to subject" }));
    expect(screen.getByLabelText("Padding")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Add files…" }));
    const run = await screen.findByRole("button", { name: /Remove background/ });
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    await user.click(run);
    await waitFor(() =>
      expect(enqueue).toHaveBeenCalledWith(
        ["/a.png"],
        expect.objectContaining({ output: "color", color: "#000000", crop: true }),
      ),
    );
  });

  it("renders a finished job as a compare card with a large preview", async () => {
    useJobs.getState().upsert({
      id: "j1",
      moduleId: "bg-remover",
      title: "a.png",
      status: JobStatus.JobDone,
      progress: 1,
      message: "",
      inputs: ["/a.png"],
      optionsJson: JSON.stringify({ output: "transparent" }),
      errorCode: ErrorCode.$zero,
      error: "",
      errorHint: "",
      attempt: 1,
      cancelRequested: false,
      createdAt: 1,
      startedAt: 1,
      finishedAt: 2,
      outputs: null,
      resultJson: JSON.stringify({
        width: 1600,
        height: 1200,
        subjectCoverage: 0.38,
        model: "balanced",
        output: "/o/a (no background).png",
      }),
    });
    render(<BgRemoveView moduleId="bg-remover" />);
    expect((await screen.findAllByText("a (no background).png")).length).toBeGreaterThan(0);
    expect(screen.getByText(/1600×1200 · subject 38%/)).toBeTruthy();
    await screen.findByRole("slider");
    await userEvent.setup().click(screen.getByRole("button", { name: /Enlarge/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await waitFor(() => expect(imageThumb).toHaveBeenCalledWith("/o/a (no background).png", 1600));
  });

  it("toResultItem ignores jobs without a result", () => {
    expect(toResultItem({ resultJson: "", inputs: [], outputs: [] } as never)).toBeNull();
  });
});
