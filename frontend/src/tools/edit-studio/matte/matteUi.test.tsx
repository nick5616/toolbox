import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  matte: vi.fn(),
  mattes: vi.fn(),
  models: { people: true, select: true, image: true, selectAvailable: true },
  frame: vi.fn(),
  urlFor: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    EditStudioService: {
      Matte: (...a: unknown[]) => h.matte(...a),
      Mattes: (...a: unknown[]) => h.mattes(...a),
      MatteModels: async () => h.models,
    },
    MediaService: { Frame: (...a: unknown[]) => h.frame(...a), URLFor: (...a: unknown[]) => h.urlFor(...a) },
    JobsService: { Cancel: (...a: unknown[]) => h.cancel(...a) },
  };
});

vi.mock("../useEditAutosave", () => ({ flushEdit: async () => undefined }));

import { JobStatus, type EditMatte, type EditMatteState, type Job } from "@/lib/api";
import { useJobs } from "@/state/jobs";
import { normalizeProject } from "@/viz/edit/defaults";
import { fixtureProject } from "@/viz/edit/fixture";
import { findClip, withClip } from "../doc";
import { useEditStudio } from "../store";
import { CutoutSection } from "./CutoutSection";
import { MatteDialog } from "./MatteDialog";

const baseMatte = (over: Partial<EditMatte> = {}): EditMatte => ({
  mode: "people",
  id: "m1",
  fromMs: 0,
  toMs: 0,
  clicks: [],
  cutout: true,
  invert: false,
  feather: 0,
  stroke: { px: 0, color: "#ffffff" },
  glow: { amount: 0, color: "#ffffff" },
  ...over,
});

const mstate = (over: Partial<EditMatteState> = {}): EditMatteState => ({ id: "m1", ready: true, fromMs: 500, toMs: 9500, preview: null, export: null, image: "", ...over });

function job(over: Partial<Job> & { id: string }): Job {
  return {
    moduleId: "edit-studio",
    title: "Cut-out",
    status: JobStatus.JobRunning,
    progress: 0,
    message: "",
    inputs: [],
    optionsJson: "",
    errorCode: "" as Job["errorCode"],
    error: "",
    errorHint: "",
    attempt: 1,
    cancelRequested: false,
    createdAt: 1,
    startedAt: 1,
    finishedAt: 0,
    outputs: [],
    resultJson: "",
    pipelineRunId: "",
    pipelineStepId: "",
    ...over,
  };
}

function open(matte?: EditMatte, clipId = "c1", extra?: (p: ReturnType<typeof normalizeProject>) => ReturnType<typeof normalizeProject>) {
  let p = normalizeProject(fixtureProject());
  if (matte) p = withClip(p, clipId, { matte });
  if (extra) p = extra(p);
  useEditStudio.getState().open("p1", "Edit", p);
}

const clip = (id = "c1") => findClip(useEditStudio.getState().history!.present, id)!.clip;

beforeEach(() => {
  h.matte.mockReset().mockImplementation(async () => job({ id: "j1", status: JobStatus.JobQueued }));
  h.mattes.mockReset().mockResolvedValue([]);
  h.frame.mockReset().mockResolvedValue("/media/t/frame.jpg");
  h.urlFor.mockReset().mockImplementation(async (p: string) => `/media/t/${p}`);
  h.cancel.mockReset().mockResolvedValue(undefined);
  h.models.people = h.models.select = h.models.image = h.models.selectAvailable = true;
  useJobs.getState().setAll([]);
});

afterEach(() => {
  useEditStudio.getState().close();
  vi.restoreAllMocks();
});

describe("CutoutSection", () => {
  it("renders nothing for colour and adjustment clips", () => {
    open();
    const { container } = render(<CutoutSection clipId="c4" />);
    expect(container.firstChild).toBeNull();
  });

  it("makes a people cut-out: new matte in the clip, a job with the clip's source range", async () => {
    open();
    render(<CutoutSection clipId="c1" />);
    expect(screen.getByText("No cut-out yet")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cut out people" }));
    await waitFor(() => expect(h.matte).toHaveBeenCalledTimes(1));
    const [projectId, req] = h.matte.mock.calls[0] as [string, Record<string, unknown>];
    expect(projectId).toBe("p1");
    expect(req).toMatchObject({ clipId: "c1", mode: "people", path: "/fixture/a.mp4", fromMs: 1000, toMs: 9000, clicks: [], preview: false });
    const m = clip().matte;
    expect(m).toMatchObject({ mode: "people", id: req.matteId, fromMs: 1000, toMs: 9000, cutout: true });
    expect(String(req.matteId)).toMatch(/^m[A-Za-z0-9_-]+$/);
    await waitFor(() => expect(useEditStudio.getState().jobs.mattes[String(req.matteId)]).toBe("j1"));
  });

  it("refreshes the matte's state when the job finishes", async () => {
    open();
    render(<CutoutSection clipId="c1" />);
    await userEvent.click(screen.getByRole("button", { name: "Cut out people" }));
    await waitFor(() => expect(h.matte).toHaveBeenCalled());
    const id = String(clip().matte?.id);
    act(() => useJobs.getState().upsert(job({ id: "j1", status: JobStatus.JobDone, progress: 1 })));
    await waitFor(() => expect(h.mattes).toHaveBeenCalledWith("p1", [id]));
    await waitFor(() => expect(useEditStudio.getState().jobs.mattes[id]).toBeUndefined());
  });

  it("shows progress while making and cancels the job", async () => {
    open(baseMatte());
    useEditStudio.getState().setMatteJob("m1", "j1");
    act(() => useJobs.getState().upsert(job({ id: "j1", progress: 0.42 })));
    render(<CutoutSection clipId="c1" />);
    expect(screen.getByText("Making the cut-out")).toBeTruthy();
    expect(screen.getByText("42 %")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Cut-out progress" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(h.cancel).toHaveBeenCalledWith("j1");
  });

  it("finds a running job of an edit that was reopened (not in the store's job map)", () => {
    open(baseMatte());
    act(() =>
      useJobs.getState().upsert(job({ id: "jx", progress: 0.1, optionsJson: JSON.stringify({ action: "matte", projectId: "p1", matte: { matteId: "m1", preview: false } }) })),
    );
    render(<CutoutSection clipId="c1" />);
    expect(screen.getByText("Making the cut-out")).toBeTruthy();
  });

  it("shows ready, and out of date with Rebuild keeping the clicks", async () => {
    const clicks = [{ ms: 2000, x: 0.4, y: 0.6, positive: true }];
    open(baseMatte({ mode: "select", clicks, fromMs: 1000, toMs: 9000 }));
    act(() => useEditStudio.getState().setMattes([mstate({ fromMs: 500, toMs: 9500 })]));
    const { unmount } = render(<CutoutSection clipId="c1" />);
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.queryByText("Matte out of date")).toBeNull();
    unmount();

    act(() => useEditStudio.getState().setMattes([mstate({ fromMs: 1500, toMs: 9500 })]));
    render(<CutoutSection clipId="c1" />);
    expect(screen.getByText("Matte out of date")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Rebuild" }));
    await waitFor(() => expect(h.matte).toHaveBeenCalledTimes(1));
    expect((h.matte.mock.calls[0] as [string, { mode: string; clicks: unknown[] }])[1]).toMatchObject({ mode: "select", clicks });
    expect(clip().matte?.clicks).toEqual(clicks);
    expect(clip().matte?.id).not.toBe("m1");
  });

  it("shows a failed job with its error and Retry", async () => {
    open(baseMatte());
    useEditStudio.getState().setMatteJob("m1", "j1");
    act(() => useJobs.getState().upsert(job({ id: "j1", status: JobStatus.JobFailed, error: "The people model failed", errorHint: "Try again" })));
    render(<CutoutSection clipId="c1" />);
    expect(screen.getByText("Couldn't make the cut-out")).toBeTruthy();
    expect(screen.getByText("The people model failed")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(h.matte).toHaveBeenCalledTimes(1));
  });

  it("reports a submit failure inline", async () => {
    h.matte.mockRejectedValue({ cause: JSON.stringify({ code: "dependency_missing", message: "People cut-out isn't installed", hint: "Install the Music edits tool pack in Settings" }) });
    open();
    render(<CutoutSection clipId="c1" />);
    await userEvent.click(screen.getByRole("button", { name: "Cut out people" }));
    await waitFor(() => expect(screen.getAllByText("People cut-out isn't installed").length).toBeGreaterThan(0));
    expect(screen.getByText("Install the Music edits tool pack in Settings")).toBeTruthy();
  });

  it("edits the look: cut-out, invert, feather, stroke, glow, effects target", async () => {
    open(baseMatte());
    act(() => useEditStudio.getState().setMattes([mstate({ fromMs: 0, toMs: 99_000 })]));
    render(<CutoutSection clipId="c1" />);
    await userEvent.click(screen.getByRole("switch", { name: /Invert/ }));
    expect(clip().matte?.invert).toBe(true);
    await userEvent.click(screen.getByRole("switch", { name: /Cut-out \(show only the subject\)/ }));
    expect(clip().matte?.cutout).toBe(false);
    fireEvent.change(screen.getByRole("slider", { name: "Feather" }), { target: { value: "0.5" } });
    expect(clip().matte?.feather).toBe(0.5);
    fireEvent.change(screen.getByRole("slider", { name: "Stroke width" }), { target: { value: "12" } });
    expect(clip().matte?.stroke.px).toBe(12);
    fireEvent.change(screen.getByRole("slider", { name: "Glow amount" }), { target: { value: "0.7" } });
    expect(clip().matte?.glow.amount).toBe(0.7);
    const stroke = screen.getByRole("group", { name: "Stroke colour" });
    await userEvent.click(within(stroke).getByRole("button", { name: "Black" }));
    expect(clip().matte?.stroke.color).toBe("#000000");
    await userEvent.click(within(screen.getByRole("group", { name: "Glow colour" })).getByRole("button", { name: "Black" }));
    expect(clip().matte?.glow.color).toBe("#000000");
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Effects apply to" })).getByRole("radio", { name: "Subject" }));
    expect(clip().fxTarget).toBe("subject");
  });

  it("disables Subject and Background effects without a ready matte", () => {
    open(baseMatte());
    render(<CutoutSection clipId="c1" />);
    const group = screen.getByRole("radiogroup", { name: "Effects apply to" });
    expect((within(group).getByRole("radio", { name: "Subject" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(group).getByRole("radio", { name: "Background" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/need a ready cut-out/)).toBeTruthy();
  });

  it("offers Photo for images and sends mode image", async () => {
    open();
    render(<CutoutSection clipId="c2" />);
    expect(screen.queryByRole("radiogroup", { name: "Cut-out kind" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Cut out the subject" }));
    await waitFor(() => expect(h.matte).toHaveBeenCalledTimes(1));
    expect((h.matte.mock.calls[0] as [string, Record<string, unknown>])[1]).toMatchObject({ mode: "image", path: "/fixture/photo.jpg", clipId: "c2" });
    expect(clip("c2").matte?.mode).toBe("image");
  });

  it("says which tool pack a missing model needs", async () => {
    h.models.people = false;
    open();
    render(<CutoutSection clipId="c1" />);
    await waitFor(() => expect(screen.getByText("Install the Music edits tool pack in Settings")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Cut out people" }) as HTMLButtonElement).disabled).toBe(true);
    useEditStudio.getState().close();
    h.models.image = false;
    open();
    render(<CutoutSection clipId="c2" />);
    await waitFor(() => expect(screen.getByText("Install the Image tool pack in Settings")).toBeTruthy());
  });

  it("opens the subject dialog for Select a subject", async () => {
    open();
    render(<CutoutSection clipId="c1" />);
    await userEvent.click(screen.getByRole("radio", { name: "Select a subject" }));
    await userEvent.click(screen.getByRole("button", { name: "Select a subject…" }));
    expect(screen.getByRole("dialog", { name: "Select a subject" })).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("splits a subject when the matte is ready", async () => {
    open(baseMatte({ fromMs: 1000, toMs: 9000 }));
    act(() => useEditStudio.getState().setMattes([mstate({ fromMs: 500, toMs: 9500 })]));
    render(<CutoutSection clipId="c1" />);
    await userEvent.click(screen.getByRole("button", { name: "Split subject" }));
    const p = useEditStudio.getState().history!.present;
    expect(p.tracks).toHaveLength(3);
    expect(p.tracks[1]?.clips[0]?.matte?.cutout).toBe(true);
    expect(useEditStudio.getState().history!.past).toHaveLength(1);
  });
});

describe("MatteDialog", () => {
  const rect = { left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  beforeEach(() => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect);
  });

  async function openDialog(onMake = vi.fn(), onClose = vi.fn()) {
    open();
    render(<MatteDialog clipId="c1" onClose={onClose} onMake={onMake} />);
    await waitFor(() => expect(screen.getByTestId("matte-frame").querySelector("img")).not.toBeNull());
    return { onMake, onClose, frame: screen.getByTestId("matte-frame") };
  }

  it("loads the frame at the start of the clip's source range", async () => {
    await openDialog();
    expect(h.frame).toHaveBeenCalledWith("/fixture/a.mp4", 1000, 960);
  });

  it("clicks add points (Alt-click or the toggle: not this); a dot removes its point", async () => {
    const { frame } = await openDialog();
    fireEvent.click(frame, { clientX: 100, clientY: 50 });
    fireEvent.click(frame, { clientX: 20, clientY: 10, altKey: true });
    expect(screen.getByTestId("matte-points").textContent).toContain("2 points");
    expect(screen.getByRole("button", { name: /Remove this point \(subject\)/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Remove this point \(not this\)/ })).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: "Not this" }));
    fireEvent.click(frame, { clientX: 150, clientY: 75 });
    expect(screen.getAllByRole("button", { name: /Remove this point \(not this\)/ })).toHaveLength(2);
    await userEvent.click(screen.getAllByRole("button", { name: /Remove this point \(not this\)/ })[0] as HTMLElement);
    expect(screen.getAllByRole("button", { name: /Remove this point/ })).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryAllByRole("button", { name: /Remove this point/ })).toHaveLength(0);
  });

  it("needs a point before Try or Make, and shows the estimate", async () => {
    const { frame } = await openDialog();
    expect((screen.getByRole("button", { name: "Make cut-out" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Try on this frame" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Click the subject to begin.")).toBeTruthy();
    fireEvent.click(frame, { clientX: 100, clientY: 50 });
    expect((screen.getByRole("button", { name: "Make cut-out" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/takes (under a minute|about \d+ minutes?) on this computer/)).toBeTruthy();
    expect(screen.getByText(/about \d+ minutes/)).toBeTruthy(); // 8 s of source at 30 fps ≈ 5 minutes
  });

  it("Try runs a preview job on the clicked frame and overlays the mask", async () => {
    const { frame } = await openDialog();
    fireEvent.click(frame, { clientX: 100, clientY: 50 });
    await userEvent.click(screen.getByRole("button", { name: "Try on this frame" }));
    await waitFor(() => expect(h.matte).toHaveBeenCalledTimes(1));
    const req = (h.matte.mock.calls[0] as [string, Record<string, unknown>])[1];
    expect(req).toMatchObject({ clipId: "c1", mode: "select", preview: true, fromMs: 1000, toMs: 9000, path: "/fixture/a.mp4" });
    expect(req.clicks).toEqual([{ ms: 1000, x: 0.5, y: 0.5, positive: true }]);
    expect(String(req.matteId)).toMatch(/^m/);
    act(() => useJobs.getState().upsert(job({ id: "j1", status: JobStatus.JobDone, progress: 1, resultJson: JSON.stringify({ action: "matte", tryPath: "/proj/mattes/m-try.png" }) })));
    const overlay = await screen.findByAltText("Selection preview");
    expect(overlay.getAttribute("src")).toBe("/media/t//proj/mattes/m-try.png");
    // a new point makes the preview stale: the overlay goes away
    fireEvent.click(frame, { clientX: 10, clientY: 10 });
    expect(screen.queryByAltText("Selection preview")).toBeNull();
  });

  it("shows a failed try", async () => {
    const { frame } = await openDialog();
    fireEvent.click(frame, { clientX: 100, clientY: 50 });
    await userEvent.click(screen.getByRole("button", { name: "Try on this frame" }));
    await waitFor(() => expect(h.matte).toHaveBeenCalled());
    act(() => useJobs.getState().upsert(job({ id: "j1", status: JobStatus.JobFailed, error: "Subject select isn't available on this computer" })));
    expect(await screen.findByText("Subject select isn't available on this computer")).toBeTruthy();
  });

  it("Make hands the points to the caller and closes", async () => {
    const { frame, onMake, onClose } = await openDialog();
    fireEvent.click(frame, { clientX: 100, clientY: 50 });
    fireEvent.click(frame, { clientX: 40, clientY: 20, altKey: true });
    await userEvent.click(screen.getByRole("button", { name: "Make cut-out" }));
    expect(onMake).toHaveBeenCalledWith([
      { ms: 1000, x: 0.5, y: 0.5, positive: true },
      { ms: 1000, x: 0.2, y: 0.2, positive: false },
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it("scrubbing moves the frame; points on other frames are counted, and a rebuild keeps them", async () => {
    open(baseMatte({ mode: "select", clicks: [{ ms: 2000, x: 0.3, y: 0.3, positive: true }], fromMs: 1000, toMs: 9000 }));
    render(<MatteDialog clipId="c1" onClose={vi.fn()} onMake={vi.fn()} />);
    await waitFor(() => expect(h.frame).toHaveBeenCalledWith("/fixture/a.mp4", 2000, 960));
    expect(screen.getByRole("button", { name: "Rebuild cut-out" })).toBeTruthy();
    fireEvent.change(screen.getByRole("slider", { name: "Frame" }), { target: { value: "5000" } });
    await waitFor(() => expect(h.frame).toHaveBeenCalledWith("/fixture/a.mp4", 5000, 960));
    expect(screen.getByTestId("matte-points").textContent).toContain("1 point, 1 on other frames");
    expect(screen.queryAllByRole("button", { name: /Remove this point/ })).toHaveLength(0);
  });

  it("warns when the model is missing or the clip is longer than 60 s", async () => {
    h.models.select = false;
    open();
    const first = render(<MatteDialog clipId="c1" onClose={vi.fn()} onMake={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Install the Music edits tool pack in Settings")).toBeTruthy());
    first.unmount();
    useEditStudio.getState().close();
    h.models.select = true;
    open(undefined, "c1", (p) => withClip(p, "c1", { startMs: 0, endMs: 70_000 }));
    render(<MatteDialog clipId="c1" onClose={vi.fn()} onMake={vi.fn()} />);
    expect(await screen.findByText(/up to 60 seconds/)).toBeTruthy();
  });
});
