import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useElementSize } from "@/lib/useElementSize";
import { Button, ConfirmDialog, DropZone, EmptyState, Meter, Spinner, Tooltip, toast, type MenuItem } from "@/components";
import {
  ComposerService,
  FilesService,
  JobStatus,
  LibraryService,
  PostsService,
  SettingsService,
  VideoEditorService,
  type PostLimits,
  type PostSlide,
  type ProjectInfo,
} from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { isActive, useJob, useJobs } from "@/state/jobs";
import { useUI, type Handoff, type SlideBuild } from "@/state/ui";
import type { ToolViewProps } from "../index";
import { NameDialog, NewPostDialog, ProjectPickerDialog } from "./dialogs";
import { addExtras, folderBaseName, insertAt, type StripDrop } from "./pool";
import { MEDIA_EXTS as SOURCE_EXTS, SourcesPanel } from "./SourcesPanel";
import { PhonePreview } from "./PhonePreview";
import { PostsStrip } from "./PostsStrip";
import { AltPanel, CaptionPanel, ChecksPanel, ShapePanel, copyText } from "./SidePanel";
import { SlideStage } from "./SlideStage";
import { SlideStrip } from "./SlideStrip";
import {
  DEFAULT_LIMITS,
  PENDING_PROJECT,
  blankSlide,
  defaultPostName,
  duplicateSlide,
  firstError,
  isPending,
  issuesBySlide,
  reorder,
  maxClipMs,
  roomLeft,
  sanitizeState,
  SOURCES_DEFAULT,
  bodyLayout,
  slidesFromSources,
  type PostBuilderState,
  type PostDoc,
} from "./logic";
import { NEW_POST, useAddToPost, usePostDrop } from "./store";
import { usePostEditor, type SaveState } from "./usePostEditor";
import styles from "./PostBuilderView.module.css";

const MEDIA_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".mp4", ".mov", ".mkv", ".webm", ".m4v"];
const SAVE_LABEL: Record<SaveState, string> = { saved: "Saved", dirty: "Unsaved changes", saving: "Saving…", error: "Couldn't save" };

type Dialog =
  | { kind: "new" }
  | { kind: "rename"; id: string }
  | { kind: "delete"; id: string }
  | { kind: "pick"; project: "composition" | "video" }
  | null;

interface ExportOutcome {
  folder: string;
}

function parseExport(json: string): ExportOutcome | null {
  try {
    const r = JSON.parse(json) as { folder?: unknown };
    return typeof r.folder === "string" ? { folder: r.folder } : null;
  } catch {
    return null;
  }
}

function fail(e: unknown): void {
  const err = toAppError(e);
  toast({ tone: "danger", title: err.message, description: err.hint });
}

export default function PostBuilderView({ moduleId }: ToolViewProps) {
  const [posts, setPosts] = useState<ProjectInfo[]>([]);
  const [postId, setPostId] = useState("");
  const [ready, setReady] = useState(false);
  const [limits, setLimits] = useState<PostLimits>(DEFAULT_LIMITS);
  const [comps, setComps] = useState<ProjectInfo[]>([]);
  const [videos, setVideos] = useState<ProjectInfo[]>([]);
  const [pstate, setPstate] = useState<PostBuilderState>({ lastPostId: "", exports: {} });
  const [selectedId, setSelectedId] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);
  const [sourcesForced, setSourcesForced] = useState(false);
  const bodyWidth = useElementSize(bodyEl).width;
  const layout = bodyLayout(bodyWidth, { width: pstate.sourcesWidth ?? SOURCES_DEFAULT, collapsed: !!pstate.sourcesCollapsed, forcedOpen: sourcesForced });
  const [newFiles, setNewFiles] = useState<string[]>([]);
  const [jobId, setJobId] = useState("");
  const [exporting, setExporting] = useState(false);

  const onSaved = useCallback((info: ProjectInfo) => {
    setPosts((list) => (list.some((p) => p.id === info.id) ? list.map((p) => (p.id === info.id ? info : p)) : [info, ...list]));
  }, []);
  const editor = usePostEditor(postId, onSaved);
  const doc: PostDoc | null = editor.loadedId === postId && postId ? editor.doc : null;
  const { update } = editor;

  const projects = useMemo(() => new Map([...comps, ...videos].map((p) => [p.id, p])), [comps, videos]);
  const slideIssues = useMemo(() => issuesBySlide(editor.issues), [editor.issues]);
  const docRef = useRef(doc);
  docRef.current = doc;
  const selected = doc?.slides.find((s) => s.id === selectedId);
  const selectedIndex = doc ? doc.slides.findIndex((s) => s.id === selectedId) : -1;

  // ---- module state ----
  const pstateRef = useRef(pstate);
  pstateRef.current = pstate;
  const persist = useCallback(
    (next: PostBuilderState) => {
      setPstate(next);
      SettingsService.SetModuleState(moduleId, JSON.stringify(next)).catch(() => undefined);
    },
    [moduleId],
  );

  const refreshProjects = useCallback(async () => {
    const [c, v] = await Promise.all([ComposerService.List().catch(() => null), VideoEditorService.List().catch(() => null)]);
    setComps(c ?? []);
    setVideos(v ?? []);
  }, []);

  // ---- first load ----
  useEffect(() => {
    let off = false;
    void (async () => {
      const [list, lim, raw] = await Promise.all([
        PostsService.List().catch(() => null),
        PostsService.Limits().catch(() => null),
        SettingsService.ModuleState(moduleId).catch(() => ""),
      ]);
      await refreshProjects();
      if (off) return;
      let saved: PostBuilderState = { lastPostId: "", exports: {} };
      try {
        if (raw) saved = sanitizeState(JSON.parse(raw) as unknown);
      } catch {
        /* unreadable state */
      }
      const all = list ?? [];
      setPosts(all);
      if (lim) setLimits(lim);
      setPstate(saved);
      setPostId(all.find((p) => p.id === saved.lastPostId)?.id ?? all[0]?.id ?? "");
      setReady(true);
    })();
    return () => {
      off = true;
    };
  }, [moduleId, refreshProjects]);

  // Remember the open post.
  useEffect(() => {
    if (ready && postId && pstateRef.current.lastPostId !== postId) persist({ ...pstateRef.current, lastPostId: postId });
  }, [ready, postId, persist]);

  // Keep a selection.
  const pendingSelect = useRef("");
  useEffect(() => {
    if (!doc) return;
    if (pendingSelect.current) {
      const want = pendingSelect.current;
      pendingSelect.current = "";
      if (doc.slides.some((s) => s.id === want)) {
        setSelectedId(want);
        return;
      }
    }
    if (!doc.slides.some((s) => s.id === selectedId)) setSelectedId(doc.slides[0]?.id ?? "");
  }, [doc, selectedId]);

  // ---- slides ----
  const patchSlide = useCallback(
    (id: string, patch: Partial<PostSlide>) => {
      update((d) => ({ ...d, slides: d.slides.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
    },
    [update],
  );

  const appendSlides = useCallback(
    (slides: PostSlide[], at?: number) => {
      if (slides.length === 0) return;
      update((d) => ({ ...d, slides: at === undefined ? [...d.slides, ...slides] : insertAt(d.slides, at, slides) }));
      setSelectedId(slides[0]!.id);
    },
    [update],
  );

  const addPaths = useCallback(
    async (paths: string[], at?: number) => {
      if (!doc || paths.length === 0) return;
      const room = roomLeft(doc, limits);
      if (room === 0) {
        toast({ tone: "warn", title: doc.format === "reel" ? "A reel is one video" : `A post holds at most ${limits.maxSlides} slides` });
        return;
      }
      try {
        const sources = (await PostsService.SlideInfo(paths)) ?? [];
        const { slides, skipped } = slidesFromSources(sources, doc.format, limits);
        const take = slides.slice(0, room);
        if (skipped > 0) toast({ tone: "warn", title: `Skipped ${skipped} ${skipped === 1 ? "file" : "files"} that aren't photos or videos` });
        if (take.length < slides.length) toast({ tone: "warn", title: `Only ${take.length} more fit in this post` });
        appendSlides(take, at);
      } catch (e) {
        fail(e);
      }
    },
    [doc, limits, appendSlides],
  );

  /** A source dropped on a photo or clip slide takes its place (framing starts over). */
  const replaceSource = useCallback(
    async (slideId: string, path: string) => {
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
        patchSlide(slideId, { kind, path: src.path, panX: 0, panY: 0, zoom: 1, rotation: 0, inMs: 0, outMs });
        setSelectedId(slideId);
      } catch (e) {
        fail(e);
      }
    },
    [doc, limits, patchSlide],
  );

  const dropSources = useCallback(
    (paths: string[], drop: StripDrop) => {
      const d = docRef.current;
      if (!d || paths.length === 0) return;
      if (drop.kind === "replace") {
        const slide = d.slides[drop.index];
        if (!slide) return;
        if (paths.length > 1) toast({ title: "Used the first of the sources for this slide" });
        void replaceSource(slide.id, paths[0]!);
      } else {
        void addPaths(paths, drop.index);
      }
    },
    [addPaths, replaceSource],
  );

  /** Make a collage / stitch: a new composition or video slide, then the editor builds it from the sources. */
  const buildSlide = useCallback(
    async (inputs: string[], build: SlideBuild) => {
      if (!doc || inputs.length === 0) return;
      if (roomLeft(doc, limits) === 0) {
        toast({ tone: "warn", title: doc.format === "reel" ? "A reel is one video" : `A post holds at most ${limits.maxSlides} slides` });
        return;
      }
      const kind = build.kind === "collage" ? "composition" : "video";
      const slide = blankSlide(kind, { projectId: PENDING_PROJECT });
      appendSlides([slide]);
      try {
        await editor.flush();
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
    [doc, limits, appendSlides, editor, postId],
  );

  const pickFiles = useCallback(async (): Promise<string[]> => {
    try {
      return (await FilesService.PickWith("Choose photos and clips", MEDIA_EXTS, true)) ?? [];
    } catch (e) {
      fail(e);
      return [];
    }
  }, []);

  /** Hands a slide to Photo Composer or Video Editor (after saving, so the editor links to what's on disk). */
  const editSlide = useCallback(
    async (slide: PostSlide) => {
      if (!doc) return;
      try {
        await editor.flush();
      } catch (e) {
        fail(e);
        return;
      }
      useUI.getState().handOff({
        moduleId: slide.kind === "composition" ? "photo-composer" : "video-editor",
        inputs: [],
        postSlide: { postId, slideId: slide.id, aspect: doc.aspect, projectId: isPending(slide) ? "" : slide.projectId },
      });
    },
    [doc, editor, postId],
  );

  const newProjectSlide = useCallback(
    async (kind: "composition" | "video") => {
      if (!doc) return;
      if (roomLeft(doc, limits) === 0) {
        toast({ tone: "warn", title: doc.format === "reel" ? "A reel is one video" : `A post holds at most ${limits.maxSlides} slides` });
        return;
      }
      // Saved with a placeholder id: the editor replaces it on its first save.
      const slide = blankSlide(kind, { projectId: PENDING_PROJECT });
      appendSlides([slide]);
      await editSlide(slide);
    },
    [doc, limits, appendSlides, editSlide],
  );

  const addExisting = (p: ProjectInfo, kind: "composition" | "video") => {
    setDialog(null);
    appendSlides([blankSlide(kind, { projectId: p.id })]);
  };

  const deleteSlide = (id: string) => {
    if (!doc) return;
    const i = doc.slides.findIndex((s) => s.id === id);
    const next = doc.slides[i + 1] ?? doc.slides[i - 1];
    update((d) => ({ ...d, slides: d.slides.filter((s) => s.id !== id) }));
    setSelectedId(next?.id ?? "");
  };
  const copySlide = (id: string) => {
    if (!doc || doc.slides.length >= limits.maxSlides) return;
    const i = doc.slides.findIndex((s) => s.id === id);
    const src = doc.slides[i];
    if (!src) return;
    const copy = duplicateSlide(src);
    update((d) => ({ ...d, slides: [...d.slides.slice(0, i + 1), copy, ...d.slides.slice(i + 1)] }));
    setSelectedId(copy.id);
  };

  const addItems = (): MenuItem[] => {
    const full = !doc || roomLeft(doc, limits) === 0;
    return [
      { id: "files", label: "Photos & clips…", tip: full ? "This post is full" : "Pick photos and videos from your computer; each becomes a slide", icon: "image", disabled: full, onSelect: () => void pickFiles().then(addPaths) },
      { id: "new-comp", label: "New composition", tip: full ? "This post is full" : "Design a collage or graphic in Photo Composer and use it as a slide", icon: "layers", disabled: full, onSelect: () => void newProjectSlide("composition") },
      { id: "new-video", label: "New video", tip: full ? "This post is full" : "Edit a video in Video Editor and use it as a slide", icon: "clapperboard", disabled: full, onSelect: () => void newProjectSlide("video") },
      { id: "old-comp", label: "Existing composition…", tip: full ? "This post is full" : "Use a composition you already made in Photo Composer", icon: "layers", disabled: full, onSelect: () => setDialog({ kind: "pick", project: "composition" }) },
      { id: "old-video", label: "Existing video…", tip: full ? "This post is full" : "Use a video you already made in Video Editor", icon: "clapperboard", disabled: full, onSelect: () => setDialog({ kind: "pick", project: "video" }) },
    ];
  };

  // ---- posts ----
  const createPost = useCallback(async (name: string, format: string, aspect: string, paths: string[]): Promise<string> => {
    try {
      const info = await PostsService.Create(name, format, aspect, paths);
      setPosts((list) => [info, ...list.filter((p) => p.id !== info.id)]);
      setPostId(info.id);
      return info.id;
    } catch (e) {
      fail(e);
      return "";
    }
  }, []);

  const createFromFolder = useCallback(async (name: string, format: string, aspect: string, folder: string, subfolders: boolean): Promise<string> => {
    try {
      const info = await PostsService.CreateFromFolder(name, format, aspect, folder, subfolders);
      setPosts((list) => [info, ...list.filter((p) => p.id !== info.id)]);
      setPostId(info.id);
      return info.id;
    } catch (e) {
      fail(e);
      return "";
    }
  }, []);

  const duplicatePost = async (id: string) => {
    try {
      await editor.flush();
      const info = await PostsService.Duplicate(id);
      setPosts((list) => [info, ...list]);
      setPostId(info.id);
    } catch (e) {
      fail(e);
    }
  };

  const renamePost = async (id: string, name: string) => {
    setDialog(null);
    try {
      if (id === postId) {
        editor.rename(name);
        setPosts((list) => list.map((p) => (p.id === id ? { ...p, name } : p)));
      } else {
        const d = await PostsService.Get(id);
        const info = await PostsService.Save(id, name, d);
        onSaved(info);
      }
    } catch (e) {
      fail(e);
    }
  };

  const deletePost = async (id: string) => {
    setDialog(null);
    try {
      await PostsService.Delete(id);
      const rest = posts.filter((p) => p.id !== id);
      setPosts(rest);
      if (id === postId) setPostId(rest[0]?.id ?? "");
    } catch (e) {
      fail(e);
    }
  };

  // ---- handoffs ----
  const live = useRef({ doc, postId, addPaths, createPost, createFromFolder, editor, refreshProjects });
  live.current = { doc, postId, addPaths, createPost, createFromFolder, editor, refreshProjects };
  const pendingAdd = useRef<{ postId: string; paths: string[]; extra?: boolean } | null>(null);

  const applyHandoff = useCallback(async (h: Handoff) => {
    const l = live.current;
    if (h.postSlide) {
      const ps = h.postSlide;
      pendingSelect.current = ps.slideId;
      void l.refreshProjects();
      if (ps.postId === l.postId) await l.editor.reload();
      else setPostId(ps.postId);
      return;
    }
    if (h.inputs.length === 0) return;
    const dropped = usePostDrop.getState().take();
    // Folders (from a drop) make a post; the files dropped with them become its extra sources.
    const infos = (await FilesService.Stat(h.inputs).catch(() => null)) ?? [];
    const dirs = infos.filter((i) => i.isDir).map((i) => i.path);
    if (dirs.length > 0) {
      const folder = dirs[0]!;
      const files = h.inputs.filter((p) => !dirs.includes(p));
      if (dirs.length > 1) toast({ title: "Made a post from the first folder", description: "Drop the others one at a time." });
      const id = await l.createFromFolder(folderBaseName(folder) || defaultPostName("carousel"), "carousel", "4:5", folder, false);
      if (id && files.length > 0) pendingAdd.current = { postId: id, paths: files, extra: true };
      return;
    }
    const target = useAddToPost.getState().takeTarget();
    if (dropped && !target) {
      const files = h.inputs.filter((p) => SOURCE_EXTS.some((x) => p.toLowerCase().endsWith(x)));
      if (files.length === 0) return;
      if (l.doc) {
        l.editor.update((d) => ({ ...d, extra: addExtras(d.extra, files) }));
      } else if (l.postId) {
        pendingAdd.current = { postId: l.postId, paths: files, extra: true };
      } else {
        const id = await l.createPost(defaultPostName("carousel"), "carousel", "4:5", []);
        if (id) pendingAdd.current = { postId: id, paths: files, extra: true };
      }
      return;
    }
    if (target === NEW_POST || (!target && !l.postId)) {
      await l.createPost(defaultPostName("carousel"), "carousel", "4:5", h.inputs);
    } else if (target && target !== l.postId) {
      pendingAdd.current = { postId: target, paths: h.inputs };
      setPostId(target);
    } else if (l.doc) {
      await l.addPaths(h.inputs);
    } else {
      pendingAdd.current = { postId: l.postId, paths: h.inputs };
    }
  }, []);

  const handoff = useUI((s) => s.handoff);
  useEffect(() => {
    if (!ready || handoff?.moduleId !== moduleId) return;
    const h = useUI.getState().takeHandoff(moduleId);
    if (h) void applyHandoff(h);
  }, [ready, handoff, moduleId, applyHandoff]);

  // Files waiting for their post to finish loading.
  useEffect(() => {
    const p = pendingAdd.current;
    if (!p || !doc || p.postId !== postId) return;
    pendingAdd.current = null;
    if (p.extra) update((d) => ({ ...d, extra: addExtras(d.extra, p.paths) }));
    else void live.current.addPaths(p.paths);
  }, [doc, postId, update]);

  // ---- export ----
  const job = useJob(jobId);
  const running = !!job && isActive(job);
  const announced = useRef("");
  const exportPost = useRef("");
  const exportFolder = pstate.exports[postId] ?? "";

  const openFolder = useCallback((folder: string) => {
    const p = folder ? LibraryService.RevealPath(folder) : LibraryService.OpenLibraryFolder("Posts");
    p.catch(fail);
  }, []);

  useEffect(() => {
    if (!job || job.id !== jobId || announced.current === job.id) return;
    if (job.status === JobStatus.JobDone) {
      announced.current = job.id;
      const out = parseExport(job.resultJson);
      const folder = out?.folder ?? "";
      if (folder) persist({ ...pstateRef.current, exports: { ...pstateRef.current.exports, [exportPost.current || postId]: folder } });
      toast({
        tone: "success",
        title: "Post exported",
        description: folder || undefined,
        duration: 10000,
        action: { label: "Open folder", onClick: () => openFolder(folder) },
      });
    } else if (job.status === JobStatus.JobFailed) {
      announced.current = job.id;
      toast({ tone: "danger", title: job.error || "The export failed", description: job.errorHint || undefined });
    }
  }, [job, jobId, postId, persist, openFolder]);

  const blocking = firstError(editor.issues);
  const canExport = !!doc && !!postId && !blocking && !exporting && !running && doc.slides.length > 0;
  const doExport = async () => {
    if (!canExport) return;
    setExporting(true);
    try {
      await editor.flush();
      exportPost.current = postId;
      const j = await PostsService.Export(postId);
      useJobs.getState().upsert(j);
      setJobId(j.id);
    } catch (e) {
      fail(e);
    } finally {
      setExporting(false);
    }
  };

  // ---- render ----
  if (!ready) {
    return (
      <div className={styles.center}>
        <Spinner />
      </div>
    );
  }

  const strip = (
    <PostsStrip
      posts={posts}
      currentId={postId}
      onSelect={setPostId}
      onNew={() => {
        setNewFiles([]);
        setDialog({ kind: "new" });
      }}
      onDuplicate={(id) => void duplicatePost(id)}
      onRename={(id) => setDialog({ kind: "rename", id })}
      onDelete={(id) => setDialog({ kind: "delete", id })}
    />
  );

  const renameTarget = dialog?.kind === "rename" ? posts.find((p) => p.id === dialog.id) : undefined;
  const deleteTarget = dialog?.kind === "delete" ? posts.find((p) => p.id === dialog.id) : undefined;

  const dialogs = (
    <>
      {dialog?.kind === "new" && (
        <NewPostDialog
          fileCount={newFiles.length}
          onPickFiles={() => void pickFiles().then((p) => setNewFiles((cur) => [...cur, ...p.filter((x) => !cur.includes(x))]))}
          onClose={() => setDialog(null)}
          onCreate={(name, format, aspect) => {
            setDialog(null);
            void createPost(name, format, aspect, newFiles);
          }}
          onCreateFromFolder={(name, format, aspect, folder, subfolders) => {
            setDialog(null);
            void createFromFolder(name, format, aspect, folder, subfolders);
          }}
        />
      )}
      {renameTarget && <NameDialog title="Rename post" initial={renameTarget.name} confirmLabel="Rename" onConfirm={(n) => void renamePost(renameTarget.id, n)} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete this post?"
        body={deleteTarget ? `“${deleteTarget.name}” is removed from Post Builder. Your photos, compositions and exported files are not touched.` : undefined}
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => deleteTarget && void deletePost(deleteTarget.id)}
        onCancel={() => setDialog(null)}
      />
      {dialog?.kind === "pick" && (
        <ProjectPickerDialog
          title={dialog.project === "composition" ? "Choose a composition" : "Choose a video"}
          projects={dialog.project === "composition" ? comps : videos}
          emptyText={dialog.project === "composition" ? "No compositions yet. Make one with New composition." : "No videos yet. Make one with New video."}
          onPick={(p) => addExisting(p, dialog.project)}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );

  if (posts.length === 0 || !postId) {
    return (
      <div className={styles.root}>
        <header className={styles.header}>
          <h1 className={styles.title}>Post Builder</h1>
        </header>
        <div className={styles.empty}>
          <EmptyState icon="gallery-horizontal-end" title="Build a post" body="Put photos, clips, compositions and videos in order, write the caption, check it against Instagram's rules and export a folder you can upload from your phone." />
          <Button
            variant="primary"
            icon="plus"
            data-tip="Start a post from a folder of photos and clips, or empty"
            onClick={() => {
              setNewFiles([]);
              setDialog({ kind: "new" });
            }}
          >
            New post
          </Button>
          <DropZone id="tool-drop:post-builder" label="Drop photos and clips to start a post" />
          {posts.length > 0 && <div className={styles.stripWrap}>{strip}</div>}
        </div>
        {dialogs}
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <h1 className={styles.title}>Post Builder</h1>
        <span className={styles.save} role="status" data-state={editor.saveState} data-tip="Changes are saved automatically as you edit">
          {SAVE_LABEL[editor.saveState]}
        </span>
      </header>
      {strip}

      {editor.loadError && !doc ? (
        <EmptyState icon="circle-alert" title="This post can't be opened" body={editor.loadError} />
      ) : !doc ? (
        <div className={styles.center}>
          <Spinner />
        </div>
      ) : (
        <>
          <div ref={setBodyEl} className={styles.body} style={{ gridTemplateColumns: `${layout.sources}px ${layout.strip}px minmax(0, 1fr) ${layout.right}px` }}>
            <SourcesPanel
              postId={postId}
              doc={doc}
              format={doc.format}
              saved={editor.saveState === "saved"}
              selectedSlide={selected}
              width={pstate.sourcesWidth ?? SOURCES_DEFAULT}
              collapsed={layout.sourcesCollapsed}
              onWidth={(w) => persist({ ...pstateRef.current, sourcesWidth: w })}
              onCollapsed={(c) => (layout.autoCollapsed ? setSourcesForced(!c) : persist({ ...pstateRef.current, sourcesCollapsed: c }))}
              update={update}
              onAddSlides={(paths) => void addPaths(paths)}
              onBuild={(inputs, build) => void buildSlide(inputs, build)}
            />
            <aside className={styles.left}>
              <SlideStrip
                slides={doc.slides}
                selectedId={selectedId}
                aspect={doc.aspect}
                issues={slideIssues}
                projects={projects}
                maxSlides={doc.format === "reel" ? 1 : limits.maxSlides}
                addItems={addItems}
                onSelect={setSelectedId}
                onReorder={(from, to) => update((d) => ({ ...d, slides: reorder(d.slides, from, to) }))}
                onDelete={deleteSlide}
                onDuplicate={copySlide}
                onSourceDrop={dropSources}
              />
            </aside>
            <main className={styles.centre}>
              {selected ? (
                <SlideStage
                  key={selected.id}
                  slide={selected}
                  format={doc.format}
                  aspect={doc.aspect}
                  project={projects.get(selected.projectId)}
                  limits={limits}
                  onChange={(patch) => patchSlide(selected.id, patch)}
                  onEdit={() => void editSlide(selected)}
                />
              ) : (
                <div className={styles.dropArea}>
                  <DropZone id="tool-drop:post-builder" label="Drop photos and clips" hint="or use Add in the slides list" />
                </div>
              )}
            </main>
            <aside className={styles.right}>
              <ShapePanel
                doc={doc}
                onChange={(patch) => update((d) => ({ ...d, ...patch }))}
              />
              <CaptionPanel caption={doc.caption} limits={limits} onChange={(caption) => update((d) => ({ ...d, caption }))} />
              <AltPanel slide={selected} index={selectedIndex} limits={limits} onChange={(altText) => selected && patchSlide(selected.id, { altText })} />
              <ChecksPanel issues={editor.issues} slides={doc.slides} onSelect={setSelectedId} />
              <PhonePreview slides={doc.slides} aspect={doc.aspect} caption={doc.caption} projects={projects} currentId={selectedId} onCurrent={setSelectedId} />
            </aside>
          </div>

          <footer className={styles.footer}>
            {running && job ? (
              <div className={styles.progress}>
                <Meter value={job.progress} status="running" label="Export progress" />
                <span className={styles.progressMsg}>{job.message || "Exporting…"}</span>
                <Button size="sm" variant="ghost" data-tip="Stop exporting this post" onClick={() => void useJobs.getState().cancel(job.id)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <>
                {exportFolder && (
                  <span className={styles.last}>
                    <span className={styles.lastLabel} data-tip="The folder this post was last exported to">Last export</span>
                    <span className={styles.lastPath} title={exportFolder}>
                      {exportFolder}
                    </span>
                    <Button size="sm" variant="ghost" icon="folder-open" data-tip="Show the exported folder in your file manager" onClick={() => openFolder(exportFolder)}>
                      Open folder
                    </Button>
                    <Button size="sm" variant="ghost" icon="copy" data-tip="Copy the caption to paste into Instagram" onClick={() => void copyText(doc.caption, "Caption copied")}>
                      Copy caption
                    </Button>
                  </span>
                )}
                <span className={styles.spacer} />
                {blocking && (
                  <span className={styles.blocker} data-testid="export-blocker" data-tip="Fix this in the Checks panel to enable Export">
                    {blocking.message}
                  </span>
                )}
                <Tooltip label={blocking ? blocking.message : "Write the post to a folder"}>
                  <span>
                    <Button variant="primary" icon="download" disabled={!canExport} loading={exporting} onClick={() => void doExport()}>
                      Export
                    </Button>
                  </span>
                </Tooltip>
              </>
            )}
          </footer>
        </>
      )}
      {dialogs}
    </div>
  );
}
