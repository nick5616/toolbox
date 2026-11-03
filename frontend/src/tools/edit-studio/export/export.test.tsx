import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  render: vi.fn(),
  matte: vi.fn(),
  save: vi.fn(),
  cancel: vi.fn(),
  open: vi.fn(),
  reveal: vi.fn(),
  revealPath: vi.fn(),
  addToPost: vi.fn(),
  sources: { value: [] as unknown[] },
  mattes: { value: [] as unknown[] },
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    EditStudioService: {
      Render: (...a: unknown[]) => h.render(...a),
      Matte: (...a: unknown[]) => h.matte(...a),
      Save: (...a: unknown[]) => h.save(...a),
      Sources: async () => h.sources.value,
      Mattes: async () => h.mattes.value,
      Analysis: async () => {
        throw new Error("none");
      },
    },
    JobsService: { Cancel: (...a: unknown[]) => h.cancel(...a) },
    LibraryService: { Open: (...a: unknown[]) => h.open(...a), Reveal: (...a: unknown[]) => h.reveal(...a), RevealPath: (...a: unknown[]) => h.revealPath(...a) },
    MediaService: { URLFor: async (p: string) => p },
  };
});
vi.mock("@/tools/post-builder/AddToPostDialog", () => ({ openAddToPostDialog: (...a: unknown[]) => h.addToPost(...a) }));

import { JobStatus, type EditMatteState, type EditSourceState, type Job } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import { emptyEditProject, normalizeProject, type NormalProject } from "@/viz/edit/defaults";
import { newClip } from "../doc";
import { useEditStudio } from "../store";
import { markOpened } from "../useEditAutosave";
import { ExportDialog } from "./ExportDialog";

const matte = (id: string) => ({ mode: "people", id, fromMs: 0, toMs: 3000, clicks: [], cutout: true, invert: false, feather: 0, stroke: { px: 0, color: "#ffffff" }, glow: { amount: 0, color: "#ffffff" } });

function makeProject(over: Partial<NormalProject> = {}, withMatte = false): NormalProject {
  const p = emptyEditProject("9:16", 30, 1);
  p.song = { path: "/s.mp3", startMs: 0, endMs: 30_000, gainDb: 0, fadeInMs: 0, fadeOutMs: 0 };
  p.analysisKey = "k";
  p.exportHeight = 1080;
  p.tracks = [
    {
      id: "t1",
      kind: "video",
      name: "V",
      muted: false,
      locked: false,
      clips: [
        newClip({ id: "a", kind: "video", path: "/a.mov", startMs: 0, endMs: 2000, matte: withMatte ? matte("m1") : null }),
        newClip({ id: "b", kind: "image", path: "/b.jpg", startMs: 2000, endMs: 4000 }),
      ],
    },
  ];
  return normalizeProject({ ...p, ...over });
}

const src = (path: string, over: Partial<EditSourceState> = {}): EditSourceState => ({
  path,
  info: { path, kind: "video", durationMs: 5000, width: 1, height: 1, fps: 30, rotation: 0, hasAudio: true, takenAt: 0, error: "" },
  preview: { stream: "s", index: "i", width: 1, height: 1, fps: 30, frames: 1 },
  image: "img",
  shots: null,
  preparing: false,
  error: "",
  ...over,
});

function job(over: Partial<Job> = {}): Job {
  return {
    id: "j1", moduleId: "edit-studio", title: "Exporting", status: JobStatus.JobRunning, progress: 0.4, message: "Rendering frames", inputs: [], optionsJson: "", errorCode: "" as Job["errorCode"],
    error: "", errorHint: "", attempt: 1, cancelRequested: false, createdAt: 1, startedAt: 1, finishedAt: 0, outputs: [], resultJson: "", pipelineRunId: "", pipelineStepId: "", ...over,
  };
}

function open(p: NormalProject, sources: EditSourceState[], mattes: EditMatteState[] = []) {
  useEditStudio.getState().open("p1", "My edit", p);
  markOpened("p1", "My edit", useEditStudio.getState().history!.present);
  h.sources.value = sources;
  h.mattes.value = mattes;
  useEditStudio.getState().setSources(sources);
  useEditStudio.getState().setMattes(mattes);
  const onClose = vi.fn();
  render(<ExportDialog open onClose={onClose} />);
  return onClose;
}

beforeEach(() => {
  for (const f of [h.render, h.matte, h.save, h.cancel, h.open, h.reveal, h.revealPath, h.addToPost]) f.mockReset();
  h.render.mockResolvedValue(job({ status: JobStatus.JobQueued, progress: 0 }));
  h.save.mockResolvedValue({ id: "p1", name: "My edit" });
  h.cancel.mockResolvedValue(undefined);
  useEditStudio.getState().close();
  useEditStudio.setState({ sources: {}, mattes: {}, jobs: { mattes: {}, interps: {} } });
  useJobs.setState({ byId: {}, logs: {}, logsLoaded: {} });
});

describe("ExportDialog", () => {
  it("shows size, fps and length, and exports with the chosen size", async () => {
    const user = userEvent.setup();
    const onClose = open(makeProject(), [src("/a.mov"), src("/b.jpg")]);
    expect(await screen.findByText("30 fps")).toBeTruthy();
    expect(screen.getByText(/0:30 · 900 frames/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Size"), "720");
    const exportBtn = screen.getByRole("button", { name: "Export" });
    await waitFor(() => expect((exportBtn as HTMLButtonElement).disabled).toBe(false));
    await user.click(exportBtn);
    await waitFor(() => expect(h.render).toHaveBeenCalledWith("p1"));
    // the height was written into the document and saved first
    expect(useEditStudio.getState().history!.present.exportHeight).toBe(720);
    expect(h.save).toHaveBeenCalled();
    expect(h.save.mock.invocationCallOrder[0]!).toBeLessThan(h.render.mock.invocationCallOrder[0]!);
    expect((h.save.mock.calls[0]![2] as NormalProject).exportHeight).toBe(720);
    expect(useEditStudio.getState().jobs.render).toBe("j1");
    expect(onClose).toHaveBeenCalled();
  });

  it("waits for sources that are preparing", async () => {
    open(makeProject(), [src("/a.mov", { preparing: true, preview: null }), src("/b.jpg")]);
    expect(await screen.findByText("Wait for 1 clip to finish preparing")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Export" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists missing files and blocks the export", async () => {
    open(makeProject(), [src("/a.mov", { error: "This file doesn't exist any more" }), src("/b.jpg")]);
    expect(await screen.findByText("1 file is missing")).toBeTruthy();
    expect(screen.getByText("a.mov")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Export" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("rebuilds cut-outs that aren't ready", async () => {
    const user = userEvent.setup();
    h.matte.mockResolvedValue(job({ id: "mj1" }));
    open(makeProject({}, true), [src("/a.mov"), src("/b.jpg")], []);
    expect(await screen.findByText("1 cut-out isn't ready or is out of date")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Export" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Rebuild" }));
    await waitFor(() => expect(h.matte).toHaveBeenCalledTimes(1));
    expect(h.matte.mock.calls[0]![0]).toBe("p1");
    const req = h.matte.mock.calls[0]![1] as { matteId: string };
    expect(req).toMatchObject({ clipId: "a", mode: "people", path: "/a.mov", fromMs: 0, toMs: 2000, preview: false });
    expect(req.matteId).not.toBe("m1"); // a fresh matte ID, recorded in the clip
    expect(useEditStudio.getState().history!.present.tracks[0]!.clips[0]!.matte!.id).toBe(req.matteId);
    expect(useEditStudio.getState().jobs.mattes[req.matteId]).toBe("mj1");
    expect(await screen.findByText("Rebuilding 1 cut-out…")).toBeTruthy();
  });

  it("removes the cut-out from those clips as one undo step", async () => {
    const user = userEvent.setup();
    open(makeProject({}, true), [src("/a.mov"), src("/b.jpg")], []);
    await user.click(await screen.findByRole("button", { name: "Remove the cut-out from those clips" }));
    const st = useEditStudio.getState();
    expect(st.history!.present.tracks[0]!.clips[0]!.matte).toBeNull();
    expect(st.history!.past.length).toBe(1);
    await waitFor(() => expect((screen.getByRole("button", { name: "Export" }) as HTMLButtonElement).disabled).toBe(false));
    st.undo();
    expect(useEditStudio.getState().history!.present.tracks[0]!.clips[0]!.matte).not.toBeNull();
  });

  it("allows the export when the cut-out is ready", async () => {
    open(makeProject({}, true), [src("/a.mov"), src("/b.jpg")], [{ id: "m1", ready: true, fromMs: 0, toMs: 3000, preview: null, export: null, image: "" }]);
    await waitFor(() => expect((screen.getByRole("button", { name: "Export" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("shows a failed submit", async () => {
    const user = userEvent.setup();
    h.render.mockRejectedValue({ message: "The song's analysis isn't cached any more" });
    open(makeProject(), [src("/a.mov"), src("/b.jpg")]);
    const btn = await screen.findByRole("button", { name: "Export" });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    await user.click(btn);
    expect(await screen.findAllByText(/analysis isn't cached/)).toBeTruthy();
  });
});

describe("ExportBanner", () => {
  function showBanner(j: Job) {
    useEditStudio.getState().open("p1", "My edit", makeProject());
    useEditStudio.getState().setJob("render", j.id);
    useJobs.getState().upsert(j);
    render(<ExportDialog open={false} onClose={() => undefined} />);
  }

  it("shows progress and cancels", async () => {
    const user = userEvent.setup();
    showBanner(job());
    expect(screen.getByText("Rendering frames")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(h.cancel).toHaveBeenCalledWith("j1");
  });

  it("offers Open, Reveal and Add to post when done", async () => {
    const user = userEvent.setup();
    const out = { id: "o1", jobId: "j1", path: "/lib/Edits/My edit.mp4", missing: false } as unknown as Job["outputs"] extends (infer O)[] | null ? O : never;
    showBanner(job({ status: JobStatus.JobDone, progress: 1, outputs: [out], resultJson: JSON.stringify({ action: "render", outputs: ["/lib/Edits/My edit.mp4"], encoder: "h264-hw", speed: 3.2 }) }));
    expect(screen.getByText("Exported My edit.mp4")).toBeTruthy();
    expect(screen.getByText("Rendered ×3.2 real time")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(h.open).toHaveBeenCalledWith("o1");
    await user.click(screen.getByRole("button", { name: /Show in Explorer|Reveal in Finder/ }));
    expect(h.reveal).toHaveBeenCalledWith("o1");
    await user.click(screen.getByRole("button", { name: "Add to post…" }));
    expect(h.addToPost).toHaveBeenCalledWith("/lib/Edits/My edit.mp4");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(useEditStudio.getState().jobs.render).toBeUndefined();
  });

  it("shows a failure with its hint", () => {
    showBanner(job({ status: JobStatus.JobFailed, error: "The renderer failed", errorHint: "Try a smaller size" }));
    expect(screen.getByText("The renderer failed")).toBeTruthy();
    expect(screen.getByText("Try a smaller size")).toBeTruthy();
  });
});
