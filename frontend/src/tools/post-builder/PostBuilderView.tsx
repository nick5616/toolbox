import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useUI, type Handoff } from "@/state/ui";
import type { ToolViewProps } from "../index";
import { NameDialog, NewPostDialog, ProjectPickerDialog } from "./dialogs";
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
  roomLeft,
  sanitizeState,
  slidesFromSources,
  type PostBuilderState,
  type PostDoc,
} from "./logic";
import { NEW_POST, useAddToPost } from "./store";
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
    (slides: PostSlide[]) => {
      if (slides.length === 0) return;
      update((d) => ({ ...d, slides: [...d.slides, ...slides] }));
      setSelectedId(slides[0]!.id);
    },
    [update],
  );

  const addPaths = useCallback(
    async (paths: string[]) => {
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
        appendSlides(take);
      } catch (e) {
        fail(e);
      }
    },
    [doc, limits, appendSlides],
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
      { id: "files", label: "Photos & clips…", icon: "image", disabled: full, onSelect: () => void pickFiles().then(addPaths) },
      { id: "new-comp", label: "New composition", icon: "layers", disabled: full, onSelect: () => void newProjectSlide("composition") },
      { id: "new-video", label: "New video", icon: "clapperboard", disabled: full, onSelect: () => void newProjectSlide("video") },
      { id: "old-comp", label: "Existing composition…", icon: "layers", disabled: full, onSelect: () => setDialog({ kind: "pick", project: "composition" }) },
      { id: "old-video", label: "Existing video…", icon: "clapperboard", disabled: full, onSelect: () => setDialog({ kind: "pick", project: "video" }) },
    ];
  };

  // ---- posts ----
  const createPost = useCallback(
    async (name: string, format: string, aspect: string, paths: string[]) => {
      try {
        const info = await PostsService.Create(name, format, aspect, paths);
        setPosts((list) => [info, ...list.filter((p) => p.id !== info.id)]);
        setPostId(info.id);
      } catch (e) {
        fail(e);
      }
    },
    [],
  );

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
  const live = useRef({ doc, postId, addPaths, createPost, editor, refreshProjects });
  live.current = { doc, postId, addPaths, createPost, editor, refreshProjects };
  const pendingAdd = useRef<{ postId: string; paths: string[] } | null>(null);

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
    const target = useAddToPost.getState().takeTarget();
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
    void live.current.addPaths(p.paths);
  }, [doc, postId]);

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
        <span className={styles.save} role="status" data-state={editor.saveState}>
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
          <div className={styles.body}>
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
                <Button size="sm" variant="ghost" onClick={() => void useJobs.getState().cancel(job.id)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <>
                {exportFolder && (
                  <span className={styles.last}>
                    <span className={styles.lastLabel}>Last export</span>
                    <span className={styles.lastPath} title={exportFolder}>
                      {exportFolder}
                    </span>
                    <Button size="sm" variant="ghost" icon="folder-open" onClick={() => openFolder(exportFolder)}>
                      Open folder
                    </Button>
                    <Button size="sm" variant="ghost" icon="copy" onClick={() => void copyText(doc.caption, "Caption copied")}>
                      Copy caption
                    </Button>
                  </span>
                )}
                <span className={styles.spacer} />
                {blocking && (
                  <span className={styles.blocker} data-testid="export-blocker">
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
