/**
 * The Color Grader's store (Phase 21 SPEC §E1). One picture or video is open
 * at a time out of a batch list; the look (a `GradeRecipe`), Wildness and the
 * rest of the document live here so the panels (which take no props) and the
 * popped-out preview read the same state. The synchronous actions are bridged
 * to replica windows; everything that calls a service lives in `actions.ts`
 * and only ever runs in the window that hosts the store.
 */
import { create } from "zustand";
import type { GradeMapState, EditSourceState } from "@/lib/api";
import { GRADE_OP_KINDS, type GradeOp, type GradeOpKind, type GradeParam, type GradeRecipe, type Region } from "@/grade/types";
import { surprise, chaosSeed } from "./chaos";
import { addOp, clamp01, emptyRecipe, moveOp, patchOp, patchParam, removeOp, rename } from "./recipe";

export const MODULE_ID = "grade";

export const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".tif", ".tiff", ".heic", ".heif", ".bmp"];
export const VIDEO_EXTS = [".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".ts", ".mts", ".m2ts", ".wmv", ".flv", ".3gp", ".ogv", ".mpg", ".mpeg"];
export const ALL_EXTS = [...IMAGE_EXTS, ...VIDEO_EXTS];

export type InputKind = "image" | "video";
export type GalleryTab = "film" | "bold" | "bonkers" | "mine";
export type OutputFormat = "same" | "jpg" | "png" | "webp";

export function kindOfPath(path: string): InputKind {
  const i = path.lastIndexOf(".");
  const ext = i >= 0 ? path.slice(i).toLowerCase() : "";
  return VIDEO_EXTS.includes(ext) ? "video" : "image";
}

export const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

export interface Suggestion {
  name: string;
  why: string;
  recipe: GradeRecipe;
}

export type Busy = "idle" | "busy" | "error";

export interface BeatState {
  on: boolean;
  /** "" = the video's own audio. */
  song: string;
}

export interface GradeState {
  // ---- inputs ----
  inputs: string[];
  selected: string;
  /** What the open input is (from `EditStudioService.Sources`, once probed). */
  src: EditSourceState | null;
  /** /media URLs by path (a prepared preview picture or stream and its index). */
  urls: Record<string, string>;
  /** The prepare job of the open video. */
  prepareJob: string;
  // ---- the look ----
  recipe: GradeRecipe;
  /** The built-in look's id the recipe came from ("" = custom or saved). */
  lookId: string;
  wild: number;
  // ---- maps ----
  maps: GradeMapState | null;
  mapView: "" | "depth" | "subject" | "people";
  // ---- compare / transport ----
  compare: boolean;
  comparePos: number;
  timeMs: number;
  playing: boolean;
  // ---- gallery ----
  tab: GalleryTab;
  mine: GradeRecipe[];
  suggestions: Suggestion[];
  suggestionsFor: string;
  // ---- vibe, read, chaos ----
  vibeText: string;
  vibe: { phase: Busy; error: string; results: GradeRecipe[] };
  read: { phase: Busy; error: string };
  chaosSeed: number;
  locked: string[];
  // ---- steal ----
  steal: { phase: Busy; error: string; ref: string };
  // ---- export ----
  format: OutputFormat;
  beat: BeatState;
  exporting: boolean;

  // ---- actions (bridged) ----
  addInputs(paths: string[]): void;
  removeInput(path: string): void;
  clearInputs(): void;
  select(path: string): void;
  setSource(src: EditSourceState | null): void;
  addUrls(urls: Record<string, string>): void;
  setPrepareJob(id: string): void;
  setRecipe(recipe: GradeRecipe, lookId?: string): void;
  setWild(w: number): void;
  setMaps(m: GradeMapState | null): void;
  setMapView(v: GradeState["mapView"]): void;
  setCompare(on: boolean): void;
  setComparePos(p: number): void;
  setTime(ms: number): void;
  setPlaying(on: boolean): void;
  setTab(t: GalleryTab): void;
  setMine(list: GradeRecipe[]): void;
  setSuggestions(items: Suggestion[], forPath: string): void;
  setVibeText(t: string): void;
  setVibe(v: Partial<GradeState["vibe"]>): void;
  setRead(v: Partial<GradeState["read"]>): void;
  setChaosSeed(n: number): void;
  setSteal(v: Partial<GradeState["steal"]>): void;
  setFormat(f: OutputFormat): void;
  setBeat(b: Partial<BeatState>): void;
  setExporting(on: boolean): void;
  // recipe edits
  renameLook(name: string): void;
  addOp(kind: GradeOpKind): void;
  removeOp(id: string): void;
  moveOp(from: number, to: number): void;
  toggleOp(id: string, on: boolean): void;
  setAmount(id: string, amount: number): void;
  setRegion(id: string, region: Region): void;
  setParam(id: string, key: string, value: GradeParam): void;
  setChaosFlag(id: string, chaos: boolean): void;
  setAnim(id: string, anim: GradeOp["anim"] | null): void;
  addOpFromRecipe(op: GradeOp): void;
  toggleLock(id: string): void;
  surprise(seed?: number, video?: boolean): void;
  again(video?: boolean): void;
}

const NO_STRINGS: string[] = [];

function initial() {
  return {
    inputs: NO_STRINGS,
    selected: "",
    src: null,
    urls: {},
    prepareJob: "",
    recipe: emptyRecipe(),
    lookId: "",
    wild: 0.5,
    maps: null,
    mapView: "" as const,
    compare: false,
    comparePos: 0.5,
    timeMs: 0,
    playing: false,
    tab: "film" as GalleryTab,
    mine: [] as GradeRecipe[],
    suggestions: [] as Suggestion[],
    suggestionsFor: "",
    vibeText: "",
    vibe: { phase: "idle" as Busy, error: "", results: [] as GradeRecipe[] },
    read: { phase: "idle" as Busy, error: "" },
    chaosSeed: 4821,
    locked: NO_STRINGS,
    steal: { phase: "idle" as Busy, error: "", ref: "" },
    format: "same" as OutputFormat,
    beat: { on: false, song: "" },
    exporting: false,
  };
}

/** Resets everything that belongs to one open input (its maps, source, time). */
function perInput() {
  return { src: null, prepareJob: "", maps: null, mapView: "" as const, timeMs: 0, playing: false, steal: { phase: "idle" as Busy, error: "", ref: "" } };
}

const clampTime = (n: number): number => (Number.isFinite(n) ? Math.max(0, n) : 0);

export const useGrade = create<GradeState>((set, get) => {
  const edit = (f: (r: GradeRecipe) => GradeRecipe) => set((s) => ({ recipe: f(s.recipe), lookId: "" }));
  return {
    ...initial(),

    addInputs: (paths) =>
      set((s) => {
        const fresh = [...new Set(paths)].filter((p) => !s.inputs.includes(p));
        if (fresh.length === 0) return s;
        const inputs = [...s.inputs, ...fresh];
        return s.selected ? { inputs } : { inputs, selected: fresh[0] ?? "", ...perInput() };
      }),
    removeInput: (path) =>
      set((s) => {
        const inputs = s.inputs.filter((p) => p !== path);
        if (s.selected !== path) return { inputs };
        return { inputs, selected: inputs[0] ?? "", ...perInput() };
      }),
    clearInputs: () => set({ inputs: NO_STRINGS, selected: "", ...perInput() }),
    select: (path) => set((s) => (s.selected === path || !s.inputs.includes(path) ? s : { selected: path, ...perInput() })),
    setSource: (src) => set({ src }),
    addUrls: (urls) => set((s) => ({ urls: { ...s.urls, ...urls } })),
    setPrepareJob: (id) => set({ prepareJob: id }),
    setRecipe: (recipe, lookId = "") => set({ recipe, lookId }),
    setWild: (w) => set({ wild: clamp01(w) }),
    setMaps: (maps) => set({ maps }),
    setMapView: (mapView) => set({ mapView }),
    setCompare: (compare) => set({ compare }),
    setComparePos: (p) => set({ comparePos: clamp01(p) }),
    setTime: (ms) => set({ timeMs: clampTime(ms) }),
    setPlaying: (playing) => set({ playing }),
    setTab: (tab) => set({ tab }),
    setMine: (mine) => set({ mine }),
    setSuggestions: (suggestions, suggestionsFor) => set({ suggestions, suggestionsFor }),
    setVibeText: (vibeText) => set({ vibeText }),
    setVibe: (v) => set((s) => ({ vibe: { ...s.vibe, ...v } })),
    setRead: (v) => set((s) => ({ read: { ...s.read, ...v } })),
    setChaosSeed: (n) => set({ chaosSeed: chaosSeed(n) }),
    setSteal: (v) => set((s) => ({ steal: { ...s.steal, ...v } })),
    setFormat: (format) => set({ format }),
    setBeat: (b) => set((s) => ({ beat: { ...s.beat, ...b } })),
    setExporting: (exporting) => set({ exporting }),

    renameLook: (name) => edit((r) => rename(r, name)),
    addOp: (kind) => {
      if (!(GRADE_OP_KINDS as readonly string[]).includes(kind)) return;
      edit((r) => addOp(r, kind));
    },
    removeOp: (id) => {
      edit((r) => removeOp(r, id));
      set((s) => ({ locked: s.locked.filter((l) => l !== id) }));
    },
    moveOp: (from, to) => edit((r) => moveOp(r, from, to)),
    toggleOp: (id, on) => edit((r) => patchOp(r, id, { on })),
    setAmount: (id, amount) => edit((r) => patchOp(r, id, { amount: clamp01(amount) })),
    setRegion: (id, region) => edit((r) => patchOp(r, id, { region })),
    setParam: (id, key, value) => edit((r) => patchParam(r, id, key, value)),
    setChaosFlag: (id, chaos) => edit((r) => patchOp(r, id, chaos ? { chaos: true } : { chaos: undefined })),
    setAnim: (id, anim) => edit((r) => patchOp(r, id, anim ? { anim } : { anim: undefined })),
    addOpFromRecipe: (op) =>
      edit((r) => {
        if (r.ops.length >= 16) return r;
        const taken = new Set(r.ops.map((o) => o.id));
        const id = taken.has(op.id) ? `${op.id.slice(0, 5)}${taken.size % 10}` : op.id;
        return { ...r, ops: [...r.ops, { ...op, id }] };
      }),
    toggleLock: (id) => set((s) => ({ locked: s.locked.includes(id) ? s.locked.filter((l) => l !== id) : [...s.locked, id] })),
    surprise: (seed, video) => {
      const s = get();
      const n = chaosSeed(seed ?? s.chaosSeed);
      const keep = s.recipe.ops.filter((o) => s.locked.includes(o.id));
      const r = surprise({ seed: n, wild: s.wild, locked: keep, video: video ?? s.src?.info.kind === "video" });
      set({ recipe: r, lookId: "", chaosSeed: n, locked: s.locked.filter((id) => r.ops.some((o) => o.id === id)) });
    },
    again: (video) => get().surprise(chaosSeed(get().chaosSeed + 1), video),
  };
});

/** Resets the store (tests, closing the tool). */
export function resetGrade(): void {
  useGrade.setState({ ...initial() });
}

/** The actions a replica forwards to the host: every argument is JSON. */
export const BRIDGED_ACTIONS = [
  "setRecipe",
  "setWild",
  "setCompare",
  "setComparePos",
  "setTime",
  "setPlaying",
  "setTab",
  "setMapView",
  "setVibeText",
  "setChaosSeed",
  "setFormat",
  "setBeat",
  "renameLook",
  "addOp",
  "removeOp",
  "moveOp",
  "toggleOp",
  "setAmount",
  "setRegion",
  "setParam",
  "setChaosFlag",
  "setAnim",
  "toggleLock",
  "surprise",
  "again",
] as const satisfies readonly (keyof GradeState)[];

export type GradeBridgeValues = {
  inputs: string[];
  selected: string;
  src: EditSourceState | null;
  urls: Record<string, string>;
  recipe: GradeRecipe;
  lookId: string;
  wild: number;
  maps: GradeMapState | null;
  mapView: GradeState["mapView"];
  compare: boolean;
  comparePos: number;
  timeMs: number;
  playing: boolean;
  tab: GalleryTab;
  mine: GradeRecipe[];
  suggestions: Suggestion[];
  vibeText: string;
  chaosSeed: number;
  locked: string[];
  format: OutputFormat;
  beat: BeatState;
};

export function pickGradeValues(s: GradeState): GradeBridgeValues {
  return {
    inputs: s.inputs,
    selected: s.selected,
    src: s.src,
    urls: s.urls,
    recipe: s.recipe,
    lookId: s.lookId,
    wild: s.wild,
    maps: s.maps,
    mapView: s.mapView,
    compare: s.compare,
    comparePos: s.comparePos,
    timeMs: s.timeMs,
    playing: s.playing,
    tab: s.tab,
    mine: s.mine,
    suggestions: s.suggestions,
    vibeText: s.vibeText,
    chaosSeed: s.chaosSeed,
    locked: s.locked,
    format: s.format,
    beat: s.beat,
  };
}
