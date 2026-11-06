/**
 * Post Builder state (Phase 11, SPEC §5.2): the open post and everything about
 * editing it, in one zustand store so the panels and the phone preview can
 * render in the tool, in a click-in drawer or popped out in their own window
 * (`workspace.tsx` bridges it).
 *
 * The window that shows the tool is the host: it loads, autosaves, exports and
 * runs the handoffs. Part windows hold replicas whose bridged actions run on
 * the host, so every bridged action takes JSON-serialisable arguments (ids,
 * patches, plain values; never callbacks). A replica never saves or exports.
 */
import { useMemo } from "react";
import { create, type StateCreator } from "zustand";
import { toast } from "@/components";
import {
  ComposerService,
  FilesService,
  PostsService,
  SettingsService,
  VideoEditorService,
  type PostIssue,
  type PostLimits,
  type PostSlide,
  type ProjectInfo,
} from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { adoptParkedHistory, registerHistory } from "@/lib/parkedHistory";
import { newHistory, pushHistory, redo as redoH, undo as undoH, type History } from "@/lib/history";
import { openTool } from "@/lib/openTool";
import { useUI, type SlideBuild } from "@/state/ui";
import {
  DEFAULT_LIMITS,
  PENDING_PROJECT,
  blankSlide,
  docForSave,
  duplicateSlide,
  isPending,
  maxClipMs,
  normalizePost,
  reorder,
  roomLeft,
  sanitizeState,
  slidesFromSources,
  type PostBuilderState,
  type PostDoc,
} from "./logic";
import { insertAt, type StripDrop } from "./pool";

export const MODULE_ID = "post-builder";
export const AUTOSAVE_MS = 800;
export const CHECK_MS = 300;

export type SaveState = "saved" | "dirty" | "saving" | "error";

export interface Still {
  id: string;
  ms: number;
}

/** The framing a slide has while it is dragged. */
export interface LiveFraming {
  id: string;
  patch: Partial<Pick<PostSlide, "zoom" | "panX" | "panY">>;
}

export interface PostState {
  /** The posts list and the module state are loaded (host only). */
  ready: boolean;
  posts: ProjectInfo[];
  /** The open post ("" = none). */
  postId: string;
  limits: PostLimits;
  /** Photo Composer / Sequence Editor projects a slide can link to. */
  comps: ProjectInfo[];
  videos: ProjectInfo[];
  /** Host only. */
  pstate: PostBuilderState;
  history: History<PostDoc> | null;
  /** The id of the post `history` belongs to (empty while another one loads). */
  loadedId: string;
  name: string;
  loading: boolean;
  loadError: string;
  issues: PostIssue[];
  saveState: SaveState;
  /** Unsaved edits exist (host only). */
  dirty: boolean;
  selectedId: string;
  /** The frame shown while a clip is trimmed. */
  still: Still | null;
  /** A framing drag in progress on a slide (not recorded yet: no undo step, no autosave). */
  liveFraming: LiveFraming | null;
  /** `liveFraming` throttled to about 30 fps: what the bridge mirrors so pop-outs follow a drag. */
  liveFramingOut: LiveFraming | null;

  // ---- host only ----
  init(): Promise<void>;
  openPost(id: string): Promise<void>;
  load(id: string, silent: boolean): Promise<void>;
  save(): Promise<void>;
  flush(): Promise<void>;
  reload(): Promise<void>;
  reset(): void;
  setIssues(issues: PostIssue[]): void;
  persist(next: PostBuilderState): void;
  refreshProjects(): Promise<void>;
  /** Records the document `fn` returns (callbacks don't cross the bridge). Same non-empty key within 800 ms = one undo step. */
  edit(fn: (d: PostDoc) => PostDoc, key?: string): void;
  appendSlides(slides: PostSlide[], at?: number): void;
  replaceSource(slideId: string, path: string): Promise<void>;
  /** "Use for this slide": the file replaces the slide's photo, keeping its framing. */
  usePhoto(slideId: string, path: string): Promise<void>;
  dropSources(paths: string[], drop: StripDrop): void;
  newProjectSlide(kind: "composition" | "video"): Promise<void>;
  addExisting(projectId: string, kind: "composition" | "video"): void;
  editSlide(slideId: string, where?: "here" | "window"): Promise<void>;
  setPendingSelect(id: string): void;
  ensureSelection(): void;

  // ---- bridged (replicas forward these to the host) ----
  undo(): void;
  redo(): void;
  select(id: string): void;
  setStill(still: Still | null): void;
  /** Host: shows a framing drag without recording it. `null` ends it. */
  setLiveFraming(live: LiveFraming | null): void;
  /** Host: records the finished drag as one undo step. */
  commitFraming(id: string, patch: LiveFraming["patch"]): void;
  patchSlide(id: string, patch: Partial<PostSlide>, key?: string): void;
  patchDoc(patch: Partial<PostDoc>, key?: string): void;
  setCaption(text: string): void;
  setAltText(id: string, text: string): void;
  deleteSlide(id: string): void;
  copySlide(id: string): void;
  reorderSlides(from: number, to: number): void;
  addPaths(paths: string[], at?: number): Promise<void>;
  buildSlide(inputs: string[], build: SlideBuild): Promise<void>;
  createPost(name: string, format: string, aspect: string, paths: string[]): Promise<string>;
  createFromFolder(name: string, format: string, aspect: string, folder: string, subfolders: boolean): Promise<string>;
  duplicatePost(id: string): Promise<void>;
  renamePost(id: string, name: string): Promise<void>;
  deletePost(id: string): Promise<void>;
}


export function fail(e: unknown): void {
  const err = toAppError(e);
  toast({ tone: "danger", title: err.message, description: err.hint });
}

// ---- module-level host state (never bridged) ----
let timer: ReturnType<typeof setTimeout> | undefined;
let inflight: Promise<void> = Promise.resolve();
/** Bumped by `reset`: late results of an earlier session are dropped. */
let session = 0;
let pendingSelect = "";
let editingElsewhere = false;

/** A slide was sent to an editing window: refresh from disk when it closes or this window is focused. */
export const isEditingElsewhere = (): boolean => editingElsewhere;
export const setEditingElsewhere = (on: boolean): void => {
  editingElsewhere = on;
};

const upsert = (list: ProjectInfo[], info: ProjectInfo): ProjectInfo[] => (list.some((p) => p.id === info.id) ? list.map((p) => (p.id === info.id ? info : p)) : [info, ...list]);

const fullMessage = (doc: PostDoc, limits: PostLimits): string => (doc.format === "reel" ? "A reel is one video" : `A post holds at most ${limits.maxSlides} slides`);

export const LIVE_INTERVAL_MS = 33;
const liveClock: { timer: ReturnType<typeof setTimeout> | undefined; last: number } = { timer: undefined, last: 0 };

const EMPTY_POST = { liveFraming: null, liveFramingOut: null, history: null, loadedId: "", name: "", issues: [] as PostIssue[], saveState: "saved" as SaveState, dirty: false, selectedId: "", still: null, loadError: "" };

const presentDoc = (s: PostState): PostDoc | null => (s.postId && s.loadedId === s.postId ? (s.history?.present ?? null) : null);

export const postInitializer: StateCreator<PostState> = (set, get) => {
  const markDirty = (): void => {
    set({ dirty: true, saveState: "dirty" });
    clearTimeout(timer);
    timer = setTimeout(() => void get().save().catch(() => undefined), AUTOSAVE_MS);
  };

  /** Mirrors `liveFraming` into `liveFramingOut` at most every 33 ms (trailing); clearing is immediate. */
  const mirrorLive = (live: LiveFraming | null): void => {
    if (live === null) {
      if (liveClock.timer !== undefined) clearTimeout(liveClock.timer);
      liveClock.timer = undefined;
      set({ liveFramingOut: null });
      return;
    }
    if (liveClock.timer !== undefined) return;
    const wait = Math.max(0, liveClock.last + LIVE_INTERVAL_MS - Date.now());
    const fire = (): void => {
      liveClock.timer = undefined;
      liveClock.last = Date.now();
      set({ liveFramingOut: get().liveFraming });
    };
    if (wait === 0) fire();
    else liveClock.timer = setTimeout(fire, wait);
  };

  const edit: PostState["edit"] = (fn, key = "") => {
    const h = get().history;
    if (!h) return;
    const next = fn(h.present);
    if (next === h.present) return;
    set({ history: pushHistory(h, next, key) });
    markDirty();
  };

  const addCreated = (info: ProjectInfo): Promise<void> => {
    set((s) => ({ posts: [info, ...s.posts.filter((p) => p.id !== info.id)] }));
    return get().openPost(info.id);
  };

  return {
    ready: false,
    posts: [],
    postId: "",
    limits: DEFAULT_LIMITS,
    comps: [],
    videos: [],
    pstate: { lastPostId: "", exports: {} },
    ...EMPTY_POST,
    loading: false,

    reset: () => {
      session++;
      clearTimeout(timer);
      clearTimeout(liveClock.timer);
      liveClock.timer = undefined;
      liveClock.last = 0;
      inflight = Promise.resolve();
      pendingSelect = "";
      editingElsewhere = false;
      set({ ready: false, posts: [], postId: "", limits: DEFAULT_LIMITS, comps: [], videos: [], pstate: { lastPostId: "", exports: {} }, ...EMPTY_POST, loading: false });
    },

    refreshProjects: async () => {
      const my = session;
      const [c, v] = await Promise.all([ComposerService.List().catch(() => null), VideoEditorService.List().catch(() => null)]);
      if (my === session) set({ comps: c ?? [], videos: v ?? [] });
    },

    init: async () => {
      const my = session;
      const [list, lim, raw] = await Promise.all([
        PostsService.List().catch(() => null),
        PostsService.Limits().catch(() => null),
        SettingsService.ModuleState(MODULE_ID).catch(() => ""),
      ]);
      await get().refreshProjects();
      if (my !== session) return;
      let saved: PostBuilderState = { lastPostId: "", exports: {} };
      try {
        if (raw) saved = sanitizeState(JSON.parse(raw) as unknown);
      } catch {
        /* unreadable state */
      }
      const all = list ?? [];
      set({ posts: all, limits: lim ?? DEFAULT_LIMITS, pstate: saved, ready: true });
      const target = all.find((p) => p.id === saved.lastPostId)?.id ?? all[0]?.id ?? "";
      // The same post is still open (the tool was left and came back): reload it, keeping its undo history.
      if (target && get().postId === target && get().history) await get().load(target, true);
      else await get().openPost(target);
    },

    persist: (next) => {
      set({ pstate: next });
      SettingsService.SetModuleState(MODULE_ID, JSON.stringify(next)).catch(() => undefined);
    },

    setIssues: (issues) => set({ issues }),

    save: () => {
      clearTimeout(timer);
      const s = get();
      const doc = s.history?.present;
      if (!s.dirty || !doc || !s.postId || s.loadedId !== s.postId) return inflight;
      const { postId: id, name } = s;
      const my = session;
      set({ dirty: false, saveState: "saving" });
      const run = inflight
        .catch(() => undefined)
        .then(() => PostsService.Save(id, name, docForSave(doc)))
        .then((info) => {
          if (my !== session) return;
          set((st) => ({ posts: upsert(st.posts, info) }));
          if (get().postId === id) set((st) => ({ saveState: st.dirty ? "dirty" : "saved" }));
        })
        .catch((e) => {
          if (my === session && get().postId === id) set({ dirty: true, saveState: "error" });
          throw e;
        });
      inflight = run.catch(() => undefined);
      return run;
    },

    flush: () => get().save(),

    load: async (id, silent) => {
      if (!id) return;
      const my = session;
      const current = (): boolean => my === session && get().postId === id;
      if (!silent) set({ loading: true });
      set({ loadError: "" });
      try {
        const [post, list] = await Promise.all([PostsService.Get(id), PostsService.List()]);
        if (!current()) return;
        const d = normalizePost(post);
        const info = (list ?? []).find((p) => p.id === id);
        set({ history: reloadedHistory(get().history, get().loadedId === id, d), name: info?.name ?? get().name, dirty: false, loadedId: id, saveState: "saved" });
        void adoptParkedHistory(MODULE_ID, id);
      } catch (e) {
        if (current()) set({ loadError: toAppError(e).message });
      } finally {
        if (current()) set({ loading: false });
      }
    },

    // Switching posts: save the old one first, then load the new one.
    openPost: async (id) => {
      const prev = get().postId;
      if (id === prev && get().history) return;
      const my = session;
      if (prev && prev !== id) await get().save().catch(() => undefined);
      if (my !== session) return;
      clearTimeout(timer);
      set({ postId: id, ...EMPTY_POST });
      if (id) await get().load(id, false);
    },

    reload: async () => {
      await get().save().catch(() => undefined);
      await get().load(get().postId, true);
    },

    edit,

    undo: () => {
      const h = get().history;
      if (!h || h.past.length === 0) return;
      set({ history: undoH(h) });
      markDirty();
    },
    redo: () => {
      const h = get().history;
      if (!h || h.future.length === 0) return;
      set({ history: redoH(h) });
      markDirty();
    },

    select: (id) => set({ selectedId: id }),
    setStill: (still) => set({ still }),
    setLiveFraming: (live) => {
      set({ liveFraming: live });
      mirrorLive(live);
    },
    commitFraming: (id, patch) => {
      mirrorLive(null);
      set({ liveFraming: null, liveFramingOut: null });
      get().patchSlide(id, patch, "");
    },
    setPendingSelect: (id) => {
      pendingSelect = id;
    },
    ensureSelection: () => {
      const doc = presentDoc(get());
      if (!doc) return;
      if (pendingSelect) {
        const want = pendingSelect;
        pendingSelect = "";
        if (doc.slides.some((s) => s.id === want)) {
          set({ selectedId: want });
          return;
        }
      }
      if (!doc.slides.some((s) => s.id === get().selectedId)) set({ selectedId: doc.slides[0]?.id ?? "" });
    },

    patchSlide: (id, patch, key) => {
      edit((d) => ({ ...d, slides: d.slides.map((s) => (s.id === id ? { ...s, ...patch } : s)) }), key ?? `slide:${id}:${Object.keys(patch).sort().join(",")}`);
    },
    patchDoc: (patch, key) => edit((d) => ({ ...d, ...patch }), key ?? `doc:${Object.keys(patch).sort().join(",")}`),
    setCaption: (text) => edit((d) => ({ ...d, caption: text }), "doc:caption"),
    setAltText: (id, text) => get().patchSlide(id, { altText: text }),

    usePhoto: async (slideId, path) => {
      const slide = presentDoc(get())?.slides.find((s) => s.id === slideId);
      if (!slide || slide.kind !== "photo" || !path) return;
      const info = ((await FilesService.Stat([path]).catch(() => null)) ?? [])[0];
      if (!info?.exists) {
        toast({ title: "That file is gone", description: path.split(/[\/]/).pop() ?? path, tone: "warn" });
        return;
      }
      edit((d) => ({ ...d, slides: d.slides.map((s) => (s.id === slideId ? { ...s, path } : s)) }), "");
    },

    appendSlides: (slides, at) => {
      if (slides.length === 0) return;
      edit((d) => ({ ...d, slides: at === undefined ? [...d.slides, ...slides] : insertAt(d.slides, at, slides) }));
      set({ selectedId: slides[0]!.id });
    },

    deleteSlide: (id) => {
      const doc = presentDoc(get());
      if (!doc) return;
      const i = doc.slides.findIndex((s) => s.id === id);
      const next = doc.slides[i + 1] ?? doc.slides[i - 1];
      edit((d) => ({ ...d, slides: d.slides.filter((s) => s.id !== id) }));
      set({ selectedId: next?.id ?? "" });
    },
    copySlide: (id) => {
      const s = get();
      const doc = presentDoc(s);
      if (!doc || doc.slides.length >= s.limits.maxSlides) return;
      const i = doc.slides.findIndex((x) => x.id === id);
      const src = doc.slides[i];
      if (!src) return;
      const copy = duplicateSlide(src);
      edit((d) => ({ ...d, slides: [...d.slides.slice(0, i + 1), copy, ...d.slides.slice(i + 1)] }));
      set({ selectedId: copy.id });
    },
    reorderSlides: (from, to) => edit((d) => ({ ...d, slides: reorder(d.slides, from, to) })),

    addPaths: async (paths, at) => {
      const { limits } = get();
      const doc = presentDoc(get());
      if (!doc || paths.length === 0) return;
      const room = roomLeft(doc, limits);
      if (room === 0) {
        toast({ tone: "warn", title: fullMessage(doc, limits) });
        return;
      }
      try {
        const sources = (await PostsService.SlideInfo(paths)) ?? [];
        const { slides, skipped } = slidesFromSources(sources, doc.format, limits);
        const take = slides.slice(0, room);
        if (skipped > 0) toast({ tone: "warn", title: `Skipped ${skipped} ${skipped === 1 ? "file" : "files"} that aren't photos or videos` });
        if (take.length < slides.length) toast({ tone: "warn", title: `Only ${take.length} more fit in this post` });
        get().appendSlides(take, at);
      } catch (e) {
        fail(e);
      }
    },

    /** A source dropped on a photo or clip slide takes its place (framing starts over). */
    replaceSource: async (slideId, path) => {
      const { limits } = get();
      const doc = presentDoc(get());
      if (!doc) return;
      try {
        const src = ((await PostsService.SlideInfo([path])) ?? [])[0];
        if (!src || src.error || (src.kind !== "photo" && src.kind !== "clip")) {
          toast({ tone: "warn", title: src?.error || "That file isn't a photo or video" });
          return;
        }
        if (doc.format === "reel" && src.kind !== "clip") {
          toast({ tone: "warn", title: "A reel is one video" });
          return;
        }
        const kind = src.kind;
        const outMs = kind === "clip" ? Math.max(1, Math.min(src.durationMs, maxClipMs(limits, doc.format))) : 0;
        get().patchSlide(slideId, { kind, path: src.path, panX: 0, panY: 0, zoom: 1, rotation: 0, inMs: 0, outMs }, "");
        set({ selectedId: slideId });
      } catch (e) {
        fail(e);
      }
    },

    dropSources: (paths, drop) => {
      const d = presentDoc(get());
      if (!d || paths.length === 0) return;
      if (drop.kind === "replace") {
        const slide = d.slides[drop.index];
        if (!slide) return;
        if (paths.length > 1) toast({ title: "Used the first of the sources for this slide" });
        void get().replaceSource(slide.id, paths[0]!);
      } else {
        void get().addPaths(paths, drop.index);
      }
    },

    /** Make a collage / stitch: a new composition or video slide, then the editor builds it from the sources. */
    buildSlide: async (inputs, build) => {
      const { limits, postId } = get();
      const doc = presentDoc(get());
      if (!doc || inputs.length === 0) return;
      if (roomLeft(doc, limits) === 0) {
        toast({ tone: "warn", title: fullMessage(doc, limits) });
        return;
      }
      const kind = build.kind === "collage" ? "composition" : "video";
      const slide = blankSlide(kind, { projectId: PENDING_PROJECT });
      get().appendSlides([slide]);
      try {
        await get().flush();
      } catch (e) {
        fail(e);
        return;
      }
      useUI.getState().handOff({
        moduleId: kind === "composition" ? "photo-composer" : "video-editor",
        inputs,
        postSlide: { postId, slideId: slide.id, aspect: doc.aspect, projectId: "", build },
      });
    },

    /** Hands a slide to Photo Composer or the Sequence Editor (after saving, so the editor links to what's on disk). */
    editSlide: async (slideId, where = "here") => {
      const { postId } = get();
      const doc = presentDoc(get());
      const slide = doc?.slides.find((s) => s.id === slideId);
      if (!doc || !slide) return;
      try {
        await get().flush();
      } catch (e) {
        fail(e);
        return;
      }
      const target = slide.kind === "composition" ? "photo-composer" : "video-editor";
      if (where === "window") editingElsewhere = true;
      await openTool(target, [], { postSlide: { postId, slideId: slide.id, aspect: doc.aspect, projectId: isPending(slide) ? "" : slide.projectId } }, { window: where === "window" });
    },

    newProjectSlide: async (kind) => {
      const { limits } = get();
      const doc = presentDoc(get());
      if (!doc) return;
      if (roomLeft(doc, limits) === 0) {
        toast({ tone: "warn", title: fullMessage(doc, limits) });
        return;
      }
      // Saved with a placeholder id: the editor replaces it on its first save.
      const slide = blankSlide(kind, { projectId: PENDING_PROJECT });
      get().appendSlides([slide]);
      await get().editSlide(slide.id);
    },

    addExisting: (projectId, kind) => get().appendSlides([blankSlide(kind, { projectId })]),

    createPost: async (name, format, aspect, paths) => {
      try {
        const info = await PostsService.Create(name, format, aspect, paths);
        await addCreated(info);
        return info.id;
      } catch (e) {
        fail(e);
        return "";
      }
    },
    createFromFolder: async (name, format, aspect, folder, subfolders) => {
      try {
        const info = await PostsService.CreateFromFolder(name, format, aspect, folder, subfolders);
        await addCreated(info);
        return info.id;
      } catch (e) {
        fail(e);
        return "";
      }
    },
    duplicatePost: async (id) => {
      try {
        await get().flush();
        const info = await PostsService.Duplicate(id);
        await addCreated(info);
      } catch (e) {
        fail(e);
      }
    },
    renamePost: async (id, name) => {
      try {
        if (id === get().postId) {
          set((s) => ({ name, posts: s.posts.map((p) => (p.id === id ? { ...p, name } : p)) }));
          markDirty();
        } else {
          const d = await PostsService.Get(id);
          const info = await PostsService.Save(id, name, d);
          set((s) => ({ posts: upsert(s.posts, info) }));
        }
      } catch (e) {
        fail(e);
      }
    },
    deletePost: async (id) => {
      try {
        await PostsService.Delete(id);
        const rest = get().posts.filter((p) => p.id !== id);
        set({ posts: rest });
        if (id === get().postId) {
          // The deleted post must not be saved again.
          clearTimeout(timer);
          set({ dirty: false });
          await get().openPost(rest[0]?.id ?? "");
        }
      } catch (e) {
        fail(e);
      }
    },
  };
};

/**
 * The history after (re)loading a post. The same post keeps its undo steps: the
 * loaded document becomes one more step when it differs from the one in memory
 * (an editing window changed a slide), and nothing when it doesn't.
 */
export function reloadedHistory(h: History<PostDoc> | null, samePost: boolean, loaded: PostDoc): History<PostDoc> {
  if (!h || !samePost) return newHistory(loaded);
  if (JSON.stringify(docForSave(h.present)) === JSON.stringify(docForSave(loaded))) return h;
  return pushHistory(h, loaded, "");
}

export const usePostBuilder = create<PostState>(postInitializer);

// Undo history survives popping the whole tool out and bringing it back (lib/parkedHistory.ts).
registerHistory(MODULE_ID, [MODULE_ID], {
  docId: () => {
    const s = usePostBuilder.getState();
    return s.postId && s.loadedId === s.postId ? s.postId : null;
  },
  read: () => {
    const h = usePostBuilder.getState().history;
    return h ? { past: h.past, future: h.future } : null;
  },
  write: ({ past, future }) => {
    const h = usePostBuilder.getState().history;
    if (h) usePostBuilder.setState({ history: { ...h, past: past as PostDoc[], future: future as PostDoc[] } });
  },
  subscribe: (cb) =>
    usePostBuilder.subscribe((s, prev) => {
      if (s.history !== prev.history) cb();
    }),
});

// ---- selectors with stable references ----

/** The open post's document (null while it loads). */
export function useRecordedDoc(): PostDoc | null {
  return usePostBuilder(presentDoc);
}

/** The document on screen: the recorded one with the framing drag in progress applied. */
export function useDoc(): PostDoc | null {
  const doc = useRecordedDoc();
  const live = usePostBuilder((s) => s.liveFraming);
  return useMemo(() => withLiveFraming(doc, live), [doc, live]);
}

export function withLiveFraming(doc: PostDoc | null, live: LiveFraming | null): PostDoc | null {
  if (!doc || !live || !doc.slides.some((s) => s.id === live.id)) return doc;
  return { ...doc, slides: doc.slides.map((s) => (s.id === live.id ? { ...s, ...live.patch } : s)) };
}

export function useSelectedSlide(): { slide: PostSlide | undefined; index: number } {
  const doc = useDoc();
  const id = usePostBuilder((s) => s.selectedId);
  return useMemo(() => {
    const index = doc ? doc.slides.findIndex((s) => s.id === id) : -1;
    return { slide: index >= 0 ? doc?.slides[index] : undefined, index };
  }, [doc, id]);
}

/** Photo Composer and Sequence Editor projects by id (slides link to them). */
export function useProjects(): Map<string, ProjectInfo> {
  const comps = usePostBuilder((s) => s.comps);
  const videos = usePostBuilder((s) => s.videos);
  return useMemo(() => new Map([...comps, ...videos].map((p) => [p.id, p])), [comps, videos]);
}

/** The fields of `next` that differ from `prev` (a patch the bridge can carry). */
export function diffDoc(prev: PostDoc, next: PostDoc): Partial<PostDoc> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(next) as (keyof PostDoc)[]) {
    if (!Object.is(prev[k], next[k])) out[k] = next[k];
  }
  return out as Partial<PostDoc>;
}
