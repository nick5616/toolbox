import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  width: 1000,
  handlers: [] as Array<(ev: unknown) => void>,
  enqueue: vi.fn(),
  saveBatch: vi.fn(),
  batch: vi.fn(),
  batches: vi.fn(),
  deleteBatch: vi.fn(),
  exportText: vi.fn(),
  status: vi.fn(),
  copy: vi.fn(),
  install: vi.fn(),
  cancel: vi.fn(),
  stat: vi.fn(),
  reveal: vi.fn(),
}));

vi.mock("@/lib/events", () => ({
  on: (_name: string, cb: (ev: unknown) => void) => {
    h.handlers.push(cb);
    return () => {
      h.handlers = h.handlers.filter((x) => x !== cb);
    };
  },
}));
vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: h.width, height: 0 }) }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    CaptionService: {
      Defaults: async () => ({ ...(await import("./options")).DEFAULT_CAPTION_OPTIONS }),
      Fields: async () => null,
      Enqueue: (...a: unknown[]) => h.enqueue(...a),
      SaveBatch: (...a: unknown[]) => h.saveBatch(...a),
      Batch: (...a: unknown[]) => h.batch(...a),
      Batches: () => h.batches(),
      DeleteBatch: (...a: unknown[]) => h.deleteBatch(...a),
      ExportText: (...a: unknown[]) => h.exportText(...a),
      Status: () => h.status(),
    },
    FilesService: {
      Pick: async () => ["C:/p/a.jpg", "C:/p/b.mp4"],
      Stat: (p: string[]) => h.stat(p),
      ImageThumb: async () => "data:image/png;base64,AAAA",
      SaveText: async () => "C:/out/x.csv",
    },
    ClipboardService: { CopyText: (t: string) => h.copy(t) },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
    LibraryService: { Detail: async () => ({ output: { id: "o1" } }), RevealPath: (p: string) => h.reveal(p), Reveal: async () => undefined, Open: async () => undefined, SaveCopy: async () => "" },
    JobsService: { Cancel: (id: string) => h.cancel(id) },
    PacksService: { Install: (...a: unknown[]) => h.install(...a), Relaunch: async () => undefined, InstallFor: async () => ({}) },
  };
});

import { ClickInHost } from "@/components";
import {
  CaptionAction,
  CaptionField,
  CaptionLength,
  CaptionNamePattern,
  CaptionPreset,
  CaptionTone,
  JobStatus,
  ModuleStatus,
  type CaptionBatch,
  type CaptionItem,
  type CaptionStatus,
  type Descriptor,
  type Job,
} from "@/lib/api";
import { EmbedContext, type EmbedContextValue } from "@/lib/embed";
import { useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { usePacks } from "@/state/packs";
import { useFileInputsStore } from "@/tools/_kit/fileInputsStore";
import CaptionsView from "./CaptionsView";
import {
  DEFAULT_CAPTION_OPTIONS,
  advancedSummary,
  countChars,
  encodeUse,
  isVideoPath,
  normItem,
  sanitizeCaptionOptions,
  toHashtag,
  USE_PREFIX,
} from "./options";
import { SAVE_DEBOUNCE_MS } from "./useBatch";
import { previewName } from "./Dialogs";
import { batchCsv, captionLine } from "./BatchBar";
import { normBatch } from "./options";

const OK_STATUS: CaptionStatus = { model: "qwen", modelLabel: "Qwen3.5 4B", problem: "", exifTool: true, ffmpeg: true, searchHints: true };

function desc(): Descriptor {
  return {
    id: "captions",
    name: "Caption Writer",
    tagline: "Alt text, captions, keywords and names for your photos and videos",
    description: "",
    icon: "message-square-quote",
    status: ModuleStatus.StatusReady,
    accepts: { extensions: [".jpg", ".png", ".mp4"], urls: false },
    requires: [],
    recommends: null,
    maxInputs: 200,
  } as unknown as Descriptor;
}

function item(input: string, over: Partial<CaptionItem> = {}, fields: Partial<CaptionItem["fields"]> = {}): CaptionItem {
  return {
    input,
    note: "",
    fields: { alt: "A tram on a hill", description: "", caption: "Golden hour in Lisbon", hashtags: ["#lisbon", "#tram"], title: "", keywords: [], name: "", ...fields },
    edited: null,
    state: "done",
    reason: "",
    seed: 1,
    ...over,
  };
}

function batchFile(items: CaptionItem[], over: Partial<CaptionBatch> = {}): CaptionBatch {
  return { version: 1, name: "Lisbon trip", dir: "C:/lib/Captions/Lisbon trip 2026-11-18", created: Date.now(), model: "qwen", options: { ...DEFAULT_CAPTION_OPTIONS }, items, ...over };
}

function job(id: string, status: JobStatus, over: Partial<Job> = {}): Job {
  return { id, moduleId: "captions", status, title: "Captions", inputs: [], outputs: [], progress: 0, ...over } as unknown as Job;
}

const emit = (ev: unknown) => act(() => h.handlers.slice().forEach((cb) => cb(ev)));

function renderView(embed?: Partial<EmbedContextValue>) {
  const view = (
    <ClickInHost>
      <CaptionsView moduleId="captions" />
    </ClickInHost>
  );
  if (!embed) return render(view);
  const ctx: EmbedContextValue = { host: "post-builder", hostName: "Post Builder", placement: "drawer", handoff: { moduleId: "captions", inputs: [] }, useLabel: "Use caption", ...embed };
  return render(<EmbedContext.Provider value={ctx}>{view}</EmbedContext.Provider>);
}

async function openPast(dir: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /Past batches/ }));
  await user.click(await screen.findByRole("button", { name: new RegExp(`^${dir}`) }));
  return user;
}

beforeEach(() => {
  h.width = 1000;
  h.handlers = [];
  for (const k of ["enqueue", "saveBatch", "batch", "batches", "deleteBatch", "exportText", "status", "copy", "install", "cancel", "stat", "reveal"] as const) h[k].mockReset();
  h.status.mockResolvedValue(OK_STATUS);
  h.batches.mockResolvedValue([]);
  h.saveBatch.mockResolvedValue(undefined);
  h.copy.mockResolvedValue(undefined);
  h.stat.mockImplementation(async (p: string[]) => p.map((path) => ({ path, name: path, sizeBytes: 10, exists: true, isDir: false, kind: "image" })));
  useJobs.setState({ byId: {} });
  useFileInputsStore.setState({ lists: {} });
  useModules.setState({ byId: { captions: desc() }, list: [desc()] } as never);
  usePacks.setState({ list: [], byId: {}, loaded: true } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("options", () => {
  it("summarises the advanced settings on one line", () => {
    expect(advancedSummary({ ...DEFAULT_CAPTION_OPTIONS, language: "English" })).toBe("Warm · medium · English · 5 hashtags");
    expect(advancedSummary({ ...DEFAULT_CAPTION_OPTIONS, hashtags: 0, emoji: true })).toBe("Warm · medium · Auto language · no hashtags · emoji");
  });

  it("sanitises remembered options and never remembers the context", () => {
    const out = sanitizeCaptionOptions({ preset: "rename", tone: "loud", hashtags: 99, language: "Klingon", context: "old", kebab: true }, DEFAULT_CAPTION_OPTIONS);
    expect(out).toMatchObject({ preset: "rename", tone: "warm", hashtags: 15, language: "", context: "", kebab: true });
    expect(sanitizeCaptionOptions("nope", DEFAULT_CAPTION_OPTIONS)).toEqual(DEFAULT_CAPTION_OPTIONS);
  });

  it("makes hashtags, counts characters and spots videos", () => {
    expect(toHashtag(" #Sun set!")).toBe("#Sunset");
    expect(toHashtag("##")).toBe("");
    expect(countChars("a😀b")).toBe(3);
    expect(isVideoPath("C:/x/Clip.MP4")).toBe(true);
    expect(isVideoPath("C:/x/a.jpg")).toBe(false);
    expect(encodeUse({ input: "a", caption: "c", hashtags: ["#x"], alt: "z" })).toBe(`${USE_PREFIX}{"input":"a","caption":"c","hashtags":["#x"],"alt":"z"}`);
  });

  it("previews renamed copies and builds text for Copy all", () => {
    const it = normItem(item("C:/p/IMG_1.JPG", {}, { name: "tram-at-dusk" }));
    expect(previewName(it, 0, CaptionNamePattern.NameOnly)).toBe("tram-at-dusk.jpg");
    expect(previewName(it, 2, CaptionNamePattern.NameNumber)).toBe("03 tram-at-dusk.jpg");
    const b = normBatch(batchFile([item("C:/p/a.jpg")]));
    expect(captionLine(b.items[0]!)).toBe("Golden hour in Lisbon\n\n#lisbon #tram");
    expect(batchCsv(b).split("\n")[0]).toBe("file,alt,description,caption,hashtags,title,keywords,name");
  });
});

describe("Caption Writer: writing a batch", () => {
  it("fills the cards as each file finishes, then keeps what arrived", async () => {
    h.enqueue.mockResolvedValue([job("j1", JobStatus.JobRunning)]);
    const user = userEvent.setup();
    renderView();
    await user.click((await screen.findAllByRole("button", { name: /add files/i }))[0]!);
    await screen.findByLabelText("Input files");
    await user.click(screen.getByRole("button", { name: /Write captions for 2 files/ }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalled());
    const [paths, opts] = h.enqueue.mock.calls[0] as [string[], Record<string, unknown>];
    expect(paths).toEqual(["C:/p/a.jpg", "C:/p/b.mp4"]);
    expect(opts).toMatchObject({ action: CaptionAction.ActionCaption, preset: CaptionPreset.PresetPosting });

    // Two skeletons first.
    expect(await screen.findAllByRole("status", { name: /Writing for/ })).toHaveLength(2);

    const dir = "C:/lib/Captions/x 2026-11-18";
    await emit({ jobId: "j1", dir, index: 0, item: item("C:/p/a.jpg") });
    const card = await screen.findByRole("article", { name: "a.jpg" });
    expect((within(card).getByLabelText("Caption") as HTMLTextAreaElement).value).toBe("Golden hour in Lisbon");
    expect(within(card).getByText("#lisbon")).toBeTruthy();
    // The second is still waiting.
    expect(screen.getAllByRole("status", { name: /Writing for/ })).toHaveLength(1);

    // An event for another job is ignored.
    await emit({ jobId: "other", dir: "C:/elsewhere", index: 1, item: item("C:/p/b.mp4") });
    expect(screen.getAllByRole("status", { name: /Writing for/ })).toHaveLength(1);

    await emit({ jobId: "j1", dir, index: 1, item: item("C:/p/b.mp4", { state: "failed", reason: "Couldn't read the video" }) });
    expect(await screen.findByText("Couldn't read the video")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("keeps the cards that are done when the batch is cancelled", async () => {
    h.enqueue.mockResolvedValue([job("j1", JobStatus.JobRunning)]);
    h.batch.mockResolvedValue(batchFile([item("C:/p/a.jpg")], { dir: "C:/lib/Captions/x" }));
    const user = userEvent.setup();
    renderView();
    await user.click((await screen.findAllByRole("button", { name: /add files/i }))[0]!);
    await user.click(await screen.findByRole("button", { name: /Write captions for 2 files/ }));
    await screen.findAllByRole("status", { name: /Writing for/ });
    await emit({ jobId: "j1", dir: "C:/lib/Captions/x", index: 0, item: item("C:/p/a.jpg") });
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(h.cancel).toHaveBeenCalledWith("j1");
    act(() => useJobs.setState({ byId: { j1: job("j1", JobStatus.JobCancelled) as never } }));
    await waitFor(() => expect(screen.queryAllByRole("status", { name: /Writing for/ })).toHaveLength(0));
    expect(screen.getByRole("article", { name: "a.jpg" })).toBeTruthy();
    expect(screen.queryByRole("article", { name: "b.mp4" })).toBeNull();
  });
});

describe("Caption Writer: editing", () => {
  async function openBatch(items: CaptionItem[] = [item("C:/p/a.jpg"), item("C:/p/b.jpg")]) {
    const b = batchFile(items);
    h.batches.mockResolvedValue([{ dir: b.dir, name: b.name, created: b.created, count: items.length, failed: 0, cover: items[0]?.input ?? "" }]);
    h.batch.mockResolvedValue(b);
    renderView();
    const user = await openPast("Lisbon trip");
    await screen.findByRole("article", { name: "a.jpg" });
    return { user, b };
  }

  it("marks edited fields and saves once, a second after the last keystroke", async () => {
    await openBatch();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const card = screen.getByRole("article", { name: "a.jpg" });
    const caption = within(card).getByLabelText("Caption");
    fireEvent.change(caption, { target: { value: "Golden hour" } });
    fireEvent.change(caption, { target: { value: "Golden hour in Alfama" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(h.saveBatch).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 50);
    });
    expect(h.saveBatch).toHaveBeenCalledTimes(1);
    const saved = h.saveBatch.mock.calls[0]![0] as CaptionBatch;
    expect(saved.items?.[0]?.fields.caption).toBe("Golden hour in Alfama");
    expect(saved.items?.[0]?.edited).toEqual({ [CaptionField.FieldCaption]: true });
    expect(saved.items?.[1]?.edited ?? {}).toEqual({});
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(within(card).getByText("edited")).toBeTruthy();
  });

  it("counts alt text characters and warns above 125", async () => {
    await openBatch();
    const card = screen.getByRole("article", { name: "a.jpg" });
    const counter = within(card).getByTestId("alt-count");
    expect(counter.textContent).toBe("16 / 125");
    expect(counter.className).not.toMatch(/over/);
    fireEvent.change(within(card).getByLabelText("Alt text"), { target: { value: "x".repeat(118) } });
    expect(within(card).getByTestId("alt-count").textContent).toBe("118 / 125");
    fireEvent.change(within(card).getByLabelText("Alt text"), { target: { value: "x".repeat(126) } });
    expect(within(card).getByTestId("alt-count").className).toMatch(/over/);
  });

  it("adds and removes hashtag chips", async () => {
    const { user } = await openBatch();
    const card = screen.getByRole("article", { name: "a.jpg" });
    await user.click(within(card).getByRole("button", { name: "Remove #tram" }));
    expect(within(card).queryByText("#tram")).toBeNull();
    await user.type(within(card).getByLabelText("Add hashtag"), "sunset{Enter}");
    expect(within(card).getByText("#sunset")).toBeTruthy();
    await waitFor(() => expect(h.saveBatch).toHaveBeenCalled(), { timeout: 3000 });
    const saved = h.saveBatch.mock.calls.at(-1)![0] as CaptionBatch;
    expect(saved.items?.[0]?.fields.hashtags).toEqual(["#lisbon", "#sunset"]);
    expect(saved.items?.[0]?.edited?.[CaptionField.FieldHashtags]).toBe(true);
  });

  it("copies a field", async () => {
    const { user } = await openBatch();
    const card = screen.getByRole("article", { name: "a.jpg" });
    await user.click(within(card).getByRole("button", { name: "Copy caption" }));
    expect(h.copy).toHaveBeenCalledWith("Golden hour in Lisbon");
  });

  it("regenerates one file keeping edits, or every field", async () => {
    const { user, b } = await openBatch();
    h.enqueue.mockResolvedValue([job("r1", JobStatus.JobRunning)]);
    h.batch.mockResolvedValue(b);
    const card = screen.getByRole("article", { name: "b.jpg" });
    await user.click(within(card).getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(1));
    const [inputs, opts] = h.enqueue.mock.calls[0] as [string[], Record<string, unknown>];
    expect(inputs).toEqual([]);
    expect(opts).toMatchObject({ action: CaptionAction.ActionRegenerate, batch: b.dir, index: 1, keepEdited: true });
    // The new text arrives as an event and the busy state ends with the job.
    await emit({ jobId: "r1", dir: b.dir, index: 1, item: item("C:/p/b.jpg", {}, { caption: "A new caption" }) });
    expect((within(card).getByLabelText("Caption") as HTMLTextAreaElement).value).toBe("A new caption");
    act(() => useJobs.setState({ byId: { r1: job("r1", JobStatus.JobDone) as never } }));
    await waitFor(() => expect(within(card).getByRole("button", { name: "Regenerate" }).getAttribute("aria-busy")).not.toBe("true"));

    h.enqueue.mockResolvedValue([job("r2", JobStatus.JobRunning)]);
    await user.click(within(card).getByRole("button", { name: "Regenerate all fields" }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalledTimes(2));
    expect(h.enqueue.mock.calls[1]![1]).toMatchObject({ action: CaptionAction.ActionRegenerate, index: 1, keepEdited: false });
  });

  it("keeps a note for the file and passes it to Regenerate", async () => {
    const { user } = await openBatch();
    h.enqueue.mockResolvedValue([job("r1", JobStatus.JobRunning)]);
    const card = screen.getByRole("article", { name: "a.jpg" });
    await user.click(within(card).getByRole("button", { name: "Note for this file…" }));
    fireEvent.change(within(card).getByLabelText("Note for this file"), { target: { value: "That's Max" } });
    await user.click(within(card).getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalled());
    expect((h.enqueue.mock.calls[0]![1] as { notes: Record<string, string> }).notes).toEqual({ "C:/p/a.jpg": "That's Max" });
    // The edit was written before the job started, so the job sees it.
    expect(h.saveBatch).toHaveBeenCalled();
    expect((h.saveBatch.mock.calls[0]![0] as CaptionBatch).items?.[0]?.note).toBe("That's Max");
  });
});

describe("Caption Writer: batch bar", () => {
  async function openBatch() {
    const b = batchFile([item("C:/p/a.jpg", {}, { name: "tram-at-dusk", title: "Tram" }), item("C:/p/b.mp4", {}, { name: "harbour" })]);
    h.batches.mockResolvedValue([{ dir: b.dir, name: b.name, created: b.created, count: 2, failed: 0, cover: "C:/p/a.jpg" }]);
    h.batch.mockResolvedValue(b);
    renderView();
    const user = await openPast("Lisbon trip");
    await screen.findByRole("article", { name: "a.jpg" });
    return { user, b };
  }

  it("shows the folder and the saved files with Reveal, Open and Save a copy", async () => {
    const { b } = await openBatch();
    const bar = screen.getByRole("toolbar", { name: "Batch" });
    expect(within(bar).getByText("Lisbon trip 2026-11-18")).toBeTruthy();
    expect(screen.getByRole("group", { name: "captions.csv" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "captions.json" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Save a copy…" }).length).toBeGreaterThan(0);
    expect(b.dir).toContain("Captions");
  });

  it("copies every caption", async () => {
    const { user } = await openBatch();
    await user.click(screen.getByRole("button", { name: /Copy all/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Captions" }));
    expect(h.copy).toHaveBeenCalledWith("Golden hour in Lisbon\n\n#lisbon #tram\n\nGolden hour in Lisbon\n\n#lisbon #tram");
  });

  it("exports Markdown", async () => {
    const { user, b } = await openBatch();
    h.exportText.mockResolvedValue(["C:/lib/Captions/x/captions.md"]);
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(await screen.findByRole("menuitem", { name: "One Markdown file" }));
    expect(h.exportText).toHaveBeenCalledWith(b.dir, "md");
  });

  it("writes into copies with the chosen fields", async () => {
    const { user, b } = await openBatch();
    h.enqueue.mockResolvedValue([job("w1", JobStatus.JobRunning, { title: "Write into copies" })]);
    await user.click(screen.getByRole("button", { name: "Write into copies…" }));
    const dlg = await screen.findByRole("dialog");
    await user.click(within(dlg).getByRole("switch", { name: "Title" }));
    await user.click(within(dlg).getByRole("switch", { name: "Keep location data" }));
    await user.click(within(dlg).getByRole("button", { name: "Write copies" }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalled());
    const [inputs, opts] = h.enqueue.mock.calls[0] as [string[], { action: string; batch: string; write: Record<string, unknown> }];
    expect(inputs).toEqual([]);
    expect(opts).toMatchObject({ action: CaptionAction.ActionWrite, batch: b.dir });
    expect(opts.write).toMatchObject({ alt: true, title: false, keywords: true, keepLocation: true, captionFrom: CaptionField.FieldCaption });
    // The job's result shows as rows with the usual actions.
    act(() =>
      useJobs.setState({
        byId: { w1: job("w1", JobStatus.JobDone, { title: "Write into copies", outputs: [{ id: "o9", path: "C:/lib/Captions/x/With captions/a.jpg", name: "a.jpg", missing: false, sizeBytes: 5, createdAt: 1 }] as never }) as never },
      }),
    );
    expect(await screen.findByRole("group", { name: "a.jpg" })).toBeTruthy();
  });

  it("previews renames before and after, then makes the copies", async () => {
    const { user, b } = await openBatch();
    h.enqueue.mockResolvedValue([job("n1", JobStatus.JobRunning)]);
    await user.click(screen.getByRole("button", { name: "Rename copies…" }));
    const dlg = await screen.findByRole("dialog");
    const list = within(dlg).getByRole("list", { name: "Renames" });
    expect(within(list).getByText("tram-at-dusk.jpg")).toBeTruthy();
    expect(within(list).getByText("harbour.mp4")).toBeTruthy();
    await user.click(within(dlg).getByRole("button", { name: /Make 2 renamed copies/ }));
    await waitFor(() => expect(h.enqueue).toHaveBeenCalled());
    expect(h.enqueue.mock.calls[0]![1]).toMatchObject({ action: CaptionAction.ActionRename, batch: b.dir });
  });

  it("moves Export into More… when the bar is narrow", async () => {
    h.width = 600;
    const { user } = await openBatch();
    expect(screen.queryByRole("button", { name: /^Export/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /More…/ }));
    expect(await screen.findByRole("menuitem", { name: "One Markdown file" })).toBeTruthy();
  });
});

describe("Caption Writer: past batches", () => {
  it("lists batches, opens one for editing and deletes one after confirming", async () => {
    const b = batchFile([item("C:/p/a.jpg")]);
    const info = { dir: b.dir, name: b.name, created: b.created, count: 1, failed: 0, cover: "C:/p/a.jpg" };
    h.batches.mockResolvedValue([info]);
    h.batch.mockResolvedValue(b);
    h.deleteBatch.mockResolvedValue(undefined);
    renderView();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Past batches/ }));
    const list = await screen.findByRole("list", { name: "Past batches" });
    expect(within(list).getByText("Lisbon trip")).toBeTruthy();

    await user.click(within(list).getByRole("button", { name: /^Lisbon trip/ }));
    expect(h.batch).toHaveBeenCalledWith(b.dir);
    expect(await screen.findByRole("article", { name: "a.jpg" })).toBeTruthy();

    await user.click(await screen.findByRole("button", { name: /Past batches/ }));
    await user.click(await screen.findByRole("button", { name: "Delete Lisbon trip" }));
    expect(h.deleteBatch).not.toHaveBeenCalled();
    h.batches.mockResolvedValue([]);
    await user.click(await screen.findByRole("button", { name: "Move to trash" }));
    expect(h.deleteBatch).toHaveBeenCalledWith(b.dir);
    // The open batch was the deleted one: its cards are gone.
    await waitFor(() => expect(screen.queryByRole("article", { name: "a.jpg" })).toBeNull());
  });
});

describe("Caption Writer: the gate and disabled reasons", () => {
  async function addAndPick() {
    const user = userEvent.setup();
    renderView();
    await user.click((await screen.findAllByRole("button", { name: /add files/i }))[0]!);
    await screen.findByLabelText("Input files");
    return user;
  }

  it("shows the pack button when no model can read pictures, and blocks the run", async () => {
    h.status.mockResolvedValue({ ...OK_STATUS, model: "", modelLabel: "", problem: "No model that can read pictures is installed" });
    h.install.mockResolvedValue({ jobs: [], restart: false });
    usePacks.setState({ byId: { captions: { id: "captions", name: "Caption Writer" } }, list: [{ id: "captions", name: "Caption Writer" }] } as never);
    const user = await addAndPick();
    expect(await screen.findByText("No model that can read pictures is installed")).toBeTruthy();
    const run = screen.getByRole("button", { name: /Write captions for 2 files/ });
    expect(run.getAttribute("aria-disabled")).toBe("true");
    await user.click(screen.getByRole("button", { name: /Install the Caption Writer pack/ }));
    expect(h.install).toHaveBeenCalledWith(["captions"], "");
  });

  it("refuses videos without FFmpeg and says why", async () => {
    h.status.mockResolvedValue({ ...OK_STATUS, ffmpeg: false });
    await addAndPick();
    await waitFor(() => expect(screen.getByRole("button", { name: /Write captions for 2 files/ }).getAttribute("aria-disabled")).toBe("true"));
    expect(screen.getByText(/Videos need FFmpeg/)).toBeTruthy();
  });

  it("disables Write into copies without ExifTool", async () => {
    h.status.mockResolvedValue({ ...OK_STATUS, exifTool: false });
    const b = batchFile([item("C:/p/a.jpg")]);
    h.batches.mockResolvedValue([{ dir: b.dir, name: b.name, created: 1, count: 1, failed: 0, cover: "" }]);
    h.batch.mockResolvedValue(b);
    renderView();
    await openPast("Lisbon trip");
    await screen.findByRole("article", { name: "a.jpg" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Write into copies…" }).getAttribute("aria-disabled")).toBe("true"));
  });

  it("explains a disabled Smart search hints switch", async () => {
    h.status.mockResolvedValue({ ...OK_STATUS, searchHints: false });
    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByRole("button", { name: /Advanced/ }));
    const sw = await screen.findByRole("switch", { name: "Use Smart search hints" });
    expect((sw as HTMLButtonElement).disabled).toBe(true);
    expect(sw.closest("label")?.getAttribute("data-tip")).toMatch(/isn't installed/);
  });
});

describe("Caption Writer: embedded", () => {
  it("offers Use on each card and for the first file, returning caption, hashtags and alt", async () => {
    const onUse = vi.fn();
    const b = batchFile([item("C:/p/a.jpg"), item("C:/p/b.jpg", {}, { caption: "Second" })]);
    h.batches.mockResolvedValue([{ dir: b.dir, name: b.name, created: 1, count: 2, failed: 0, cover: "" }]);
    h.batch.mockResolvedValue(b);
    renderView({ onUse });
    const user = await openPast("Lisbon trip");
    const card = await screen.findByRole("article", { name: "b.jpg" });
    await user.click(within(card).getByRole("button", { name: "Use caption" }));
    expect(onUse).toHaveBeenCalledWith([encodeUse({ input: "C:/p/b.jpg", caption: "Second", hashtags: ["#lisbon", "#tram"], alt: "A tram on a hill" })]);
    await user.click(screen.getByRole("button", { name: /Use caption \(first\)/ }));
    expect(onUse).toHaveBeenLastCalledWith([encodeUse({ input: "C:/p/a.jpg", caption: "Golden hour in Lisbon", hashtags: ["#lisbon", "#tram"], alt: "A tram on a hill" })]);
  });

  it("takes the host's text as the context and its action as the preset", async () => {
    renderView({ handoff: { moduleId: "captions", inputs: [], action: "posting", text: { title: "Context", body: "Beach day. The dog is Max." } } });
    const box = (await screen.findByLabelText("Context")) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("Beach day. The dog is Max."));
  });

  it("has no Use when nothing wants results", async () => {
    const b = batchFile([item("C:/p/a.jpg")]);
    h.batches.mockResolvedValue([{ dir: b.dir, name: b.name, created: 1, count: 1, failed: 0, cover: "" }]);
    h.batch.mockResolvedValue(b);
    renderView({});
    await openPast("Lisbon trip");
    await screen.findByRole("article", { name: "a.jpg" });
    expect(screen.queryByRole("button", { name: "Use caption" })).toBeNull();
  });
});

describe("Caption Writer: small windows", () => {
  it("renders the whole tool at 960 x 600 with the primary settings on the top level", async () => {
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener: () => undefined, removeEventListener: () => undefined }) as unknown as MediaQueryList) as typeof window.matchMedia;
    h.width = 500;
    try {
      renderView();
      expect(await screen.findByRole("radiogroup", { name: "Write" })).toBeTruthy();
      expect(screen.getByLabelText("Context")).toBeTruthy();
      // Everything else is behind one click-in with a one-line summary.
      expect(screen.getByRole("button", { name: /Advanced/ }).textContent).toMatch(/Warm · medium · Auto language · 5 hashtags/);
      expect(screen.queryByLabelText("Tone")).toBeNull();
    } finally {
      window.matchMedia = mm;
    }
  });

  it("defaults the tone and length", () => {
    expect(DEFAULT_CAPTION_OPTIONS.tone).toBe(CaptionTone.ToneWarm);
    expect(DEFAULT_CAPTION_OPTIONS.length).toBe(CaptionLength.LengthMedium);
  });
});
