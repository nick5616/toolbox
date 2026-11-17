/**
 * Photo Composer state (Phase 11, SPEC §5.1): the open composition and
 * everything about editing it, in one zustand store so the panels and the
 * preview can render in the tool, in a drawer or popped out in their own
 * window (`workspace.tsx` bridges it).
 *
 * The window that opened the project is the host: it runs the actions, the
 * autosave, the job watching and the collage build (`Editor.tsx`). Part
 * windows hold replicas whose bridged actions run on the host, so every
 * bridged action takes JSON-serialisable arguments (ids and plain values,
 * never callbacks). Decoded images are per window (`images.ts`).
 */
import { useMemo } from "react";
import { create, type StateCreator } from "zustand";
import { toast } from "@/components";
import { applyLayout, type LayoutKind } from "@/composer/layouts";
import { loadImage, loadImages } from "@/composer/loadImages";
import {
  addLayer,
  aspectSize,
  deleteLayer,
  duplicateLayer as duplicateLayerDoc,
  findLayer,
  layerList,
  MAX_LAYERS,
  MAX_TEXT_CHARS,
  moveLayer,
  newImageLayer,
  newTextLayer,
  reorderLayer as reorderLayerDoc,
  setLayerSource,
  updateLayer,
  type MoveDirection,
} from "@/composer/model";
import { imageSize, layerSize } from "@/composer/render";
import { ComposerService, FilesService, type ComposerBackground, type ComposerLayer, type Composition } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { adoptParkedHistory, registerHistory } from "@/lib/parkedHistory";
import { newHistory, pushHistory, redo as redoH, undo as undoH, type History } from "@/lib/history";
import { useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import type { PostSlideSeed } from "@/state/ui";
import { composerImages } from "./images";
import { geometryChanged, idRange, nameAfterSourceChange } from "./logic";
import type { SaveState } from "./useAutosave";

export const MODULE_ID = "photo-composer";
export const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff", ".heic", ".heif"];

/** Steps of a collage build (SPEC.md §B13.5). */
export type BuildPhase = "idle" | "adding" | "layout1" | "submitting" | "cutting" | "layout2" | "done";

export interface Pending {
  jobId: string;
  /** The path the job was started on. */
  from: string;
}

export interface OpenArgs {
  id: string;
  name: string;
  doc: Composition;
  postSlide: PostSlideSeed | null;
}

export interface EditOptions {
  /** Same non-empty key within 800 ms = one undo step (a slider drag, typing, a nudge). */
  key?: string;
  /** An automatic change (a collage build): doesn't count as the user moving things. */
  internal?: boolean;
}

export interface ComposerState {
  projectId: string | null;
  name: string;
  history: History<Composition> | null;
  /** The document being dragged on the stage (not recorded yet). */
  live: Composition | null;
  /** `live`, throttled to about 30 fps: what the bridge mirrors so pop-outs follow a drag. */
  liveOut: Composition | null;
  saveState: SaveState;
  /** Set when opened from a post. */
  postSlide: PostSlideSeed | null;
  selectedId: string | null;
  /** Every selected layer when several are (empty otherwise). */
  multi: string[];
  editingId: string | null;
  adjustBg: boolean;
  zoom: number;
  /** The layer whose crop dialog is open. */
  cropId: string | null;
  /** Layers waiting for a background-removal job. */
  pending: Record<string, Pending>;
  /** Progress text per pending layer ("queued", "42%"). */
  busyLabels: Record<string, string>;
  phase: BuildPhase;
  exporting: boolean;
  /** The user moved, scaled or rotated a layer (or chose a layout): a build must not rearrange it. Host only. */
  touched: boolean;

  open(args: OpenArgs): void;
  close(): void;
  setName(name: string): void;
  setSaveState(s: SaveState): void;
  /** Records the document `fn` returns. Host only (callbacks don't cross the bridge). */
  edit(fn: (d: Composition) => Composition, opts?: EditOptions): void;
  setLive(doc: Composition | null): void;
  /** Records a finished drag (or any whole document), ending the live preview. */
  commit(doc: Composition, key?: string): void;
  undo(): void;
  redo(): void;

  select(id: string | null, mods?: { toggle: boolean; range: boolean }): void;
  setEditing(id: string | null): void;
  setAdjustBg(on: boolean): void;
  setZoom(z: number): void;
  setCropId(id: string | null): void;

  patchLayer(id: string, patch: Partial<ComposerLayer>, key?: string): void;
  setText(id: string, text: string): void;
  deleteLayers(ids: string[]): void;
  duplicateLayer(id: string): void;
  reorderLayer(id: string, index: number): void;
  arrangeLayer(id: string, dir: MoveDirection): void;
  setBackground(bg: ComposerBackground): void;
  chooseBackground(): Promise<void>;
  setCanvas(patch: { aspect?: string; format?: "jpg" | "png" }): void;
  applyLayoutKind(kind: LayoutKind): void;
  shuffleLayout(): void;
  addPhotos(paths: string[], at?: { x: number; y: number }): Promise<void>;
  pickPhotos(): Promise<void>;
  addText(): void;
  removeBackgrounds(ids: string[]): Promise<void>;
  restoreOriginals(ids: string[]): void;
  /** "Use as this layer": the file replaces the layer's photo, keeping its transform. */
  replaceSource(layerId: string, path: string): Promise<void>;

  setPending(p: Record<string, Pending>): void;
  setBusyLabels(l: Record<string, string>): void;
  setPhase(p: BuildPhase): void;
  setExporting(on: boolean): void;
  setLayoutKind(k: LayoutKind): void;
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

export function toastError(title: string, e: unknown): void {
  const err = toAppError(e);
  toast({ title, description: err.hint ? `${err.message} ${err.hint}` : err.message, tone: "danger" });
}

const failShown = new Set<string>();

/** Toasts a failure once per batch, however many layers hit it. */
export function toastFailureOnce(title: string, description: string, tone: "danger" | "warn" = "danger"): void {
  const key = `${title}|${description}`;
  if (failShown.has(key)) return;
  failShown.add(key);
  toast({ title, description, tone });
}

/** Forgets which failures were shown (a batch ended). */
export function resetFailureToasts(): void {
  failShown.clear();
}

let layoutSeed = Date.now() % 100000;
let layoutKindNow: LayoutKind = "scatter";

function imageExts(): string[] {
  const exts = useModules.getState().byId[MODULE_ID]?.accepts.extensions;
  return exts && exts.length > 0 ? exts : IMAGE_EXTS;
}

const present = (s: ComposerState): Composition | null => s.history?.present ?? null;

export const LIVE_INTERVAL_MS = 33;

const liveClock = new WeakMap<object, { timer: ReturnType<typeof setTimeout> | undefined; last: number }>();

/** Mirrors `live` into `liveOut` at most every 33 ms (trailing); clearing is immediate. */
function scheduleLiveOut(
  live: Composition | null,
  set: (p: Partial<ComposerState>) => void,
  get: () => ComposerState,
): void {
  const clock = liveClock.get(set) ?? { timer: undefined, last: 0 };
  liveClock.set(set, clock);
  if (live === null) {
    if (clock.timer !== undefined) clearTimeout(clock.timer);
    clock.timer = undefined;
    set({ liveOut: null });
    return;
  }
  if (clock.timer !== undefined) return;
  const wait = Math.max(0, clock.last + LIVE_INTERVAL_MS - Date.now());
  const fire = (): void => {
    clock.timer = undefined;
    clock.last = Date.now();
    set({ liveOut: get().live });
  };
  if (wait === 0) fire();
  else clock.timer = setTimeout(fire, wait);
}

export const composerInitializer: StateCreator<ComposerState> = (set, get) => {
  const edit: ComposerState["edit"] = (fn, opts = {}) => {
    const h = get().history;
    if (!h) return;
    const next = fn(h.present);
    if (next === h.present) return;
    const touched = get().touched || (!opts.internal && geometryChanged(h.present, next));
    set({ history: pushHistory(h, next, opts.key ?? ""), touched });
  };

  return {
    projectId: null,
    name: "",
    history: null,
    live: null,
    liveOut: null,
    saveState: "idle",
    postSlide: null,
    selectedId: null,
    multi: [],
    editingId: null,
    adjustBg: false,
    zoom: 1,
    cropId: null,
    pending: {},
    busyLabels: {},
    phase: "idle",
    exporting: false,
    touched: false,

    open: ({ id, name, doc, postSlide }) => {
      layoutKindNow = "scatter";
      failShown.clear();
      set({
        projectId: id,
        name,
        history: newHistory(doc),
        live: null,
        liveOut: null,
        saveState: "idle",
        postSlide,
        selectedId: null,
        multi: [],
        editingId: null,
        adjustBg: false,
        zoom: 1,
        cropId: null,
        pending: {},
        busyLabels: {},
        phase: "idle",
        exporting: false,
        touched: false,
      });
      void adoptParkedHistory("photo-composer", id);
    },
    close: () =>
      set({
        projectId: null,
        name: "",
        history: null,
        live: null,
        liveOut: null,
        saveState: "idle",
        postSlide: null,
        selectedId: null,
        multi: [],
        editingId: null,
        adjustBg: false,
        cropId: null,
        pending: {},
        busyLabels: {},
        phase: "idle",
        exporting: false,
      }),
    setName: (name) => set({ name }),
    setSaveState: (saveState) => set({ saveState }),
    edit,
    setLive: (live) => {
      set({ live });
      scheduleLiveOut(live, set, get);
    },
    commit: (doc, key) => {
      scheduleLiveOut(null, set, get);
      set({ live: null, liveOut: null });
      edit(() => doc, { key });
    },
    undo: () => {
      const h = get().history;
      if (h) set({ history: undoH(h) });
    },
    redo: () => {
      const h = get().history;
      if (h) set({ history: redoH(h) });
    },

    select: (id, mods) => {
      const s = get();
      const doc = present(s);
      if (id && mods?.toggle) {
        const cur = s.multi.length > 1 ? s.multi : s.selectedId ? [s.selectedId] : [];
        const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
        set({ selectedId: next.length > 0 ? (next[next.length - 1] ?? null) : null, multi: next.length > 1 ? next : [] });
      } else if (id && mods?.range && s.selectedId && doc) {
        const order = layerList(doc).map((l) => l.id).reverse();
        const ids = idRange(order, s.selectedId, id);
        set({ selectedId: id, multi: ids.length > 1 ? ids : [] });
      } else {
        set({ selectedId: id, multi: [] });
      }
      if (id) set({ adjustBg: false });
    },
    setEditing: (editingId) => set({ editingId }),
    setAdjustBg: (adjustBg) => set({ adjustBg }),
    setZoom: (zoom) => set({ zoom }),
    setCropId: (cropId) => set({ cropId }),

    patchLayer: (id, patch, key) => edit((d) => updateLayer(d, id, patch), { key: key ?? `patch:${id}:${Object.keys(patch).sort().join(",")}` }),
    setText: (id, text) =>
      edit(
        (d) => {
          const l = findLayer(d, id);
          return l?.text ? updateLayer(d, id, { text: { ...l.text, text: Array.from(text).slice(0, MAX_TEXT_CHARS).join("") } }) : d;
        },
        { key: `text:${id}` },
      ),
    deleteLayers: (ids) => {
      edit((d) => ids.reduce(deleteLayer, d));
      const s = get();
      set({
        multi: s.multi.filter((x) => !ids.includes(x)).length > 1 ? s.multi.filter((x) => !ids.includes(x)) : [],
        selectedId: s.selectedId && ids.includes(s.selectedId) ? null : s.selectedId,
        editingId: s.editingId && ids.includes(s.editingId) ? null : s.editingId,
      });
    },
    duplicateLayer: (id) => {
      const d = present(get());
      if (!d) return;
      const r = duplicateLayerDoc(d, id);
      if (!r.id) {
        toast({ title: `At most ${MAX_LAYERS} layers`, tone: "warn" });
        return;
      }
      edit(() => r.doc);
      set({ selectedId: r.id, multi: [] });
    },
    reorderLayer: (id, index) => edit((d) => reorderLayerDoc(d, id, index)),
    arrangeLayer: (id, dir) => edit((d) => moveLayer(d, id, dir)),
    setBackground: (bg) => edit((d) => ({ ...d, background: bg }), { key: "background" }),
    chooseBackground: async () => {
      try {
        const paths = (await FilesService.PickWith("Choose a background photo", imageExts(), false)) ?? [];
        const path = paths[0];
        if (!path) return;
        edit((d) => ({ ...d, background: { ...d.background, kind: "image", image: { path, original: "" }, panX: 0, panY: 0, zoom: 1 } }));
      } catch (e) {
        toastError("Couldn't open the file picker", e);
      }
    },
    setCanvas: (patch) =>
      edit((d) => {
        let next = d;
        if (patch.aspect && patch.aspect !== d.aspect) {
          const a = aspectSize(patch.aspect);
          next = { ...next, aspect: a.id, width: a.width, height: a.height };
        }
        if (patch.format && patch.format !== d.format) next = { ...next, format: patch.format };
        return next;
      }),

    applyLayoutKind: (kind) => {
      layoutKindNow = kind;
      layoutSeed += 1;
      const before = get().history?.present;
      const images = composerImages();
      edit((d) => applyLayout(d, kind, layoutSeed, undefined, (l) => layerSize(d, l, images)));
      if (get().history?.present === before) toast({ title: "Add some photos first", tone: "neutral" });
    },
    shuffleLayout: () => get().applyLayoutKind(layoutKindNow),
    addPhotos: async (paths, at) => {
      let n = 0;
      // Decode everything in parallel first (HEIC goes through the engine), then add the layers in the given order.
      const first = present(get());
      if (!first) return;
      const room = Math.max(0, MAX_LAYERS - layerList(first).length);
      const loaded = await loadImages(paths.slice(0, room));
      for (const path of paths) {
        const d = present(get());
        if (!d) return;
        if (layerList(d).length >= MAX_LAYERS) {
          toast({ title: `At most ${MAX_LAYERS} layers`, tone: "warn" });
          return;
        }
        try {
          // Photos past the room we preloaded (earlier ones failed) load now.
          if (loaded.failed.has(path)) throw new Error(loaded.failed.get(path));
          const bmp = loaded.images.get(path) ?? (await loadImage(path));
          const { w, h } = imageSize(bmp);
          let layer = newImageLayer(path, w, h, present(get()) ?? d);
          if (at) {
            const fan = n * 0.03;
            layer = { ...layer, x: Math.min(1, at.x + fan), y: Math.min(1, at.y + fan) };
          }
          n++;
          const added = layer;
          edit((cur) => addLayer(cur, added));
          set({ selectedId: layer.id, multi: [] });
        } catch (e) {
          toastError(`Couldn't add ${baseName(path)}`, e);
        }
      }
    },
    pickPhotos: async () => {
      try {
        const paths = (await FilesService.PickWith("Add photos", imageExts(), true)) ?? [];
        if (paths.length > 0) await get().addPhotos(paths);
      } catch (e) {
        toastError("Couldn't open the file picker", e);
      }
    },
    addText: () => {
      const d = present(get());
      if (!d) return;
      const layer = newTextLayer(d);
      edit((cur) => addLayer(cur, layer));
      set({ selectedId: layer.id, multi: [], editingId: layer.id });
    },

    removeBackgrounds: async (ids) => {
      for (const id of ids) {
        const d = present(get());
        const path = d ? findLayer(d, id)?.image?.ref.path : undefined;
        if (!path || get().pending[id]) continue;
        try {
          const job = await ComposerService.RemoveBackground(path);
          useJobs.getState().upsert(job);
          set({ pending: { ...get().pending, [id]: { jobId: job.id, from: path } } });
        } catch (e) {
          const err = toAppError(e);
          toastFailureOnce("Couldn't remove the background", err.hint ? `${err.message} ${err.hint}` : err.message);
        }
      }
    },
    restoreOriginals: (ids) =>
      edit((d) => {
        let acc = d;
        for (const id of ids) {
          const orig = findLayer(acc, id)?.image?.ref.original;
          if (orig) acc = setLayerSource(acc, id, orig, "");
        }
        return acc;
      }),
    replaceSource: async (layerId, path) => {
      try {
        const infos = (await FilesService.Stat([path])) ?? [];
        if (!infos[0]?.exists) {
          toast({ title: "That file is gone", description: baseName(path), tone: "warn" });
          return;
        }
      } catch (e) {
        toastError("Couldn't check the file", e);
        return;
      }
      edit((d) => {
        const l = findLayer(d, layerId);
        if (!l?.image) return d;
        // Keep a way back: the photo it had becomes the "original" unless it already had one.
        const next = setLayerSource(d, layerId, path, l.image.ref.original || l.image.ref.path);
        const name = nameAfterSourceChange(l.name, l.image.ref.path, l.image.ref.original, path);
        return name === l.name ? next : updateLayer(next, layerId, { name });
      });
    },

    setPending: (pending) => set({ pending }),
    setBusyLabels: (busyLabels) => set({ busyLabels }),
    setPhase: (phase) => set({ phase }),
    setExporting: (exporting) => set({ exporting }),
    setLayoutKind: (k) => {
      layoutKindNow = k;
    },
  };
};

/** The window's store. Tests build their own with `createStore(composerInitializer)`. */
export const useComposer = create<ComposerState>(composerInitializer);

// Undo history survives popping the whole tool out and bringing it back (lib/parkedHistory.ts).
registerHistory("photo-composer", ["photo-composer"], {
  docId: () => useComposer.getState().projectId,
  read: () => {
    const h = useComposer.getState().history;
    return h ? { past: h.past, future: h.future } : null;
  },
  write: ({ past, future }) => {
    const h = useComposer.getState().history;
    if (h) useComposer.setState({ history: { ...h, past: past as Composition[], future: future as Composition[] } });
  },
  subscribe: (cb) =>
    useComposer.subscribe((s, prev) => {
      if (s.history !== prev.history) cb();
    }),
});


// ---- hooks (stable references) ----

/** The document on screen: the live drag preview, else the recorded one. */
export function useDoc(): Composition | null {
  const live = useComposer((s) => s.live);
  const rec = useComposer((s) => s.history?.present ?? null);
  return live ?? rec;
}

/** The selected layers in selection order (several when multi-selected). */
export function useSelectedLayers(): ComposerLayer[] {
  const doc = useDoc();
  const selectedId = useComposer((s) => s.selectedId);
  const multi = useComposer((s) => s.multi);
  return useMemo(() => {
    if (!doc) return [];
    const ids = multi.length > 1 ? multi : selectedId ? [selectedId] : [];
    return ids.map((id) => findLayer(doc, id)).filter((l): l is ComposerLayer => !!l);
  }, [doc, multi, selectedId]);
}

export const undoDepth = (s: ComposerState): number => s.history?.past.length ?? 0;
export const redoDepth = (s: ComposerState): number => s.history?.future.length ?? 0;
