/**
 * Playing a clip or video slide on the stage. Nothing is opened until the user
 * presses Play: a clip opens its file (a preview copy is made when the webview
 * can't play it), a video slide plays its Video Editor project's preview,
 * rendering one first when there is none newer than the project's last save.
 * A clip plays from In to Out and loops, muted when the slide is muted.
 */
import { useCallback, useEffect, useRef, useState, type RefCallback } from "react";
import { useMediaSource } from "@/components/media";
import { JobStatus, VideoEditorService, type PostSlide, type ProjectInfo } from "@/lib/api";
import { toAppError, type AppErrorShape } from "@/lib/errors";
import { muteWhenDone, useJobs } from "@/state/jobs";
import { isPending } from "./logic";
import { notePreviewMade } from "./useSlideVisual";

export type PlaybackPhase = "idle" | "rendering" | "opening" | "preparing" | "ready" | "error";

export interface SlidePlayback {
  /** The slide is a clip or a made video. */
  playable: boolean;
  phase: PlaybackPhase;
  /** 0..1 while a preview is rendered or a preview copy is made. */
  progress?: number;
  error?: AppErrorShape;
  /** The user wants it playing (it may still be opening). */
  wanted: boolean;
  playing: boolean;
  /** Length of what plays (ms; 0 until known). */
  lengthMs: number;
  /** For `FramedMedia`'s `video` (undefined until there is something to play). */
  video?: { src: string; ref: RefCallback<HTMLVideoElement>; muted: boolean; visible: boolean };
  toggle(): void;
  /** Jumps to a time within what plays (ms from its start). */
  seek(ms: number): void;
  /** The play position (ms from In), for `useSyncExternalStore`. */
  subscribe(fn: () => void): () => void;
  position(): number;
}

/** `stillMs`: the frame the stage shows while trimming; a paused video makes way for it when it moves. */
export function useSlidePlayback(slide: PostSlide, project: ProjectInfo | undefined, stillMs = slide.inMs): SlidePlayback {
  const isClip = slide.kind === "clip";
  const playable = (isClip && slide.path !== "") || (slide.kind === "video" && !isPending(slide));

  const [wanted, setWanted] = useState(false);
  const [requested, setRequested] = useState(false);
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [renderJobId, setRenderJobId] = useState("");
  const [renderError, setRenderError] = useState<AppErrorShape | null>(null);
  /** Bumped by Play after a failed preview, to try again. */
  const [attempt, setAttempt] = useState(0);
  const job = useJobs((s) => (renderJobId ? s.byId[renderJobId] : undefined));

  const media = useMediaSource(!requested || !playable ? null : isClip ? slide.path : videoPath);
  const src = media.status === "ready" ? media.source?.url : undefined;
  const startMs = media.source?.info.startMs || 0;
  const durationMs = media.source?.info.durationMs || 0;
  const inMs = isClip ? slide.inMs : 0;
  const outMs = isClip && slide.outMs > slide.inMs ? slide.outMs : durationMs;
  const lengthMs = Math.max(0, outMs - inMs);

  // A video slide plays its project's preview, made now if missing or older than the project.
  const projectId = slide.kind === "video" ? slide.projectId : "";
  const projectVersion = project?.updatedAt ?? 0;
  useEffect(() => {
    if (!requested || !projectId || !playable) return;
    let cancelled = false;
    setVideoPath(null);
    setRenderError(null);
    void (async () => {
      try {
        const fresh = await VideoEditorService.FreshPreviewPath(projectId);
        if (cancelled) return;
        if (fresh) {
          // Its still may have been read before the preview existed (made by a stage that closed).
          notePreviewMade(projectId);
          setVideoPath(fresh);
          return;
        }
        const j = await VideoEditorService.Preview(projectId);
        // It plays here when done: no "Finished" toast.
        muteWhenDone(j.id);
        useJobs.getState().upsert(j);
        if (!cancelled) setRenderJobId(j.id);
      } catch (e) {
        if (!cancelled) setRenderError(toAppError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requested, projectId, projectVersion, playable, attempt]);

  const jobStatus = job?.status;
  useEffect(() => {
    if (!renderJobId || !jobStatus) return;
    if (jobStatus === JobStatus.JobDone) {
      setRenderJobId("");
      void VideoEditorService.PreviewPath(projectId).then(
        (p) => {
          if (!p) {
            setRenderError({ code: "internal", message: "The preview wasn't saved." });
            return;
          }
          notePreviewMade(projectId);
          setVideoPath(p);
        },
        (e: unknown) => setRenderError(toAppError(e)),
      );
    } else if (jobStatus === JobStatus.JobFailed || jobStatus === JobStatus.JobCancelled) {
      setRenderJobId("");
      setWanted(false);
      setRenderError(
        jobStatus === JobStatus.JobCancelled
          ? { code: "cancelled", message: "Making the preview was cancelled." }
          : { code: job?.errorCode || "internal", message: job?.error || "The preview couldn't be made.", ...(job?.errorHint ? { hint: job.errorHint } : {}) },
      );
    }
  }, [renderJobId, jobStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the <video> element ----
  const [el, setEl] = useState<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [shown, setShown] = useState(false);
  const live = useRef({ inMs, outMs, startMs, wanted });
  live.current = { inMs, outMs, startMs, wanted };

  const pos = useRef(0);
  const subs = useRef(new Set<() => void>());
  const publish = useCallback((ms: number) => {
    if (pos.current === ms) return;
    pos.current = ms;
    for (const fn of subs.current) fn();
  }, []);
  const readPos = useCallback((): number => {
    const v = el;
    if (!v) return pos.current;
    const l = live.current;
    return Math.min(Math.max(0, v.currentTime * 1000 - l.startMs - l.inMs), Math.max(0, l.outMs - l.inMs));
  }, [el]);

  useEffect(() => {
    if (!el) return;
    const toIn = () => {
      const l = live.current;
      el.currentTime = (l.inMs + l.startMs) / 1000;
    };
    const onMeta = () => {
      toIn();
      if (live.current.wanted) void el.play().catch(() => undefined);
    };
    const onPlay = () => setPlaying(true);
    const onPlaying = () => setShown(true);
    const onPause = () => {
      setPlaying(false);
      publish(readPos());
    };
    const onEnded = () => {
      toIn();
      if (live.current.wanted) void el.play().catch(() => undefined);
    };
    const onSeeked = () => publish(readPos());
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("play", onPlay);
    el.addEventListener("playing", onPlaying);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    el.addEventListener("seeked", onSeeked);
    if (el.readyState >= 1) onMeta();
    return () => {
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("playing", onPlaying);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("seeked", onSeeked);
    };
  }, [el, publish, readPos]);

  // Play or pause as asked (once the element has its metadata; onMeta covers the rest).
  useEffect(() => {
    if (!el || el.readyState < 1) return;
    if (wanted) void el.play().catch(() => undefined);
    else el.pause();
  }, [el, wanted, src]);

  // Paused and trimmed (or the Trim panel's playhead moved): show the still instead of an old frame.
  useEffect(() => {
    if (!live.current.wanted) setShown(false);
  }, [stillMs, inMs]);

  // React doesn't keep `muted` in step after mount.
  useEffect(() => {
    if (el) el.muted = slide.mute;
  }, [el, slide.mute]);

  // While playing: loop at Out, jump to In when In moved past the play position, report the position.
  useEffect(() => {
    if (!el || !playing) return;
    let raf = 0;
    const tick = () => {
      const l = live.current;
      const ms = el.currentTime * 1000 - l.startMs;
      if ((l.outMs > l.inMs && ms >= l.outMs) || ms < l.inMs - 50) el.currentTime = (l.inMs + l.startMs) / 1000;
      publish(readPos());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [el, playing, publish, readPos]);

  const toggle = useCallback(() => {
    if (!playable) return;
    setRequested(true);
    if (!wanted && renderError) {
      setRenderError(null);
      setAttempt((n) => n + 1);
    }
    if (!wanted && media.status === "error") media.retry();
    setWanted(!wanted);
  }, [playable, wanted, media, renderError]);

  const seek = useCallback(
    (ms: number) => {
      const l = live.current;
      const t = Math.min(Math.max(0, ms), Math.max(0, l.outMs - l.inMs));
      if (el && el.readyState >= 1) {
        el.currentTime = (l.inMs + t + l.startMs) / 1000;
        setShown(true);
      }
      publish(t);
    },
    [el, publish],
  );

  const subscribe = useCallback((fn: () => void) => {
    subs.current.add(fn);
    return () => subs.current.delete(fn);
  }, []);
  const position = useCallback(() => pos.current, []);

  let phase: PlaybackPhase = "idle";
  let progress: number | undefined;
  let error: AppErrorShape | undefined;
  if (renderError) {
    phase = "error";
    error = renderError;
  } else if (renderJobId) {
    phase = "rendering";
    if (job && job.progress >= 0) progress = Math.min(1, job.progress);
  } else if (requested && media.status === "error") {
    phase = "error";
    error = media.error;
  } else if (requested && media.status === "preparing") {
    phase = "preparing";
    progress = media.progress;
  } else if (src) phase = "ready";
  else if (requested) phase = "opening";

  return {
    playable,
    phase,
    ...(progress !== undefined ? { progress } : {}),
    ...(error ? { error } : {}),
    wanted,
    playing,
    lengthMs,
    ...(src ? { video: { src, ref: setEl, muted: slide.mute, visible: shown } } : {}),
    toggle,
    seek,
    subscribe,
    position,
  };
}
