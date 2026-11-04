/**
 * The Lyric Video's state (SPEC Phase 11 §5.4): one workspace, no steps. It holds
 * everything the panels and the preview share: the song and its tags, the
 * lyric sheet with its undo history, the remembered look/options (`prefs`),
 * the playhead, the ids of the jobs the tool started and what the listening
 * (visuals analysis) found.
 *
 * The song, the sheet and the options survive leaving the tool (SPEC.md §9.2,
 * §9.4). Panels take no props and read this store, so they render the same in a
 * drawer and in a pop-out window; a window's replica of the store never owns
 * the player or submits jobs (its actions are forwarded to the host window).
 */
import { create } from "zustand";
import type { MediaPlayerHandle } from "@/components/media";
import type { VisualsAnalysis } from "@/components/viz";
import type { AnalysisRef } from "@/lib/api";
import type { AppErrorShape } from "@/lib/errors";
import {
  deleteRow,
  editorReducer,
  insertAfter,
  latestStarted,
  newHistory,
  nudgeLine,
  setLineStart,
  setLineText,
  shiftAll as shiftRows,
  tapBack,
  tapStamp,
  type EditorAction,
  type History,
  type Row,
} from "./logic";
import { DEFAULT_PREFS, type Prefs } from "./options";

export const LYRIC_VIDEO_ID = "lyric-video";

export type JobSlot = "gen" | "lrc" | "preview" | "render";
export type SlotMap<T> = Record<JobSlot, T>;

/** The host window's audio player (a replica has none; its playback actions run on the host). */
export const playerHandle: { current: MediaPlayerHandle | null } = { current: null };

type Setter<T> = (v: T | ((prev: T) => T)) => void;

const NO_IDS: SlotMap<string> = { gen: "", lrc: "", preview: "", render: "" };
const NO_BUSY: SlotMap<boolean> = { gen: false, lrc: false, preview: false, render: false };
const NO_ERRORS: SlotMap<AppErrorShape | null> = { gen: null, lrc: null, preview: null, render: null };

export interface LyricVideoState {
  // ---- the session (survives leaving the tool) ----
  songPath: string | null;
  meta: { title: string; artist: string };
  /** Pasted lyrics (align source). */
  text: string;
  lyricsPath: string;
  /** The sheet and its undo history; `rows`, `canUndo` and `canRedo` are what the windows share. */
  history: History<Row[]>;
  rows: Row[];
  canUndo: boolean;
  canRedo: boolean;
  matched: number | null;
  noLyrics: boolean;
  /** An instrumental exists for this song (2-stem cache or the Visualizer's 4-stem mix). */
  hasInstrumental: boolean;
  /** "Also save the stems to the Library" (never remembered). */
  saveStems: boolean;
  // ---- remembered options ----
  prefs: Prefs;
  prefsDirty: boolean;
  // ---- the song's media (the host window reads them) ----
  mediaReady: boolean;
  durationMs: number;
  hasCover: boolean;
  coverUrl: string | undefined;
  imageUrl: string | undefined;
  // ---- playback and selection ----
  selectedId: string;
  playheadMs: number;
  playing: boolean;
  /** The line tap-to-sync stamps next (-1 when not tapping). */
  tapIndex: number;
  previewStartMs: number;
  // ---- visuals ----
  /** The full designer is open on the stage. */
  designerOpen: boolean;
  /** What the listening found (host: the live hook; a replica loads the analysis from the ref). */
  listening: VisualsAnalysis | null;
  listenRef: AnalysisRef | null;
  // ---- jobs ----
  jobIds: SlotMap<string>;
  submitting: SlotMap<boolean>;
  jobErrors: SlotMap<AppErrorShape | null>;
  // ---- window plumbing ----
  /** A song that waits for the user to agree to discard their lyric edits. */
  pendingSong: string | null;
  /** A panel something outside the workspace wants opened (palette commands). */
  panelRequest: { id: string; n: number } | null;

  // actions
  applySong(path: string): void;
  requestSong(path: string): void;
  resolvePendingSong(accept: boolean): void;
  setMeta: Setter<{ title: string; artist: string }>;
  setText(text: string): void;
  setLyricsPath(path: string): void;
  setMatched(m: number | null): void;
  setNoLyrics(v: boolean): void;
  setHasInstrumental(v: boolean): void;
  setSaveStems(v: boolean): void;
  setPrefs: Setter<Prefs>;
  loadPrefs(p: Prefs): void;
  setMedia(m: Partial<Pick<LyricVideoState, "mediaReady" | "durationMs" | "hasCover" | "coverUrl" | "imageUrl">>): void;
  setListening(l: VisualsAnalysis | null): void;
  setPlayheadMs(ms: number): void;
  setPlaying(v: boolean): void;
  setPreviewStartMs(ms: number): void;
  setDesignerOpen(open: boolean): void;
  requestPanel(id: string | null): void;
  // job slots
  setJob(slot: JobSlot, id: string): void;
  setSubmitting(slot: JobSlot, v: boolean): void;
  setJobError(slot: JobSlot, e: AppErrorShape | null): void;
  clearJobs(): void;
  // sheet
  dispatch(a: EditorAction): void;
  resetSheet(rows: Row[]): void;
  select(id: string): void;
  setStart(id: string, ms: number): void;
  nudge(id: string, deltaMs: number): void;
  setLineText(id: string, text: string): void;
  insertLine(): void;
  deleteSelected(): void;
  shiftAll(deltaMs: number): void;
  undo(): void;
  redo(): void;
  // playback (run on the host window, where the player is)
  seek(ms: number): void;
  playFrom(ms: number): void;
  togglePlay(): void;
  // tap to sync
  startTap(): void;
  endTap(): void;
  stamp(): void;
  tapBackOne(): void;
  reset(): void;
}

function sheet(h: History<Row[]>): Pick<LyricVideoState, "history" | "rows" | "canUndo" | "canRedo"> {
  return { history: h, rows: h.present, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}

function initial() {
  return {
    songPath: null as string | null,
    meta: { title: "", artist: "" },
    text: "",
    lyricsPath: "",
    ...sheet(newHistory<Row[]>([])),
    matched: null as number | null,
    noLyrics: false,
    hasInstrumental: false,
    saveStems: false,
    prefs: DEFAULT_PREFS,
    prefsDirty: false,
    mediaReady: false,
    durationMs: 0,
    hasCover: false,
    coverUrl: undefined as string | undefined,
    imageUrl: undefined as string | undefined,
    selectedId: "",
    playheadMs: 0,
    playing: false,
    tapIndex: -1,
    previewStartMs: 0,
    designerOpen: false,
    listening: null as VisualsAnalysis | null,
    listenRef: null as AnalysisRef | null,
    jobIds: NO_IDS,
    submitting: NO_BUSY,
    jobErrors: NO_ERRORS,
    pendingSong: null as string | null,
    panelRequest: null as { id: string; n: number } | null,
  };
}

function apply<T>(v: T | ((p: T) => T), prev: T): T {
  return typeof v === "function" ? (v as (p: T) => T)(prev) : v;
}

export const useLyricVideo = create<LyricVideoState>((set, get) => {
  const edit = (fn: (r: Row[]) => Row[], key?: string) =>
    set((s) => sheet(editorReducer(s.history, { type: "edit", fn, key, at: Date.now() })));
  const slotSet = <T,>(key: "jobIds" | "submitting" | "jobErrors", slot: JobSlot, v: T) =>
    set((s) => ({ [key]: { ...(s[key] as SlotMap<T>), [slot]: v } }) as unknown as Partial<LyricVideoState>);

  return {
    ...initial(),

    applySong: (path) =>
      set({
        ...initial(),
        // what is remembered across songs
        prefs: get().prefs,
        prefsDirty: get().prefsDirty,
        listening: get().listening,
        songPath: path,
      }),
    requestSong: (path) => {
      if (get().canUndo) set({ pendingSong: path });
      else get().applySong(path);
    },
    resolvePendingSong: (accept) => {
      const p = get().pendingSong;
      set({ pendingSong: null });
      if (accept && p) get().applySong(p);
    },
    setMeta: (v) => set((s) => ({ meta: apply(v, s.meta) })),
    setText: (text) => set({ text }),
    setLyricsPath: (lyricsPath) => set({ lyricsPath }),
    setMatched: (matched) => set({ matched }),
    setNoLyrics: (noLyrics) => set({ noLyrics }),
    setHasInstrumental: (hasInstrumental) => set({ hasInstrumental }),
    setSaveStems: (saveStems) => set({ saveStems }),
    setPrefs: (v) => set((s) => ({ prefs: apply(v, s.prefs), prefsDirty: true })),
    loadPrefs: (prefs) => {
      if (!get().prefsDirty) set({ prefs });
    },
    setMedia: (m) => set(m),
    setListening: (listening) => set({ listening, listenRef: listening?.ref ?? null }),
    setPlayheadMs: (playheadMs) => set({ playheadMs }),
    setPlaying: (playing) => set({ playing }),
    setPreviewStartMs: (previewStartMs) => set({ previewStartMs }),
    setDesignerOpen: (designerOpen) => set({ designerOpen }),
    requestPanel: (id) => set((s) => ({ panelRequest: id ? { id, n: (s.panelRequest?.n ?? 0) + 1 } : null })),

    setJob: (slot, id) => slotSet("jobIds", slot, id),
    setSubmitting: (slot, v) => slotSet("submitting", slot, v),
    setJobError: (slot, e) => slotSet("jobErrors", slot, e),
    clearJobs: () => set({ jobIds: NO_IDS, submitting: NO_BUSY, jobErrors: NO_ERRORS }),

    dispatch: (a) => set((s) => sheet(editorReducer(s.history, a))),
    resetSheet: (rows) => set({ ...sheet(newHistory(rows)), selectedId: "", playheadMs: 0 }),
    select: (selectedId) => set({ selectedId }),
    setStart: (id, ms) => edit((r) => setLineStart(r, id, ms), `start:${id}`),
    nudge: (id, d) => edit((r) => nudgeLine(r, id, d), `nudge:${id}`),
    setLineText: (id, t) => edit((r) => setLineText(r, id, t), `text:${id}`),
    insertLine: () => {
      const s = get();
      const sel = s.rows.findIndex((r) => r.id === s.selectedId);
      const active = latestStarted(s.rows, s.playheadMs);
      const index = sel >= 0 ? sel : active >= 0 ? active : s.rows.length - 1;
      const res = insertAfter(s.rows, index, s.mediaReady ? Math.round(s.playheadMs) : undefined);
      edit(() => res.rows);
      set({ selectedId: res.id });
    },
    deleteSelected: () => {
      const s = get();
      const sel = s.rows.findIndex((r) => r.id === s.selectedId);
      if (sel < 0) return;
      const neighbour = s.rows[sel + 1] ?? s.rows[sel - 1];
      const id = s.selectedId;
      edit((r) => deleteRow(r, id));
      set({ selectedId: neighbour?.id ?? "" });
    },
    shiftAll: (d) => edit((r) => shiftRows(r, d)),
    undo: () => get().dispatch({ type: "undo" }),
    redo: () => get().dispatch({ type: "redo" }),

    seek: (ms) => {
      set({ playheadMs: ms });
      playerHandle.current?.seek(ms);
    },
    playFrom: (ms) => {
      set({ playheadMs: ms });
      playerHandle.current?.seek(ms);
      playerHandle.current?.play();
    },
    togglePlay: () => playerHandle.current?.toggle(),

    startTap: () => {
      if (get().rows.length === 0) return;
      if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) document.activeElement.blur();
      playerHandle.current?.seek(0);
      playerHandle.current?.play();
      set({ playheadMs: 0, tapIndex: 0 });
    },
    endTap: () => {
      set({ tapIndex: -1 });
      playerHandle.current?.pause();
    },
    stamp: () => {
      const s = get();
      const index = s.tapIndex;
      if (index < 0) return;
      const ms = Math.round(playerHandle.current?.currentMs() ?? s.playheadMs);
      const res = tapStamp(s.rows, index, ms);
      edit((r) => tapStamp(r, index, ms).rows);
      const row = res.rows[index];
      if (row) set({ selectedId: row.id });
      if (res.done) get().endTap();
      else set({ tapIndex: res.next });
    },
    tapBackOne: () => set((s) => ({ tapIndex: tapBack(s.tapIndex) })),
    reset: () => set({ ...initial(), prefs: get().prefs, prefsDirty: get().prefsDirty }),
  };
});

/** Forgets the whole session and the remembered options (tests, and a fresh start). */
export function resetLyricVideo(): void {
  useLyricVideo.setState(initial(), false);
  playerHandle.current = null;
}
