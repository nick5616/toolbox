import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banner, Button, ClickIn, ClickInHost, IconButton, Meter, Select, Slider, TextField, toast } from "@/components";
import { formatMs, useMediaSource } from "@/components/media";
import {
  FilesService,
  JobStatus,
  JobsService,
  LibraryService,
  LyricVideoService,
  PostsService,
  SettingsService,
  VideoEditorService,
  type ProjectInfo,
  type VideoClipInfo,
  type VideoProject,
} from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { revealLabel } from "@/lib/platform";
import { closeWindow, currentWindow } from "@/lib/windows";
import { useShortcut } from "@/lib/shortcuts";
import { useJob, useJobs } from "@/state/jobs";
import { useUI, type PostSlideSeed } from "@/state/ui";
import { DepsGate, useDepsGate } from "@/tools/_kit";
import type { ToolViewProps } from "@/tools";
import { SourceLoaders, type ClipSource, type SourceMap, type SourceRequest } from "./ClipSources";
import { ExactPlayer } from "./ExactPlayer";
import { Inspector } from "./Inspector";
import { ProjectsHome } from "./ProjectsHome";
import { QuickVlogDialog } from "./QuickVlogDialog";
import { SequencePlayer } from "./SequencePlayer";
import { SourcesTab } from "./SourcesTab";
import { TimelinePanel } from "./TimelinePanel";
import {
  ASPECTS,
  appendClips,
  clipFromInfo,
  clipsOf,
  defaultMusic,
  deleteClip,
  deleteTitle,
  emptyProject,
  insertClips,
  localWarnings,
  mapPostAspect,
  newTitle,
  splitClip,
  titlesOf,
} from "./edit";
import { newHistory, pushHistory, redo, undo, type History } from "./history";
import type { PlayerHandle } from "./playerTypes";
import { clipIndexAt, layersAt, neededIndexes } from "./schedule";
import { durationMs, timeline } from "./timeline";
import type { Selection } from "./types";
import { DEFAULT_VLOG, addVlogPaths, buildPlanRequest, vlogProblem, type VlogForm } from "./vlog";
import styles from "./VideoEditorView.module.css";

type SaveState = "idle" | "saving" | "saved" | "error";

const AUTOSAVE_MS = 800;
const MAX_RETAINED_SOURCES = 6;
const SONG_EXTENSIONS = [".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac", ".opus"];

function sameSource(a: ClipSource | undefined, b: ClipSource): boolean {
  return !!a && a.status === b.status && a.url === b.url && a.progress === b.progress && a.error === b.error;
}

function parseProjectId(resultJson: string): string {
  try {
    const r = JSON.parse(resultJson) as { projectId?: unknown };
    return typeof r.projectId === "string" ? r.projectId : "";
  } catch {
    return "";
  }
}

function aspectFor(info: VideoClipInfo | undefined): string {
  if (!info || info.width <= 0 || info.height <= 0) return "9:16";
  const rot = Math.abs(info.rotation || 0) % 180 === 90;
  const w = rot ? info.height : info.width;
  const h = rot ? info.width : info.height;
  return h > w ? "9:16" : h === w ? "1:1" : "16:9";
}

/** A stitch build from a post (SPEC.md §B13.5): the Plan request's form, and why it failed. */
interface StitchState {
  form: VlogForm;
  error?: { message: string; hint: string };
}

const TRANSITIONS: readonly VlogForm["transition"][] = ["cut", "fade", "dip", "slide"];

/** A thin progress bar for a running job with a cancel button. */
function JobBar({ label, jobId }: { label: string; jobId: string }) {
  const job = useJob(jobId);
  if (!job || (job.status !== JobStatus.JobRunning && job.status !== JobStatus.JobQueued)) return null;
  return (
    <div className={styles.jobBar} role="status">
      <span>
        {label}
        {job.progress >= 0 ? ` ${Math.round(job.progress * 100)}%` : "…"}
      </span>
      <Meter value={job.progress} size="sm" label={label} className={styles.jobMeter} />
      <Button size="sm" variant="ghost" onClick={() => void JobsService.Cancel(jobId).catch(() => undefined)}>
        Cancel
      </Button>
    </div>
  );
}

export default function VideoEditorView({ moduleId }: ToolViewProps) {
  const gate = useDepsGate(moduleId);

  // ---- projects ----
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [hist, setHist] = useState<History<VideoProject> | null>(null);
  const doc = hist?.present ?? null;

  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const savedDoc = useRef<VideoProject | null>(null);
  const savedName = useRef("");
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());

  const [infos, setInfos] = useState<Record<string, VideoClipInfo | undefined>>({});
  const [fonts, setFonts] = useState<string[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [timeMs, setTimeMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const player = useRef<PlayerHandle>(null);
  const titleText = useRef<HTMLTextAreaElement>(null);

  const [vlogOpen, setVlogOpen] = useState(false);
  const [vlog, setVlog] = useState<VlogForm>(DEFAULT_VLOG);
  const [planJobId, setPlanJobId] = useState("");
  const [exportJobId, setExportJobId] = useState("");
  const [previewJobId, setPreviewJobId] = useState("");
  const [exported, setExported] = useState<{ path: string; name: string } | null>(null);
  const [exact, setExact] = useState<{ path: string; at: number; doc: VideoProject } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [postSlide, setPostSlide] = useState<PostSlideSeed | null>(null);
  const postSlideRef = useRef<PostSlideSeed | null>(null);
  postSlideRef.current = postSlide;
  const needsLink = useRef(false);
  const [stitch, setStitch] = useState<StitchState | null>(null);
  const stitchRef = useRef<StitchState | null>(null);
  stitchRef.current = stitch;
  /** A title whose Text click-in should open and take focus. */
  const [titleFocus, setTitleFocus] = useState<string | null>(null);

  const live = useRef({ projectId, name, doc, timeMs, vlogOpen });
  live.current = { projectId, name, doc, timeMs, vlogOpen };

  // ---- saving ----
  const linkPostSlide = useCallback(async (projId: string) => {
    const ps = postSlideRef.current;
    if (!ps || !needsLink.current) return;
    needsLink.current = false;
    try {
      const post = await PostsService.Get(ps.postId);
      const existing = post.slides ?? [];
      const slides = existing.some((s) => s.id === ps.slideId)
        ? existing.map((s) => (s.id === ps.slideId ? { ...s, kind: "video", projectId: projId } : s))
        : [
            ...existing,
            { id: ps.slideId, path: "", kind: "video", projectId: projId, zoom: 1, panX: 0, panY: 0, rotation: 0, inMs: 0, outMs: 0, mute: false, altText: "" },
          ];
      const list = (await PostsService.List()) ?? [];
      const postName = list.find((x) => x.id === ps.postId)?.name ?? "Post";
      await PostsService.Save(ps.postId, postName, { ...post, slides });
      setPostSlide({ ...ps, projectId: projId });
    } catch (e) {
      needsLink.current = true;
      toast({ title: "Couldn't link this video to the post", description: toAppError(e).message, tone: "warn" });
    }
  }, []);

  const doSave = useCallback((): Promise<boolean> => {
    const run = async (): Promise<boolean> => {
      const { projectId: id, name: nm, doc: d } = live.current;
      if (!id || !d) return true;
      if (d === savedDoc.current && nm === savedName.current) return true;
      setSaveState("saving");
      try {
        await VideoEditorService.Save(id, nm, d);
        savedDoc.current = d;
        savedName.current = nm;
        setSaveState("saved");
        setSaveError("");
        void linkPostSlide(id);
        return true;
      } catch (e) {
        const err = toAppError(e);
        const fields = err.fields ? Object.values(err.fields).join(", ") : "";
        setSaveState("error");
        setSaveError(fields && fields !== err.message ? `${err.message} (${fields})` : err.message);
        return false;
      }
    };
    const p = saveChain.current.then(run, run);
    saveChain.current = p;
    return p;
  }, [linkPostSlide]);

  useEffect(() => {
    if (!doc || !projectId) return;
    if (doc === savedDoc.current && name === savedName.current) return;
    const t = setTimeout(() => void doSave(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [doc, name, projectId, doSave]);

  // Flush on leaving.
  useEffect(
    () => () => {
      void doSave();
    },
    [doSave],
  );

  const edit = useCallback((next: VideoProject, key?: string) => {
    setHist((h) => (h ? pushHistory(h, next, key ?? "") : h));
  }, []);

  // ---- probing ----
  const probe = useCallback(async (paths: string[]): Promise<VideoClipInfo[]> => {
    const uniq = [...new Set(paths)];
    if (uniq.length === 0) return [];
    const res = (await VideoEditorService.Probe(uniq)) ?? [];
    setInfos((prev) => {
      const next = { ...prev };
      for (const i of res) next[i.path] = i;
      return next;
    });
    return res;
  }, []);

  const refreshProjects = useCallback(async (): Promise<ProjectInfo[]> => {
    try {
      const list = (await VideoEditorService.List()) ?? [];
      setProjects(list);
      return list;
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
      return [];
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  const openWith = useCallback(
    (info: ProjectInfo, d: VideoProject, saved: VideoProject = d) => {
      const norm: VideoProject = { ...d, clips: d.clips ?? [], titles: d.titles ?? [] };
      savedDoc.current = saved === d ? norm : saved;
      savedName.current = info.name;
      setProjectId(info.id);
      setName(info.name);
      setHist(newHistory(norm));
      setSelection(null);
      setTimeMs(0);
      setPlaying(false);
      setExact(null);
      setExported(null);
      setSaveState("idle");
      setSaveError("");
      void SettingsService.SetModuleState(moduleId, JSON.stringify({ lastProjectId: info.id })).catch(() => undefined);
      const paths = [...(norm.clips ?? []).map((c) => c.path), ...(norm.music ? [norm.music.path] : [])];
      void probe(paths).catch(() => undefined);
    },
    [moduleId, probe],
  );

  const openProject = useCallback(
    async (id: string, infoHint?: ProjectInfo): Promise<boolean> => {
      await doSave();
      try {
        const [d, list] = await Promise.all([VideoEditorService.Get(id), infoHint ? Promise.resolve([infoHint]) : refreshProjects()]);
        const info = list.find((p) => p.id === id);
        if (!info) throw new Error("This video doesn't exist any more");
        openWith(info, d);
        return true;
      } catch (e) {
        toast({ title: toAppError(e).message, tone: "danger" });
        return false;
      }
    },
    [doSave, openWith, refreshProjects],
  );

  const createAndOpen = useCallback(
    async (nm: string, aspect: string, initial?: VideoProject) => {
      await doSave();
      try {
        const info = await VideoEditorService.Create(nm, aspect);
        const empty = emptyProject(aspect);
        setProjects((p) => [info, ...p]);
        openWith(info, initial ?? empty, empty);
        return info;
      } catch (e) {
        toast({ title: toAppError(e).message, tone: "danger" });
        return null;
      }
    },
    [doSave, openWith],
  );

  const closeProject = useCallback(async () => {
    await doSave();
    setProjectId(null);
    setHist(null);
    setPlaying(false);
    void refreshProjects();
  }, [doSave, refreshProjects]);

  // ---- adding clips ----
  const addPaths = useCallback(
    async (paths: string[], index?: number) => {
      if (paths.length === 0) return;
      let res: VideoClipInfo[];
      try {
        res = await probe(paths);
      } catch (e) {
        toast({ title: toAppError(e).message, tone: "danger" });
        return;
      }
      const usable = res.filter((i) => clipFromInfo(i, "x"));
      if (usable.length === 0) {
        toast({ title: "Those files can't be used", description: res[0]?.error || "Add videos or photos.", tone: "warn" });
        return;
      }
      if (usable.length < res.length) {
        const n = res.length - usable.length;
        toast({ title: `Skipped ${n} ${n === 1 ? "file" : "files"} that can't be used`, tone: "warn" });
      }
      const cur = live.current.doc;
      if (!cur) {
        const aspect = aspectFor(usable.find((i) => i.kind === "video") ?? usable[0]);
        const base = emptyProject(aspect);
        await createAndOpen("New video", aspect, appendClips(base, usable).doc);
      } else {
        edit((index === undefined ? appendClips(cur, usable) : insertClips(cur, usable, index)).doc);
      }
    },
    [probe, createAndOpen, edit],
  );

  // ---- stitch build (from a post) ----
  const startStitch = useCallback(async (form: VlogForm) => {
    setStitch({ form });
    try {
      const j = await VideoEditorService.Plan(buildPlanRequest(form));
      useJobs.getState().upsert(j);
      setPlanJobId(j.id);
    } catch (e) {
      const err = toAppError(e);
      setStitch({ form, error: { message: err.message, hint: err.hint ?? "" } });
    }
  }, []);

  // ---- handoffs ----
  const handoff = useUI((s) => s.handoff);
  const started = useRef(false);
  useEffect(() => {
    if (handoff?.moduleId !== moduleId) return;
    const h = useUI.getState().takeHandoff(moduleId);
    if (!h) return;
    started.current = true;
    if (h.postSlide) {
      const ps = h.postSlide;
      setPostSlide(ps);
      if (ps.build?.kind === "stitch") {
        const b = ps.build;
        needsLink.current = true;
        const transition = TRANSITIONS.find((t) => t === b.transition) ?? "fade";
        void startStitch({
          ...DEFAULT_VLOG,
          paths: h.inputs,
          musicPath: b.music,
          aspect: mapPostAspect(ps.aspect),
          order: b.order,
          length: "music",
          beatCut: b.beatCut && b.music !== "",
          transition,
        });
        return;
      }
      void (async () => {
        if (ps.projectId && ps.projectId !== "pending" && (await openProject(ps.projectId))) return;
        needsLink.current = true;
        const info = await createAndOpen("Post video", mapPostAspect(ps.aspect));
        if (info && h.inputs.length > 0) await addPaths(h.inputs);
      })();
      return;
    }
    if (live.current.vlogOpen) setVlog((f) => addVlogPaths(f, h.inputs));
    else void addPaths(h.inputs);
  }, [handoff, moduleId, openProject, createAndOpen, addPaths, startStitch]);

  // ---- startup ----
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await refreshProjects();
      let last = "";
      let quickVlog = false;
      try {
        const raw = await SettingsService.ModuleState(moduleId);
        if (raw) {
          const st = JSON.parse(raw) as { lastProjectId?: string; quickVlog?: boolean };
          last = st.lastProjectId ?? "";
          quickVlog = st.quickVlog === true;
        }
      } catch {
        /* no remembered project */
      }
      if (cancelled || started.current || live.current.projectId) return;
      const pending = useUI.getState().handoff;
      if (pending?.moduleId === moduleId) return;
      if (quickVlog) {
        // Asked for from the Video Editor's home (Phase 10): open the Quick vlog dialog once.
        void SettingsService.SetModuleState(moduleId, JSON.stringify({ lastProjectId: last })).catch(() => undefined);
        setVlogOpen(true);
        return;
      }
      if (last && list.some((p) => p.id === last)) await openProject(last, list.find((p) => p.id === last));
    })();
    LyricVideoService.Fonts().then(
      (f) => !cancelled && setFonts(f ?? []),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);

  // ---- derived timeline ----
  const clips = useMemo(() => (doc ? clipsOf(doc) : []), [doc]);
  const spans = useMemo(() => timeline(clips), [clips]);
  const naturalMs = useMemo(() => durationMs(clips), [clips]);
  const songMs = doc?.music ? (infos[doc.music.path]?.durationMs ?? 0) : 0;
  const totalMs = useMemo(() => {
    if (doc?.music?.endWithMusic && songMs > 0) return Math.max(0, Math.min(naturalMs, songMs - doc.music.offsetMs));
    return naturalMs;
  }, [doc?.music, songMs, naturalMs]);

  const missing = useMemo(() => {
    const s = new Set<string>();
    for (const [p, i] of Object.entries(infos)) if (i?.error) s.add(p);
    return s;
  }, [infos]);
  const warnings = useMemo(() => {
    if (!doc) return [];
    const w = localWarnings(doc, missing);
    if (saveState === "error" && saveError) w.push(saveError);
    return w;
  }, [doc, missing, saveState, saveError]);

  // ---- sources for the sequence player ----
  const [sources, setSources] = useState<SourceMap>({});
  const onSource = useCallback((path: string, s: ClipSource) => {
    setSources((prev) => (sameSource(prev[path], s) ? prev : { ...prev, [path]: s }));
  }, []);
  const retained = useRef<SourceRequest[]>([]);
  const requests = useMemo(() => {
    const layers = layersAt(clips, spans, timeMs);
    const need = neededIndexes(layers, clips.length, timeMs, spans);
    const next = [...retained.current];
    for (const i of need) {
      const c = clips[i];
      if (c && !next.some((r) => r.path === c.path && r.kind === c.kind)) next.unshift({ path: c.path, kind: c.kind === "image" ? "image" : "video" });
    }
    const needed = new Set(need.map((i) => clips[i]?.path));
    // Keep what's needed now, then the most recent others.
    const keep = [...next.filter((r) => needed.has(r.path)), ...next.filter((r) => !needed.has(r.path))].slice(0, Math.max(MAX_RETAINED_SOURCES, need.length));
    const stillSame = keep.length === retained.current.length && keep.every((r, i) => r === retained.current[i]);
    if (!stillSame) retained.current = keep;
    return retained.current;
  }, [clips, spans, timeMs]);

  const song = useMediaSource(doc?.music?.path ?? null);
  const musicUrl = song.status === "ready" ? song.source?.url : undefined;

  // ---- exact preview ----
  const exactMedia = useMediaSource(exact?.path ?? null);
  const exactUrl = exactMedia.status === "ready" ? exactMedia.source?.url : undefined;
  const showExact = !!exact && !!exactUrl;
  const exactStale = !!exact && exact.doc !== doc;
  useEffect(() => {
    if (!exact) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [exact]);
  // Returning to the sequence player: pick up at the same time.
  const wasExact = useRef(false);
  useEffect(() => {
    if (wasExact.current && !showExact) player.current?.seek(live.current.timeMs);
    wasExact.current = showExact;
  }, [showExact]);

  // ---- jobs ----
  const planJob = useJob(planJobId);
  const exportJob = useJob(exportJobId);
  const previewJob = useJob(previewJobId);
  const handled = useRef(new Set<string>());

  useEffect(() => {
    if (!planJob || planJob.status === JobStatus.JobRunning || planJob.status === JobStatus.JobQueued) return;
    if (handled.current.has(planJob.id)) return;
    handled.current.add(planJob.id);
    setPlanJobId("");
    const st = stitchRef.current;
    if (st) {
      if (planJob.status === JobStatus.JobDone) {
        const id = parseProjectId(planJob.resultJson);
        void (async () => {
          if (id && (await openProject(id))) {
            await linkPostSlide(id);
            setStitch(null);
          } else {
            setStitch({ form: st.form, error: { message: "The video was built but couldn't be opened", hint: "" } });
          }
        })();
      } else {
        const message = planJob.status === JobStatus.JobCancelled ? "The build was cancelled" : planJob.error || "Couldn't build the video";
        setStitch({ form: st.form, error: { message, hint: planJob.errorHint || "" } });
      }
      return;
    }
    if (planJob.status === JobStatus.JobDone) {
      const id = parseProjectId(planJob.resultJson);
      if (id) void openProject(id);
      else toast({ title: "The vlog was built but couldn't be opened", tone: "warn" });
    } else if (planJob.status === JobStatus.JobFailed) {
      toast({ title: planJob.error || "Couldn't build the vlog", description: planJob.errorHint || undefined, tone: "danger" });
    }
  }, [planJob, openProject, linkPostSlide]);

  useEffect(() => {
    if (!exportJob || exportJob.status === JobStatus.JobRunning || exportJob.status === JobStatus.JobQueued) return;
    if (handled.current.has(exportJob.id)) return;
    handled.current.add(exportJob.id);
    if (exportJob.status === JobStatus.JobDone) {
      const out = exportJob.outputs[0];
      if (out) {
        setExported({ path: out.path, name: out.name });
        toast({
          title: "Exported",
          description: out.name,
          tone: "success",
          duration: 8000,
          action: { label: revealLabel, onClick: () => void LibraryService.RevealPath(out.path).catch(() => undefined) },
        });
      }
    } else if (exportJob.status === JobStatus.JobFailed) {
      toast({ title: exportJob.error || "The export failed", description: exportJob.errorHint || undefined, tone: "danger" });
    }
  }, [exportJob]);

  useEffect(() => {
    if (!previewJob || previewJob.status === JobStatus.JobRunning || previewJob.status === JobStatus.JobQueued) return;
    if (handled.current.has(previewJob.id)) return;
    handled.current.add(previewJob.id);
    if (previewJob.status === JobStatus.JobDone) {
      const id = live.current.projectId;
      const d = live.current.doc;
      if (id && d) {
        void VideoEditorService.PreviewPath(id).then(
          (path) => {
            if (path) setExact({ path, at: Date.now(), doc: previewDocRef.current ?? d });
          },
          () => undefined,
        );
      }
    } else if (previewJob.status === JobStatus.JobFailed) {
      toast({ title: previewJob.error || "The preview failed", description: previewJob.errorHint || undefined, tone: "danger" });
    }
  }, [previewJob]);
  const previewDocRef = useRef<VideoProject | null>(null);

  const submit = async (kind: "export" | "preview") => {
    if (!projectId || !doc) return;
    if (!(await doSave())) {
      toast({ title: "Fix the problem above before rendering", tone: "warn" });
      return;
    }
    try {
      if (kind === "export") {
        const job = await VideoEditorService.Render(projectId);
        useJobs.getState().upsert(job);
        setExported(null);
        setExportJobId(job.id);
      } else {
        previewDocRef.current = live.current.doc;
        const job = await VideoEditorService.Preview(projectId);
        useJobs.getState().upsert(job);
        setPreviewJobId(job.id);
      }
    } catch (e) {
      const err = toAppError(e);
      toast({ title: err.message, description: err.hint, tone: "danger" });
    }
  };

  const buildVlog = async () => {
    if (vlogProblem(vlog)) return;
    try {
      const job = await VideoEditorService.Plan(buildPlanRequest(vlog));
      useJobs.getState().upsert(job);
      setPlanJobId(job.id);
      setVlogOpen(false);
    } catch (e) {
      const err = toAppError(e);
      toast({ title: err.message, description: err.hint, tone: "danger" });
    }
  };

  // ---- pickers ----
  const pickClips = async () => {
    try {
      const paths = (await FilesService.Pick(moduleId)) ?? [];
      if (paths.length > 0) await addPaths(paths);
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };
  const pickVlogClips = async () => {
    try {
      const paths = (await FilesService.Pick(moduleId)) ?? [];
      if (paths.length > 0) setVlog((f) => addVlogPaths(f, paths));
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };
  const pickSong = async (forVlog: boolean) => {
    try {
      const paths = (await FilesService.PickWith("Pick a song", SONG_EXTENSIONS, false)) ?? [];
      const path = paths[0];
      if (!path) return;
      if (forVlog) {
        setVlog((f) => ({ ...f, musicPath: path }));
        return;
      }
      const cur = live.current.doc;
      if (!cur) return;
      void probe([path]).catch(() => undefined);
      edit({ ...cur, music: cur.music ? { ...cur.music, path, offsetMs: 0 } : defaultMusic(path) });
      setSelection({ kind: "music" });
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };

  // ---- editing commands ----
  const seek = useCallback((ms: number) => {
    const v = Math.max(0, ms);
    player.current?.seek(v);
    setTimeMs(v);
  }, []);

  const split = () => {
    if (!doc) return;
    const idx = clipIndexAt(spans, timeMs);
    const next = idx >= 0 ? splitClip(doc, idx, timeMs) : null;
    if (!next) {
      toast({ title: "Can't split here", description: "Put the playhead inside a clip, at least 0.3 s (1 s for photos) from each edge.", tone: "warn" });
      return;
    }
    edit(next);
    const created = clipsOf(next)[idx + 1];
    if (created) setSelection({ kind: "clip", id: created.id });
  };

  const removeSelection = () => {
    if (!doc || !selection) return;
    if (selection.kind === "clip") {
      const i = clips.findIndex((c) => c.id === selection.id);
      if (i >= 0) edit(deleteClip(doc, i));
    } else if (selection.kind === "title") {
      edit(deleteTitle(doc, selection.id));
    } else if (doc.music) {
      edit({ ...doc, music: null });
    }
    setSelection(null);
  };

  const doUndo = () => {
    setHist((h) => (h ? undo(h) : h));
    setSelection(null);
  };
  const doRedo = () => {
    setHist((h) => (h ? redo(h) : h));
    setSelection(null);
  };

  const editing = !!doc && !vlogOpen;
  useShortcut(" ", () => player.current?.toggle(), { when: editing });
  useShortcut("s", split, { when: editing });
  useShortcut(["Delete", "Backspace"], removeSelection, { when: editing });
  useShortcut("Mod+Z", doUndo, { when: editing });
  useShortcut(["Mod+Shift+Z", "Mod+Y"], doRedo, { when: editing });

  const addTitle = () => {
    if (!doc) return;
    const t = newTitle(Math.min(timeMs, Math.max(totalMs - 500, 0)));
    edit({ ...doc, titles: [...titlesOf(doc), t] });
    setSelection({ kind: "title", id: t.id });
    setTitleFocus(t.id);
  };

  const backToPost = async () => {
    await doSave();
    const ps = postSlideRef.current;
    if (!ps) return;
    // In its own window there is no Post Builder here: closing returns to the post, which refreshes itself.
    const w = currentWindow();
    if (w.kind !== "main") await closeWindow(w.key).catch(() => undefined);
    else useUI.getState().handOff({ moduleId: "post-builder", inputs: [], postSlide: ps });
  };

  // ---- render ----
  const blocked = gate.blocked;
  const busyExport = !!exportJob && (exportJob.status === JobStatus.JobRunning || exportJob.status === JobStatus.JobQueued);
  const busyPreview = !!previewJob && (previewJob.status === JobStatus.JobRunning || previewJob.status === JobStatus.JobQueued);
  const planning = !!planJob && (planJob.status === JobStatus.JobRunning || planJob.status === JobStatus.JobQueued);
  const ago = exact ? Math.max(0, Math.round((now - exact.at) / 1000)) : 0;

  const loaders = <SourceLoaders requests={requests} onChange={onSource} />;
  const dialog = (
    <QuickVlogDialog
      open={vlogOpen}
      form={vlog}
      busy={planning}
      onChange={setVlog}
      onPickClips={() => void pickVlogClips()}
      onPickSong={() => void pickSong(true)}
      onBuild={() => void buildVlog()}
      onCancel={() => setVlogOpen(false)}
    />
  );

  if (stitch) {
    return (
      <div className={styles.root}>
        <DepsGate moduleId={moduleId} />
        <div className={styles.building} role="status">
          {!stitch.error ? (
            <>
              <h2>Building your video…</h2>
              <p>
                {planJob && planJob.progress >= 0 ? `${Math.round(planJob.progress * 100)}%` : "Working…"}
                {planJob?.message ? ` ${planJob.message}` : ""}
              </p>
              <Meter value={planJob?.progress ?? -1} label="Building your video" className={styles.buildingMeter} />
              {planJobId && <Button data-tip="Stop building the video" onClick={() => void JobsService.Cancel(planJobId).catch(() => undefined)}>Cancel</Button>}
            </>
          ) : (
            <>
              <Banner tone="danger" title={stitch.error.message}>
                {stitch.error.hint}
              </Banner>
              <Button
                variant="primary"
                data-tip="Go to the Quick vlog form with your choices so you can adjust them and build again"
                onClick={() => {
                  setVlog(stitch.form);
                  setVlogOpen(true);
                  setStitch(null);
                }}
              >
                Open Quick vlog instead
              </Button>
            </>
          )}
        </div>
        {dialog}
      </div>
    );
  }

  if (!doc || !projectId) {
    return (
      <div className={styles.root}>
        <DepsGate moduleId={moduleId} />
        <JobBar label="Building your vlog" jobId={planJobId} />
        <ProjectsHome
          projects={projects}
          loading={projectsLoading}
          onOpen={(id) => void openProject(id)}
          onNew={(aspect) => void createAndOpen("Untitled video", aspect)}
          onQuickVlog={() => setVlogOpen(true)}
          onDuplicate={(id) =>
            void VideoEditorService.Duplicate(id).then(
              () => refreshProjects(),
              (e: unknown) => toast({ title: toAppError(e).message, tone: "danger" }),
            )
          }
          onRename={(id, nm) =>
            void (async () => {
              try {
                const d = await VideoEditorService.Get(id);
                await VideoEditorService.Save(id, nm, d);
                await refreshProjects();
              } catch (e) {
                toast({ title: toAppError(e).message, tone: "danger" });
              }
            })()
          }
          onDelete={(id) =>
            void VideoEditorService.Delete(id).then(
              () => refreshProjects(),
              (e: unknown) => toast({ title: toAppError(e).message, tone: "danger" }),
            )
          }
        />
        {dialog}
      </div>
    );
  }

  return (
    <ClickInHost className={styles.root}>
      <DepsGate moduleId={moduleId} />
      <div className={styles.header}>
        <Button size="sm" variant="ghost" icon="chevron-left" data-tip="Save and go back to the list of your video projects" onClick={() => void closeProject()}>
          Projects
        </Button>
        <TextField
          aria-label="Project name"
          data-tip="Rename this project (shown in the list; the exported file uses it too)"
          size="sm"
          wrapperClassName={styles.nameField}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        <Select
          size="sm"
          aria-label="Shape"
          data-tip="Frame shape of the video: 9:16 for Reels and Stories, 1:1 square, 4:5 portrait, 16:9 landscape"
          value={doc.aspect}
          options={ASPECTS.map((a) => ({ value: a, label: a }))}
          onChange={(aspect) => edit({ ...doc, aspect })}
        />
        <span className={styles.length} data-testid="total-length" data-tip="Total length of the video">
          {formatMs(totalMs)}
        </span>
        <span className={styles.saveState} role="status" data-state={saveState} data-tip={saveState === "error" ? saveError || "The project could not be saved" : "Changes are saved automatically as you edit"}>
          {saveState === "saving" ? "Saving…" : saveState === "error" ? "Couldn't save" : saveState === "saved" ? "Saved" : ""}
        </span>
        <span className={styles.spacer} />
        <IconButton icon="undo-2" label="Undo" data-tip="Undo the last edit" kbd="Mod+Z" disabled={!hist || hist.past.length === 0} onClick={doUndo} />
        <IconButton icon="redo-2" label="Redo" data-tip="Redo the edit you just undid" kbd="Mod+Shift+Z" disabled={!hist || hist.future.length === 0} onClick={doRedo} />
        {postSlide && (
          <Button size="sm" icon="arrow-left" collapsible data-tip="Save and return to the post this video belongs to" onClick={() => void backToPost()}>
            Back to post
          </Button>
        )}
        <Button size="sm" icon="play" collapsible data-tip={blocked ? "Install the missing tools first" : clips.length === 0 ? "Add a clip first" : "Render a short exact preview with titles, transitions and music, as the export will look"} loading={busyPreview} disabled={blocked || clips.length === 0} onClick={() => void submit("preview")}>
          Render preview
        </Button>
        <Button size="sm" variant="primary" icon="download" collapsible data-tip={blocked ? "Install the missing tools first" : clips.length === 0 ? "Add a clip first" : "Render the final video file into your library"} loading={busyExport} disabled={blocked || clips.length === 0} onClick={() => void submit("export")}>
          Export
        </Button>
      </div>

      {warnings.length > 0 && (
        <Banner tone="warn" className={styles.banner}>
          {warnings.join(" · ")}
        </Banner>
      )}
      <JobBar label="Exporting" jobId={exportJobId} />
      <JobBar label="Rendering the preview" jobId={previewJobId} />
      <JobBar label="Building your vlog" jobId={planJobId} />
      {exported && (
        <Banner
          tone="info"
          className={styles.banner}
          title={`Exported ${exported.name}`}
          action={
            <div className={styles.exportActions}>
              <Button size="sm" data-tip="Show the exported file in your file manager" onClick={() => void LibraryService.RevealPath(exported.path).catch(() => undefined)}>
                {revealLabel}
              </Button>
              <Button size="sm" data-tip="Open the exported video in Subtitles to transcribe and add captions" onClick={() => useUI.getState().handOff({ moduleId: "subtitles", inputs: [exported.path] })}>
                Add captions with Subtitles
              </Button>
              <Button size="sm" data-tip="Add the exported video to an Instagram post in Post Builder" onClick={() => useUI.getState().handOff({ moduleId: "post-builder", inputs: [exported.path] })}>
                Add to post…
              </Button>
              <IconButton size="sm" icon="x" label="Dismiss" data-tip="Hide this message" onClick={() => setExported(null)} />
            </div>
          }
        />
      )}
      {exact && (
        <Banner
          tone={exactStale ? "warn" : "info"}
          className={styles.banner}
          action={
            <div className={styles.exportActions}>
              {exactStale && (
                <Button size="sm" data-tip="Render the exact preview again with your latest edits" onClick={() => void submit("preview")}>
                  Render again
                </Button>
              )}
              <IconButton size="sm" icon="x" label="Dismiss exact preview" data-tip="Go back to the quick preview of your edits" onClick={() => setExact(null)} />
            </div>
          }
        >
          {exactStale ? `Exact preview is out of date (rendered ${ago} s ago)` : `Exact preview (rendered ${ago} s ago)`}
        </Banner>
      )}

      <div className={styles.main}>
        <div className={styles.previewCol}>
          {showExact && exactUrl ? (
            <ExactPlayer ref={player} url={exactUrl} aspect={doc.aspect} initialMs={timeMs} onTime={setTimeMs} onPlayingChange={setPlaying} />
          ) : (
            <SequencePlayer
              ref={player}
              doc={doc}
              spans={spans}
              totalMs={totalMs}
              sources={sources}
              infos={infos}
              {...(musicUrl ? { musicUrl } : {})}
              onTime={setTimeMs}
              onPlayingChange={setPlaying}
            />
          )}
          <div className={styles.transport}>
            <IconButton icon={playing ? "pause" : "play"} label={playing ? "Pause" : "Play"} data-tip={playing ? "Pause playback" : "Play the video from the playhead"} kbd="Space" disabled={totalMs <= 0} onClick={() => player.current?.toggle()} />
            <span className={styles.time} data-testid="time-readout" data-tip="Playhead time / total length">
              {formatMs(timeMs)} / {formatMs(totalMs)}
            </span>
            <span data-tip="Drag to move the playhead through the video" style={{ display: "contents" }}><Slider aria-label="Position" min={0} max={Math.max(totalMs, 1)} step={10} value={Math.min(timeMs, Math.max(totalMs, 1))} format={() => ""} onChange={seek} disabled={totalMs <= 0} /></span>
            <IconButton icon="scissors" label="Split at the playhead" data-tip="Cut the clip under the playhead into two clips" kbd="S" disabled={clips.length === 0} onClick={split} />
          </div>
          <Inspector
            doc={doc}
            selection={selection}
            spans={spans}
            infos={infos}
            fonts={fonts}
            titleTextRef={titleText}
            titleFocus={titleFocus}
            onTitleFocused={() => setTitleFocus(null)}
            onChange={edit}
            onPickMusic={() => void pickSong(false)}
            onSelect={setSelection}
            trailing={
              postSlide ? (
                <ClickIn icon="images" title="Sources" summary="Photos and videos in this post" tip="Photos and videos in this post that you can add to the timeline" width={380} className={styles.launcher}>
                  <SourcesTab postId={postSlide.postId} onAdd={(paths) => void addPaths(paths)} />
                </ClickIn>
              ) : undefined
            }
          />
        </div>
      </div>

      <TimelinePanel
        doc={doc}
        spans={spans}
        totalMs={totalMs}
        timeMs={timeMs}
        playing={playing}
        selection={selection}
        infos={infos}
        onSelect={setSelection}
        onSeek={seek}
        onChange={edit}
        onEditTitle={(id) => {
          setSelection({ kind: "title", id });
          setTitleFocus(id);
        }}
        onAddClips={() => void pickClips()}
        onAddTitle={addTitle}
        onPickMusic={() => void pickSong(false)}
        onDropSources={(paths, index) => void addPaths(paths, index)}
      />
      {loaders}
      {dialog}
    </ClickInHost>
  );
}
