/**
 * The Subtitles workspace's store (Phase 11, SPEC §5.3): everything the old
 * four-step view kept in component state, lifted so panels (inline, in a
 * drawer, or popped out) and the preview read and change one document.
 *
 * - Bridged values (`bridgedValues`) are JSON-serialisable and mirrored into
 *   part windows; the actions listed in `BRIDGED_ACTIONS` run on the host, so
 *   a replica never submits a job, saves or opens a file itself and every
 *   argument is serialisable (no callbacks: cue edits are `patchCue`,
 *   `shift`, `replaceAll`, not "apply this function").
 * - Not bridged (loaded locally per window): the static lists (languages,
 *   styles, fonts) and the translator status.
 * - Things only the main window does (loading and saving the prefs, following
 *   jobs, opening the media) are hooks in `host.ts`.
 */
import { create } from "zustand";
import { toast } from "@/components";
import {
  FilesService,
  JobsService,
  LyricVideoService,
  SettingsService,
  SubtitlesAction,
  SubtitlesService,
  type Language,
  type SubtitleLanguage,
  type SubtitleStyleInfo,
  type SubtitlesOptions,
  type TranslatorStatus,
  type VisualsSpec,
} from "@/lib/api";
import { loadSpeechLanguages } from "@/blocks/speech";
import { toAppError, type AppErrorShape } from "@/lib/errors";
import { openTool } from "@/lib/openTool";
import { isActive, useJobs, type JobView } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { EMPTY_EDITOR, activeTab, anyDirty, editorReducer, makeTab, type EditorState } from "./editor";
import {
  cuesKey,
  defaultSplitCaret,
  deleteCue,
  documentIssues,
  findReplace,
  insertAfter,
  isSubtitlePath,
  mergeWithNext,
  shiftAll,
  splitCue,
  toCues,
  toRows,
  updateCue,
  type CueRow,
} from "./logic";
import { DEFAULT_PREFS, buildOptions, parseResult, sanitizePrefs, type Prefs } from "./options";
import { cuesToLines, defaultVisuals, handoffSeed } from "./visuals";

export const MODULE_ID = "subtitles";
export const SUBTITLE_EXTS = [".srt", ".vtt"];

export type RunKey = "gen" | "extract" | "save" | "translate" | "burn" | "embed";
export const RUN_KEYS: readonly RunKey[] = ["gen", "extract", "save", "translate", "burn", "embed"];

export interface RunState {
  /** The job being followed (latest started); "" = none. */
  jobId: string;
  /** True from submit until the job exists. */
  submitting: boolean;
  /** A submit-time failure (validation, missing tool, …). */
  error: AppErrorShape | null;
}

const IDLE_RUN: RunState = { jobId: "", submitting: false, error: null };

/** What the panels need to know about the opened media (the main window reads the file; replicas get this). */
export interface MediaSummary {
  status: "none" | "loading" | "preparing" | "ready" | "error";
  errorMessage: string;
  errorHint: string;
  isVideo: boolean;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  subtitles: { index: number; codec: string; language: string; title: string; text: boolean }[];
}

export const NO_MEDIA: MediaSummary = {
  status: "none",
  errorMessage: "",
  errorHint: "",
  isVideo: false,
  width: 0,
  height: 0,
  fps: 0,
  durationMs: 0,
  subtitles: [],
};

/** What a confirmed "Discard unsaved changes?" goes on to do. Serialisable so a replica can ask the main window. */
export type Then =
  | { kind: "generate" }
  | { kind: "extract"; streamIndex: number }
  | { kind: "subtitleFile"; path: string }
  | { kind: "startOver" }
  | { kind: "useCut"; path: string };

export interface PendingConfirm {
  title: string;
  body: string;
  label: string;
  then: Then;
}

/** A player command. Every window with a player runs a command whose `n` it hasn't seen. */
export interface PlayerCommand {
  n: number;
  type: "seek" | "play" | "pause" | "none";
  ms: number;
}

export type RowAction = "split" | "merge" | "insert" | "delete" | "startAtPlayhead" | "endAtPlayhead";

export interface DesignerSelection {
  startMs: number;
  endMs: number;
}

export interface SubtitlesData {
  prefs: Prefs;
  mediaPath: string | null;
  subPath: string | null;
  loadError: string | null;
  editor: EditorState;
  /** The selected cue (clicked or being edited). */
  selectedId: string;
  /** Focus this cue's text next time the list renders it. */
  focusId: string;
  playheadMs: number;
  playing: boolean;
  cmd: PlayerCommand;
  /** "From" language of the translation; null = the original track's language. */
  sourceLang: string | null;
  /** The chosen burn visuals (null = the picker's first card). */
  chosen: VisualsSpec | null;
  addVisuals: boolean;
  runs: Record<RunKey, RunState>;
  media: MediaSummary;
  pendingConfirm: PendingConfirm | null;
  designerOpen: boolean;
  designerSelection: DesignerSelection | null;
  designerPlayheadMs: number;
  // Not bridged:
  prefsLoaded: boolean;
  languages: SubtitleLanguage[];
  spoken: Language[];
  styleInfos: SubtitleStyleInfo[];
  fonts: string[];
  translator: TranslatorStatus | null;
  staticLoaded: boolean;
  pendingSave: { tabId: string; key: string } | null;
  /** Job ids whose result was already applied (so a remounted view never applies one twice). */
  handled: string[];
}

export interface SubtitlesActions {
  // prefs
  patchPrefs(patch: Partial<Prefs>): void;
  loadPrefs(): Promise<void>;
  loadStatic(): Promise<void>;
  refreshTranslator(): void;
  // sources
  handleInputs(paths: string[]): void;
  takeMedia(path: string): void;
  pickMedia(): Promise<void>;
  pickSubtitleFile(): Promise<void>;
  openSubtitleFile(path: string): void;
  useCut(paths: string[]): void;
  startOver(): void;
  confirmPending(): void;
  cancelPending(): void;
  setMedia(summary: MediaSummary): void;
  // runs
  generate(): void;
  extract(streamIndex: number): void;
  save(formats?: string[]): void;
  translate(): void;
  burn(): void;
  embed(): void;
  cancelRun(key: RunKey): void;
  clearRun(key: RunKey): void;
  onJobDone(key: RunKey, job: JobView): void;
  openInVisualizer(inWindow?: boolean): void;
  openChat(): void;
  // editing
  edit(fn: (rows: CueRow[]) => CueRow[], key?: string): void;
  patchCue(id: string, patch: Partial<Omit<CueRow, "id">>, key?: string): void;
  rowAction(action: RowAction, id: string, caret: number): void;
  insertFirst(): void;
  shift(deltaMs: number): void;
  replaceAll(find: string, replacement: string, matchCase: boolean): void;
  undo(): void;
  redo(): void;
  selectTab(id: string): void;
  selectCue(id: string): void;
  clearFocus(): void;
  setSourceLang(code: string): void;
  // player
  seek(ms: number): void;
  play(): void;
  pause(): void;
  reportTime(ms: number): void;
  reportPlaying(playing: boolean): void;
  // visuals
  setVisuals(spec: VisualsSpec): void;
  setAddVisuals(on: boolean): void;
  openDesigner(): void;
  closeDesigner(): void;
  designerDone(spec: VisualsSpec): void;
  setDesignerSelection(sel: DesignerSelection | null): void;
  setDesignerPlayhead(ms: number): void;
}

export type SubtitlesState = SubtitlesData & SubtitlesActions;

export function initialData(): SubtitlesData {
  return {
    prefs: DEFAULT_PREFS,
    mediaPath: null,
    subPath: null,
    loadError: null,
    editor: EMPTY_EDITOR,
    selectedId: "",
    focusId: "",
    playheadMs: 0,
    playing: false,
    cmd: { n: 0, type: "none", ms: 0 },
    sourceLang: null,
    chosen: null,
    addVisuals: false,
    runs: { gen: IDLE_RUN, extract: IDLE_RUN, save: IDLE_RUN, translate: IDLE_RUN, burn: IDLE_RUN, embed: IDLE_RUN },
    media: NO_MEDIA,
    pendingConfirm: null,
    designerOpen: false,
    designerSelection: null,
    designerPlayheadMs: 0,
    prefsLoaded: false,
    languages: [],
    spoken: [],
    styleInfos: [],
    fonts: [],
    translator: null,
    staticLoaded: false,
    pendingSave: null,
    handled: [],
  };
}

function srtOutput(job: JobView): string | undefined {
  const result = parseResult(job.resultJson);
  const paths = result?.outputs?.length ? result.outputs : job.outputs.map((o) => o.path);
  return paths.find((p) => /\.srt$/i.test(p)) ?? paths.find(isSubtitlePath);
}

/** The rows of the active track. */
export function activeRows(s: Pick<SubtitlesData, "editor">): CueRow[] {
  return activeTab(s.editor)?.history.present ?? NO_ROWS;
}
const NO_ROWS: CueRow[] = [];

/** Why saving/exporting is blocked ("" when it isn't). */
export function exportBlocker(rows: readonly CueRow[], maxLineChars: number): string | null {
  const issues = documentIssues(rows, maxLineChars);
  return issues.tooMany ? "There are too many subtitles (the limit is 20,000)." : issues.firstError;
}

/** Whether a run's job is still going (or being submitted). */
export function runBusy(run: RunState): boolean {
  if (run.submitting) return true;
  const job = run.jobId ? useJobs.getState().byId[run.jobId] : undefined;
  return job !== undefined && isActive(job);
}

export const useSubtitles = create<SubtitlesState>()((set, get) => {
  const setRun = (key: RunKey, patch: Partial<RunState>) =>
    set((s) => ({ runs: { ...s.runs, [key]: { ...s.runs[key], ...patch } } }));

  const startRun = async (key: RunKey, inputs: string[], opts: SubtitlesOptions): Promise<void> => {
    setRun(key, { error: null, submitting: true });
    try {
      const jobs = await SubtitlesService.Enqueue(inputs, opts);
      const first = jobs?.[0];
      setRun(key, { submitting: false, ...(first ? { jobId: first.id } : {}) });
    } catch (e) {
      setRun(key, { submitting: false, error: toAppError(e) });
    }
  };

  const clearAllRuns = () => {
    set({ runs: initialData().runs });
  };

  const guard = (confirm: Omit<PendingConfirm, "then">, then: Then) => {
    if (!anyDirty(get().editor)) {
      perform(then);
      return;
    }
    set({ pendingConfirm: { ...confirm, then } });
  };
  const DISCARD = { title: "Discard unsaved changes?", body: "Your edits haven't been saved. Opening something else will lose them.", label: "Discard" };

  const openCues = async (path: string, label: string, language: string, kind: "open" | "add", savedPath?: string) => {
    try {
      const cues = await SubtitlesService.Load(path);
      const tab = makeTab(kind === "open" ? "original" : `tr-${language || label}`, label, language, toRows(cues), savedPath);
      set((s) => ({
        editor: editorReducer(s.editor, { type: kind === "open" ? "open" : "addTab", tab }),
        loadError: null,
        playheadMs: 0,
        selectedId: "",
      }));
    } catch (e) {
      const err = toAppError(e);
      set({ loadError: err.hint ? `${err.message} ${err.hint}` : err.message });
      toast({ title: "Couldn't read the subtitles", description: err.message, tone: "danger" });
    }
  };

  const setMediaPath = (path: string | null) => {
    set((s) => ({
      mediaPath: path,
      playheadMs: 0,
      playing: false,
      chosen: null,
      media: path ? { ...NO_MEDIA, status: "loading" } : NO_MEDIA,
      runs: { ...s.runs, gen: IDLE_RUN, extract: IDLE_RUN },
    }));
  };

  /** Runs a step the user has confirmed (or that needed no confirmation). */
  const perform = (then: Then) => {
    switch (then.kind) {
      case "generate":
        runGenerate();
        return;
      case "extract":
        runExtract(then.streamIndex);
        return;
      case "subtitleFile":
        set({ subPath: then.path });
        void openCues(then.path, "Original", "", "open");
        return;
      case "startOver":
        set({ ...initialDataKeepingStatic(get()) });
        return;
      case "useCut":
        set({ editor: EMPTY_EDITOR, subPath: null, loadError: null, selectedId: "", sourceLang: null, pendingSave: null });
        clearAllRuns();
        setMediaPath(then.path);
        return;
    }
  };

  const runGenerate = () => {
    const s = get();
    if (!s.mediaPath) return;
    void startRun("gen", [s.mediaPath], buildOptions(SubtitlesAction.ActionGenerate, s.prefs, { formats: ["srt"] }));
  };
  const runExtract = (streamIndex: number) => {
    const s = get();
    if (!s.mediaPath) return;
    void startRun("extract", [s.mediaPath], buildOptions(SubtitlesAction.ActionExtract, s.prefs, { streamIndex }));
  };

  const cueAt = () => get().playheadMs;

  return {
    ...initialData(),

    // ---- prefs and static data ----
    patchPrefs: (patch) => set((s) => ({ prefs: sanitizePrefs({ ...s.prefs, ...patch }, DEFAULT_PREFS) })),
    loadPrefs: async () => {
      try {
        const saved = await SettingsService.ModuleState(MODULE_ID);
        if (saved) set({ prefs: sanitizePrefs(JSON.parse(saved) as unknown, DEFAULT_PREFS) });
      } catch {
        /* unreadable state: defaults */
      }
      set({ prefsLoaded: true });
    },
    loadStatic: async () => {
      if (get().staticLoaded) return;
      set({ staticLoaded: true });
      const [languages, styleInfos, spoken, fonts] = await Promise.all([
        SubtitlesService.TranslationLanguages().catch(() => null),
        SubtitlesService.Styles().catch(() => null),
        loadSpeechLanguages(),
        LyricVideoService.Fonts().catch(() => null),
      ]);
      set({ languages: languages ?? [], styleInfos: styleInfos ?? [], spoken, fonts: fonts ?? [] });
    },
    refreshTranslator: () => {
      set({ translator: null });
      SubtitlesService.TranslatorStatus()
        .then((translator) => set({ translator }))
        .catch((e: unknown) => set({ translator: { ready: false, model: "", error: toAppError(e).message } }));
    },

    // ---- sources ----
    handleInputs: (paths) => {
      const first = paths[0];
      if (!first) return;
      if (isSubtitlePath(first)) get().openSubtitleFile(first);
      else get().takeMedia(first);
    },
    takeMedia: (path) => {
      setMediaPath(path);
    },
    pickMedia: async () => {
      try {
        const accepted = useModules.getState().byId[MODULE_ID]?.accepts.extensions;
        const exts = (accepted ?? []).filter((e) => !SUBTITLE_EXTS.includes(e.toLowerCase()));
        const paths = (await FilesService.PickWith("Choose a video or audio file", exts.length > 0 ? exts : null, false)) ?? [];
        if (paths[0]) get().takeMedia(paths[0]);
      } catch (e) {
        toast({ title: toAppError(e).message, tone: "danger" });
      }
    },
    pickSubtitleFile: async () => {
      try {
        const paths = (await FilesService.PickWith("Choose a subtitle file", SUBTITLE_EXTS, false)) ?? [];
        if (paths[0]) get().openSubtitleFile(paths[0]);
      } catch (e) {
        toast({ title: toAppError(e).message, tone: "danger" });
      }
    },
    openSubtitleFile: (path) => guard(DISCARD, { kind: "subtitleFile", path }),
    useCut: (paths) => {
      const path = paths[0];
      if (!path) return;
      if (get().editor.tabs.length === 0) {
        perform({ kind: "useCut", path });
        return;
      }
      set({
        pendingConfirm: {
          title: "Use the trimmed video?",
          body: "The subtitles were timed against the old video, so they are cleared. Generate them again for the cut, or open a subtitle file.",
          label: "Use the cut",
          then: { kind: "useCut", path },
        },
      });
    },
    startOver: () => guard({ title: "Discard unsaved changes?", body: "Your edits haven't been saved. Starting over will lose them.", label: "Discard" }, { kind: "startOver" }),
    confirmPending: () => {
      const p = get().pendingConfirm;
      set({ pendingConfirm: null });
      if (p) perform(p.then);
    },
    cancelPending: () => set({ pendingConfirm: null }),
    setMedia: (summary) =>
      set((s) => ({
        media: summary,
        // A design belongs to one kind of input (a video's overlay vs an audio file's background).
        chosen: s.media.isVideo !== summary.isVideo && s.media.status === "ready" ? null : s.chosen,
      })),

    // ---- runs ----
    generate: () => guard(DISCARD, { kind: "generate" }),
    extract: (streamIndex) => guard(DISCARD, { kind: "extract", streamIndex }),
    save: (formats) => {
      const s = get();
      const tab = activeTab(s.editor);
      if (!tab || exportBlocker(tab.history.present, s.prefs.maxLineChars) || runBusy(s.runs.save)) return;
      const input = tab.savedPath ?? s.subPath ?? s.mediaPath;
      if (!input) {
        toast({ title: "Nothing to name the file after", description: "Pick the video or a subtitle file first.", tone: "warn" });
        return;
      }
      set({ pendingSave: { tabId: tab.id, key: cuesKey(tab.history.present) } });
      void startRun("save", [input], buildOptions(SubtitlesAction.ActionSave, s.prefs, { cues: toCues(tab.history.present), formats: formats ?? s.prefs.formats }));
    },
    translate: () => {
      const s = get();
      const original = s.editor.tabs[0];
      if (!original || documentIssues(original.history.present, s.prefs.maxLineChars).firstError) return;
      const input = original.savedPath ?? s.subPath ?? s.mediaPath;
      if (!input) return;
      void startRun(
        "translate",
        [input],
        buildOptions(SubtitlesAction.ActionTranslate, s.prefs, {
          cues: toCues(original.history.present),
          sourceLanguage: s.sourceLang ?? original.language,
          targetLanguage: s.prefs.targetLanguage,
        }),
      );
    },
    burn: () => {
      const s = get();
      const rows = activeRows(s);
      if (!s.mediaPath || !activeTab(s.editor) || exportBlocker(rows, s.prefs.maxLineChars)) return;
      const burnsVisuals = s.media.isVideo ? s.addVisuals : s.prefs.background === "visualizer";
      const mode = s.media.isVideo ? "overlay" : "background";
      const visuals = s.chosen ?? defaultVisuals(mode);
      void startRun("burn", [s.mediaPath], buildOptions(SubtitlesAction.ActionBurn, s.prefs, { cues: toCues(rows), visuals: burnsVisuals ? visuals : null }));
    },
    embed: () => {
      const s = get();
      const tab = activeTab(s.editor);
      if (!s.mediaPath || !tab || exportBlocker(tab.history.present, s.prefs.maxLineChars)) return;
      void startRun(
        "embed",
        [s.mediaPath],
        buildOptions(SubtitlesAction.ActionEmbed, s.prefs, { cues: toCues(tab.history.present), trackLanguage: s.prefs.trackLanguage || tab.language }),
      );
    },
    cancelRun: (key) => {
      const id = get().runs[key].jobId;
      if (id) JobsService.Cancel(id).catch(() => undefined);
    },
    clearRun: (key) => setRun(key, IDLE_RUN),
    onJobDone: (key, job) => {
      const s = get();
      switch (key) {
        case "gen":
        case "extract": {
          const out = srtOutput(job);
          if (out) void openCues(out, "Original", parseResult(job.resultJson)?.language ?? "", "open", out);
          return;
        }
        case "save": {
          const p = s.pendingSave;
          set({ pendingSave: null });
          const result = parseResult(job.resultJson);
          const out = result?.outputs?.find((o) => /\.srt$/i.test(o)) ?? result?.outputs?.[0];
          if (p) set((st) => ({ editor: editorReducer(st.editor, { type: "saved", id: p.tabId, key: p.key, path: out }) }));
          return;
        }
        case "translate": {
          const out = srtOutput(job);
          const code = parseResult(job.resultJson)?.language || s.prefs.targetLanguage;
          const name = s.languages.find((l) => l.code === code)?.name ?? code.toUpperCase();
          if (out) void openCues(out, name, code, "add", out);
          return;
        }
        default:
          return;
      }
    },
    openInVisualizer: (inWindow) => {
      const s = get();
      if (!s.mediaPath) return;
      void openTool(
        "visualizer",
        [s.mediaPath],
        { seed: handoffSeed(cuesToLines(activeRows(s)), s.media.isVideo, s.prefs) },
        { window: inWindow === true },
      );
    },
    openChat: () => useUI.getState().navigate("llm-chat"),

    // ---- editing ----
    edit: (fn, key) => set((s) => ({ editor: editorReducer(s.editor, { type: "edit", fn, key, at: Date.now() }) })),
    patchCue: (id, patch, key) => {
      get().edit((r) => updateCue(r, id, patch), key);
      set({ selectedId: id });
    },
    rowAction: (action, id, caret) => {
      const s = get();
      const rows = activeRows(s);
      const index = rows.findIndex((r) => r.id === id);
      const row = rows[index];
      if (!row) return;
      const now = cueAt();
      switch (action) {
        case "split": {
          const at = caret >= 0 ? caret : defaultSplitCaret(row.text);
          const next = splitCue(rows, index, at, s.media.status === "ready" ? now : undefined);
          if (!next) {
            toast({ title: "Put the cursor inside the text to split", tone: "warn" });
            return;
          }
          get().edit(() => next);
          set({ selectedId: id });
          return;
        }
        case "merge": {
          const next = mergeWithNext(rows, index, s.prefs.maxLineChars);
          if (next) {
            get().edit(() => next);
            set({ selectedId: id });
          }
          return;
        }
        case "insert": {
          const res = insertAfter(rows, index);
          get().edit(() => res.rows);
          set({ focusId: res.id, selectedId: res.id });
          return;
        }
        case "delete":
          get().edit((r) => deleteCue(r, id));
          if (get().selectedId === id) set({ selectedId: "" });
          return;
        case "startAtPlayhead":
          if (now >= row.endMs) toast({ title: "The playhead is after this subtitle's end", tone: "warn" });
          else get().patchCue(id, { startMs: Math.round(now) });
          return;
        case "endAtPlayhead":
          if (now <= row.startMs) toast({ title: "The playhead is before this subtitle's start", tone: "warn" });
          else get().patchCue(id, { endMs: Math.round(now) });
          return;
      }
    },
    insertFirst: () => {
      const res = insertAfter(activeRows(get()), -1);
      get().edit(() => res.rows);
      set({ focusId: res.id, selectedId: res.id });
    },
    shift: (deltaMs) => get().edit((r) => shiftAll(r, deltaMs)),
    replaceAll: (find, replacement, matchCase) => {
      const res = findReplace(activeRows(get()), find, replacement, matchCase);
      if (res.count > 0) get().edit(() => res.rows);
    },
    undo: () => set((s) => ({ editor: editorReducer(s.editor, { type: "undo" }) })),
    redo: () => set((s) => ({ editor: editorReducer(s.editor, { type: "redo" }) })),
    selectTab: (id) => set((s) => ({ editor: editorReducer(s.editor, { type: "select", id }), selectedId: "" })),
    selectCue: (id) => set({ selectedId: id }),
    clearFocus: () => set({ focusId: "" }),
    setSourceLang: (code) => set({ sourceLang: code }),

    // ---- player ----
    seek: (ms) => set((s) => ({ playheadMs: ms, cmd: { n: s.cmd.n + 1, type: "seek", ms } })),
    play: () => set((s) => ({ cmd: { n: s.cmd.n + 1, type: "play", ms: 0 } })),
    pause: () => set((s) => ({ cmd: { n: s.cmd.n + 1, type: "pause", ms: 0 } })),
    reportTime: (ms) => set((s) => (s.playheadMs === ms ? s : { playheadMs: ms })),
    reportPlaying: (playing) => set((s) => (s.playing === playing ? s : { playing })),

    // ---- visuals ----
    setVisuals: (spec) => set({ chosen: spec }),
    setAddVisuals: (on) => set({ addVisuals: on }),
    openDesigner: () => set({ designerOpen: true }),
    closeDesigner: () => set({ designerOpen: false }),
    designerDone: (spec) => set({ chosen: spec, designerOpen: false }),
    setDesignerSelection: (sel) => set({ designerSelection: sel }),
    setDesignerPlayhead: (ms) => set((s) => (s.designerPlayheadMs === ms ? s : { designerPlayheadMs: ms })),
  };
});

/** Back to the empty state, keeping the lists loaded once per window and the user's prefs. */
function initialDataKeepingStatic(s: SubtitlesState): SubtitlesData {
  return {
    ...initialData(),
    prefs: s.prefs,
    prefsLoaded: s.prefsLoaded,
    languages: s.languages,
    spoken: s.spoken,
    styleInfos: s.styleInfos,
    fonts: s.fonts,
    staticLoaded: s.staticLoaded,
  };
}

/** What a replica needs of a track: the cues and how many undo/redo steps the host holds (never the steps). */
export interface EditorViewTab {
  id: string;
  label: string;
  language: string;
  rows: CueRow[];
  savedKey: string;
  savedPath?: string;
  undoCount: number;
  redoCount: number;
}

export interface EditorView {
  tabs: EditorViewTab[];
  activeId: string;
}

const viewCache = new WeakMap<EditorState, EditorView>();

/** The editor without its undo history (same object for the same editor state, so the bridge's reference check holds). */
export function editorView(e: EditorState): EditorView {
  let v = viewCache.get(e);
  if (!v) {
    v = {
      activeId: e.activeId,
      tabs: e.tabs.map((t) => ({
        id: t.id,
        label: t.label,
        language: t.language,
        rows: t.history.present,
        savedKey: t.savedKey,
        savedPath: t.savedPath,
        undoCount: t.history.past.length,
        redoCount: t.history.future.length,
      })),
    };
    viewCache.set(e, v);
  }
  return v;
}

/** A replica's editor from the host's view: undo/redo only count (actions run on the host). */
export function editorFromView(v: EditorView): EditorState {
  return {
    activeId: v.activeId,
    tabs: v.tabs.map((t) => ({
      id: t.id,
      label: t.label,
      language: t.language,
      savedKey: t.savedKey,
      savedPath: t.savedPath,
      history: {
        past: new Array<CueRow[]>(t.undoCount).fill(t.rows),
        present: t.rows,
        future: new Array<CueRow[]>(t.redoCount).fill(t.rows),
        lastAt: 0,
      },
    })),
  };
}

/** The values mirrored into part windows (each key compared by reference). */
export function bridgedValues(s: SubtitlesState) {
  return {
    prefs: s.prefs,
    mediaPath: s.mediaPath,
    subPath: s.subPath,
    loadError: s.loadError,
    editorView: editorView(s.editor),
    selectedId: s.selectedId,
    focusId: s.focusId,
    playheadMs: s.playheadMs,
    playing: s.playing,
    cmd: s.cmd,
    sourceLang: s.sourceLang,
    chosen: s.chosen,
    addVisuals: s.addVisuals,
    runs: s.runs,
    media: s.media,
    pendingConfirm: s.pendingConfirm,
    designerOpen: s.designerOpen,
    designerSelection: s.designerSelection,
    designerPlayheadMs: s.designerPlayheadMs,
  };
}

/** Actions a replica forwards to the main window. */
export const BRIDGED_ACTIONS = [
  "patchPrefs",
  "handleInputs",
  "takeMedia",
  "pickMedia",
  "pickSubtitleFile",
  "openSubtitleFile",
  "useCut",
  "startOver",
  "confirmPending",
  "cancelPending",
  "generate",
  "extract",
  "save",
  "translate",
  "burn",
  "embed",
  "cancelRun",
  "clearRun",
  "openInVisualizer",
  "openChat",
  "patchCue",
  "rowAction",
  "insertFirst",
  "shift",
  "replaceAll",
  "undo",
  "redo",
  "selectTab",
  "selectCue",
  "clearFocus",
  "setSourceLang",
  "seek",
  "play",
  "pause",
  "reportTime",
  "reportPlaying",
  "setVisuals",
  "setAddVisuals",
  "openDesigner",
  "closeDesigner",
  "designerDone",
  "setDesignerSelection",
  "setDesignerPlayhead",
] as const satisfies readonly (keyof SubtitlesActions)[];

/** The cues of the active track and what blocks exporting them. */
export function activeBlocker(s: Pick<SubtitlesState, "editor" | "prefs">): string | null {
  return exportBlocker(activeRows(s), s.prefs.maxLineChars);
}
