// The sequence player (SPEC.md Part B §B6.5): the project's clips played one
// after another in two alternating <video> elements, framed in CSS the way the
// render frames them. It approximates the render; "Render preview" is exact.
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { cx } from "@/components";
import type { VideoClip, VideoClipInfo, VideoProject, VideoTitle } from "@/lib/api";
import type { SourceMap } from "./ClipSources";
import { displaySize, clipsOf, titlesOf } from "./edit";
import { fillTransform, layersAt, lookFilter, musicGain, photoMotion, type Layer } from "./schedule";
import { aspectRatio, type Span } from "./timeline";
import type { PlayerHandle } from "./playerTypes";
import styles from "./SequencePlayer.module.css";

export interface SequencePlayerProps {
  doc: VideoProject;
  spans: Span[];
  totalMs: number;
  sources: SourceMap;
  infos: Record<string, VideoClipInfo | undefined>;
  /** The song's URL once resolved. */
  musicUrl?: string;
  onTime: (ms: number) => void;
  onPlayingChange: (playing: boolean) => void;
}

const DRIFT_PLAYING_S = 0.3;
const DRIFT_PAUSED_S = 0.04;

/** The title blocks visible at time t. */
export function titlesAt(titles: readonly VideoTitle[], t: number): VideoTitle[] {
  return titles.filter((x) => t >= x.startMs && t < x.startMs + x.durationMs);
}

interface ClipLayerProps {
  clip: VideoClip;
  layer: Layer | undefined;
  idx: number;
  src: SourceMap[string];
  info: VideoClipInfo | undefined;
  frameAspect: number;
  videoRef: (el: HTMLVideoElement | null) => void;
  canvasRef: (el: HTMLCanvasElement | null) => void;
}

function ClipLayer({ clip, layer, idx, src, info, frameAspect, videoRef, canvasRef }: ClipLayerProps) {
  const isVideo = clip.kind === "video";
  const ready = src?.status === "ready" && !!src.url;
  const sz = info ? displaySize(info) : { w: 0, h: 0 };
  const srcAspect = sz.w > 0 && sz.h > 0 ? sz.w / sz.h : 0;

  const mediaStyle: CSSProperties = {};
  if (clip.fit === "fill") {
    const f = fillTransform(srcAspect, frameAspect, clip.zoom || 1, clip.panX, clip.panY);
    mediaStyle.transform = `translate(${f.tx * 100}%, ${f.ty * 100}%) scale(${f.scale})`;
  }
  const motion = !isVideo && layer ? photoMotion(clip.motion, layer.progress) : { scale: 1, tx: 0 };
  const motionStyle: CSSProperties =
    motion.scale === 1 && motion.tx === 0 ? {} : { transform: `translateX(${motion.tx * 100}%) scale(${motion.scale})` };

  const style: CSSProperties = {
    zIndex: idx + 1,
    opacity: layer ? layer.opacity : 0,
    visibility: layer ? "visible" : "hidden",
    transform: layer && layer.offsetX !== 0 ? `translateX(${layer.offsetX * 100}%)` : undefined,
    filter: lookFilter(clip.look),
    ...(clip.fit === "fit-color" ? { background: clip.fitColor } : {}),
  };
  const fitClass = clip.fit === "fill" ? styles.cover : styles.contain;

  return (
    <div className={styles.layer} style={style} data-testid={`layer-${idx}`} data-fit={clip.fit}>
      <div className={styles.motion} style={motionStyle}>
        {ready && clip.fit === "fit-blur" &&
          (isVideo ? (
            <canvas ref={canvasRef} className={styles.blur} width={48} height={Math.max(8, Math.round(48 / frameAspect))} />
          ) : (
            <img src={src?.url} alt="" className={cx(styles.blur, styles.cover)} />
          ))}
        {ready && isVideo && (
          <video
            ref={videoRef}
            key={src?.url}
            src={src?.url}
            className={cx(styles.media, fitClass)}
            style={mediaStyle}
            playsInline
            preload="auto"
          />
        )}
        {ready && !isVideo && <img src={src?.url} alt="" className={cx(styles.media, fitClass)} style={mediaStyle} />}
      </div>
      {!ready && (
        <div className={styles.status}>
          {src?.status === "error"
            ? src.error
            : src?.status === "preparing"
              ? `Preparing a preview copy${src.progress !== undefined ? ` ${Math.round(src.progress * 100)}%` : ""}…`
              : "Loading…"}
        </div>
      )}
    </div>
  );
}

export const SequencePlayer = forwardRef<PlayerHandle, SequencePlayerProps>(function SequencePlayer(
  { doc, spans, totalMs, sources, infos, musicUrl, onTime, onPlayingChange },
  ref,
) {
  const clips = clipsOf(doc);
  const titles = titlesOf(doc);
  const frameAspect = aspectRatio(doc.aspect);

  const [t, setT] = useState(0);
  const [playing, setPlayingState] = useState(false);
  const tRef = useRef(0);
  const playingRef = useRef(false);
  const live = useRef({ totalMs, onTime, onPlayingChange });
  live.current = { totalMs, onTime, onPlayingChange };

  const videos = useRef<(HTMLVideoElement | null)[]>([null, null]);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([null, null]);
  const audio = useRef<HTMLAudioElement>(null);

  const setPlaying = (p: boolean) => {
    if (playingRef.current === p) return;
    playingRef.current = p;
    setPlayingState(p);
    live.current.onPlayingChange(p);
  };
  const moveTo = (ms: number) => {
    const v = Math.min(Math.max(ms, 0), live.current.totalMs);
    tRef.current = v;
    setT(v);
    live.current.onTime(v);
  };

  useImperativeHandle(ref, () => ({
    play() {
      if (live.current.totalMs <= 0) return;
      if (tRef.current >= live.current.totalMs - 1) moveTo(0);
      setPlaying(true);
    },
    pause() {
      setPlaying(false);
    },
    toggle() {
      if (playingRef.current) setPlaying(false);
      else {
        if (live.current.totalMs <= 0) return;
        if (tRef.current >= live.current.totalMs - 1) moveTo(0);
        setPlaying(true);
      }
    },
    seek(ms: number) {
      moveTo(ms);
    },
    playing: () => playingRef.current,
  }));

  // The clock.
  useEffect(() => {
    if (!playing) return;
    const startWall = performance.now();
    const startT = tRef.current;
    let raf = 0;
    const tick = (now: number) => {
      let nt = startT + (now - startWall);
      const end = live.current.totalMs;
      if (nt >= end) {
        nt = end;
        moveTo(nt);
        setPlaying(false);
        return;
      }
      moveTo(nt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- moveTo/setPlaying only touch refs and stable setters
  }, [playing]);

  // The project got shorter than the playhead.
  useEffect(() => {
    if (tRef.current > totalMs) moveTo(totalMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalMs]);

  const layers = useMemo(() => layersAt(clips, spans, t), [clips, spans, t]);

  // Which clip each of the two slots holds: the visible ones, then the next to preload.
  const slots: (number | undefined)[] = [undefined, undefined];
  for (const l of layers) slots[l.index % 2] = l.index;
  const top = layers.length > 0 ? Math.max(...layers.map((l) => l.index)) : -1;
  if (top >= 0 && top + 1 < clips.length && slots[(top + 1) % 2] === undefined) slots[(top + 1) % 2] = top + 1;
  if (top < 0 && clips.length > 0) slots[0] = 0;

  // Keep the elements on the timeline.
  useLayoutEffect(() => {
    for (let s = 0; s < 2; s++) {
      const el = videos.current[s];
      const idx = slots[s];
      const clip = idx === undefined ? undefined : clips[idx];
      if (!el || !clip || clip.kind !== "video") continue;
      const layer = layers.find((l) => l.index === idx);
      try {
        if (layer) {
          const want = layer.sourceMs / 1000;
          el.playbackRate = clip.speed > 0 ? clip.speed : 1;
          el.muted = clip.volume <= 0;
          el.volume = Math.min(1, Math.max(0, clip.volume * layer.gain));
          const drift = Math.abs(el.currentTime - want);
          if (playing) {
            if (drift > DRIFT_PLAYING_S) el.currentTime = want;
            if (el.paused) void el.play()?.catch(() => undefined);
          } else {
            if (!el.paused) el.pause();
            if (drift > DRIFT_PAUSED_S) el.currentTime = want;
          }
          const cv = canvases.current[s];
          const ctx = cv?.getContext("2d");
          if (cv && ctx && el.readyState >= 2) ctx.drawImage(el, 0, 0, cv.width, cv.height);
        } else {
          if (!el.paused) el.pause();
          const want = clip.inMs / 1000;
          if (Math.abs(el.currentTime - want) > 0.1) el.currentTime = want;
        }
      } catch {
        /* an element that isn't ready yet: the next tick retries */
      }
    }
  });

  // Music follows the timeline.
  const music = doc.music;
  useEffect(() => {
    const el = audio.current;
    if (!el || !music || !musicUrl) return;
    try {
      el.volume = Math.min(1, musicGain(music, t, totalMs));
      const want = (music.offsetMs + t) / 1000;
      const drift = Math.abs(el.currentTime - want);
      if (playing) {
        if (drift > DRIFT_PLAYING_S) el.currentTime = want;
        if (el.paused) void el.play()?.catch(() => undefined);
      } else {
        if (!el.paused) el.pause();
        if (drift > DRIFT_PAUSED_S) el.currentTime = want;
      }
    } catch {
      /* not ready */
    }
  });

  const visibleTitles = titlesAt(titles, t);

  return (
    <div className={styles.stage}>
      <div className={styles.frame} style={{ "--ar": String(frameAspect) } as CSSProperties} data-testid="player-frame" data-tip="Quick preview of your edits; use Render preview for the exact result">
        {[0, 1].map((s) => {
          const idx = slots[s];
          const clip = idx === undefined ? undefined : clips[idx];
          if (idx === undefined || !clip) return null;
          return (
            <ClipLayer
              key={s}
              idx={idx}
              clip={clip}
              layer={layers.find((l) => l.index === idx)}
              src={sources[clip.path]}
              info={infos[clip.path]}
              frameAspect={frameAspect}
              videoRef={(el) => {
                videos.current[s] = el;
              }}
              canvasRef={(el) => {
                canvases.current[s] = el;
              }}
            />
          );
        })}
        {clips.length === 0 && <div className={styles.empty}>Add clips to see them here</div>}
        <div className={styles.titles}>
          {visibleTitles.map((x) => (
            <div
              key={x.id}
              data-testid="title-overlay"
              className={cx(styles.title, styles[`style-${x.style}`], styles[`pos-${x.position}`])}
              style={{ color: x.color, fontFamily: x.font ? `"${x.font}", sans-serif` : undefined }}
            >
              <span>{x.text}</span>
            </div>
          ))}
        </div>
      </div>
      {music && musicUrl && <audio ref={audio} src={musicUrl} preload="auto" data-testid="music-audio" />}
    </div>
  );
});
