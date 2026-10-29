import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { MediaService, type MediaSource } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { cx } from "../cx";
import { IconButton } from "../IconButton";
import { Select } from "../Select";
import { TimecodeInput } from "../TimecodeInput";
import { Waveform } from "./Waveform";
import {
  clamp,
  computeContentRect,
  frameMsFor,
  isActivatable,
  isSliderTarget,
  isTypingTarget,
  formatMs,
  parseTimecodeMs,
  playerKeyAction,
  sameRect,
} from "./logic";
import type { ContentRect, MediaPlayerHandle } from "./types";
import styles from "./MediaPlayer.module.css";

export interface MediaPlayerProps {
  source: MediaSource;
  kind: "video" | "audio";
  /** Called with the timeline time (ms) while playing and after seeks. */
  onTime?: (ms: number) => void;
  onDuration?: (ms: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  /** Drawn over the picture, positioned against its letterboxed rect. */
  overlay?: (rect: ContentRect) => ReactNode;
  /** Keyboard shortcuts active (default true). */
  keyboard?: boolean;
  /**
   * Optional: the file path behind the source. Audio players use it for cover
   * art and a waveform (MediaService.Frame / Waveform).
   */
  path?: string;
  /** Optional precomputed waveform peaks for audio (skips the lookup). */
  waveform?: number[];
  className?: string;
}

const SPEEDS = ["0.25", "0.5", "0.75", "1", "1.25", "1.5", "2"] as const;
const ZERO_RECT: ContentRect = { left: 0, top: 0, width: 0, height: 0 };

/** Video/audio player with our own controls (SPEC.md §3.11). */
export const MediaPlayer = forwardRef<MediaPlayerHandle, MediaPlayerProps>(function MediaPlayer(
  { source, kind, onTime, onDuration, onPlayingChange, overlay, keyboard = true, path, waveform, className },
  ref,
) {
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const startMs = source.info.startMs || 0;
  const durationMs = source.info.durationMs || 0;
  const frameMs = frameMsFor(source.info.video?.fps);

  const [curMs, setCurMs] = useState(0);
  const [playing, setPlayingState] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>("1");
  const [rect, setRect] = useState<ContentRect>(ZERO_RECT);
  const [editing, setEditing] = useState<string | null>(null);
  const [timecodeInvalid, setTimecodeInvalid] = useState(false);

  // Latest values for callbacks that must stay stable.
  const live = useRef({ startMs, durationMs, frameMs, onTime, onDuration, onPlayingChange });
  live.current = { startMs, durationMs, frameMs, onTime, onDuration, onPlayingChange };
  const lastMs = useRef(0);
  const isPlaying = useRef(false);
  /** Position/playing state to restore once a new source has loaded. */
  const pending = useRef<{ ms: number; play: boolean } | null>(null);

  const readMs = useCallback((): number => {
    const el = media.current;
    if (!el) return lastMs.current;
    return Math.max(0, el.currentTime * 1000 - live.current.startMs);
  }, []);

  const emitTime = useCallback(() => {
    const ms = readMs();
    lastMs.current = ms;
    setCurMs(ms);
    live.current.onTime?.(ms);
  }, [readMs]);

  const setPlaying = useCallback((p: boolean) => {
    if (isPlaying.current === p) return;
    isPlaying.current = p;
    setPlayingState(p);
    live.current.onPlayingChange?.(p);
  }, []);

  const seek = useCallback(
    (ms: number) => {
      const el = media.current;
      const max = live.current.durationMs > 0 ? live.current.durationMs : Number.POSITIVE_INFINITY;
      const t = clamp(ms, 0, max);
      lastMs.current = t;
      if (el && el.readyState > 0) el.currentTime = (t + live.current.startMs) / 1000;
      else pending.current = { ms: t, play: pending.current?.play ?? false };
      setCurMs(t);
      live.current.onTime?.(t);
    },
    [],
  );

  const play = useCallback(() => {
    const el = media.current;
    if (!el) return;
    if (live.current.durationMs > 0 && readMs() >= live.current.durationMs - 1) seek(0);
    void el.play().catch(() => undefined);
  }, [readMs, seek]);
  const pause = useCallback(() => {
    media.current?.pause();
  }, []);
  const toggle = useCallback(() => {
    if (isPlaying.current) pause();
    else play();
  }, [pause, play]);
  const step = useCallback(
    (frames: number) => {
      pause();
      seek(readMs() + frames * live.current.frameMs);
    },
    [pause, readMs, seek],
  );

  useImperativeHandle(
    ref,
    (): MediaPlayerHandle => ({
      play,
      pause,
      toggle,
      seek,
      step,
      currentMs: () => (media.current ? readMs() : lastMs.current),
      playing: () => isPlaying.current,
    }),
    [play, pause, toggle, seek, step, readMs],
  );

  // Keep position and playing state when the source URL changes (preview copy arrives, A/B switch).
  const prevUrl = useRef(source.url);
  useLayoutEffect(() => {
    if (prevUrl.current === source.url) return;
    prevUrl.current = source.url;
    pending.current = { ms: lastMs.current, play: isPlaying.current };
    isPlaying.current = false;
    setPlayingState(false);
  }, [source.url]);

  // Smooth time updates while playing.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      emitTime();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, emitTime]);

  // Letterboxed rect.
  const sizeRef = useRef({ w: source.info.video?.width ?? 0, h: source.info.video?.height ?? 0 });
  const recompute = useCallback(() => {
    const st = stage.current;
    if (!st) return;
    const next = computeContentRect(st.clientWidth, st.clientHeight, sizeRef.current.w, sizeRef.current.h);
    setRect((prev) => (sameRect(prev, next) ? prev : next));
  }, []);
  useEffect(() => {
    sizeRef.current = { w: source.info.video?.width ?? 0, h: source.info.video?.height ?? 0 };
    recompute();
  }, [source.info.video?.width, source.info.video?.height, recompute]);
  useEffect(() => {
    const st = stage.current;
    if (!st) return;
    recompute();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(recompute);
    ro.observe(st);
    return () => ro.disconnect();
  }, [recompute]);

  const onLoadedMetadata = () => {
    const el = media.current;
    if (!el) return;
    if (el.videoWidth > 0 && el.videoHeight > 0 && !source.info.video) {
      sizeRef.current = { w: el.videoWidth, h: el.videoHeight };
      recompute();
    }
    const d = live.current.durationMs || (Number.isFinite(el.duration) ? el.duration * 1000 : 0);
    if (d > 0) live.current.onDuration?.(d);
    el.volume = volume;
    el.muted = muted;
    el.playbackRate = Number(speed);
    const p = pending.current;
    pending.current = null;
    if (p) {
      el.currentTime = (p.ms + live.current.startMs) / 1000;
      if (p.play) void el.play().catch(() => undefined);
    }
    emitTime();
  };

  // Key bindings.
  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      const action = playerKeyAction(e);
      if (!action) return;
      if (action.type === "toggle" && isActivatable(e.target)) return;
      // Range sliders own the arrow keys (Timeline handles call preventDefault).
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && isSliderTarget(e.target)) return;
      e.preventDefault();
      switch (action.type) {
        case "toggle":
          toggle();
          break;
        case "seekBy":
          seek(readMs() + action.ms);
          break;
        case "step":
          step(action.frames);
          break;
        case "home":
          seek(0);
          break;
        case "end":
          seek(live.current.durationMs);
          break;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [keyboard, toggle, seek, step, readMs]);

  // Audio extras: cover art and waveform.
  const [cover, setCover] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const hasCover = source.info.hasCover;
  useEffect(() => {
    setCover(null);
    if (kind !== "audio" || !path || !hasCover) return;
    let dead = false;
    MediaService.Frame(path, 0, 512).then(
      (u) => !dead && setCover(u),
      () => undefined,
    );
    return () => {
      dead = true;
    };
  }, [kind, path, hasCover]);
  useEffect(() => {
    setPeaks(null);
    if (kind !== "audio" || waveform || !path) return;
    let dead = false;
    MediaService.Waveform(path, 800).then(
      (p) => !dead && setPeaks(p ?? []),
      () => undefined,
    );
    return () => {
      dead = true;
    };
  }, [kind, path, waveform]);
  const shownPeaks = waveform ?? peaks;

  const commitTimecode = (text: string) => {
    const ms = parseTimecodeMs(text);
    if (ms === null) {
      setTimecodeInvalid(true);
      return;
    }
    setTimecodeInvalid(false);
    seek(ms);
    setEditing(null);
  };

  const common = {
    src: source.url || undefined,
    preload: "auto" as const,
    onLoadedMetadata,
    onPlay: () => setPlaying(true),
    onPause: () => {
      setPlaying(false);
      emitTime();
    },
    onEnded: () => {
      setPlaying(false);
      emitTime();
    },
    onSeeked: emitTime,
    onTimeUpdate: () => {
      if (!isPlaying.current) emitTime();
    },
  };

  const durText = formatDuration(durationMs / 1000);
  const progress = durationMs > 0 ? clamp(curMs / durationMs, 0, 1) : 0;

  return (
    <div className={cx(styles.root, className)} data-testid="media-player">
      <div ref={stage} className={styles.stage}>
        {kind === "video" ? (
          <>
            <video
              ref={media}
              className={styles.video}
              playsInline
              {...common}
              onClick={toggle}
            />
            {overlay && rect.width > 0 && <div className={styles.overlayLayer}>{overlay(rect)}</div>}
          </>
        ) : (
          <div className={styles.audio}>
            <audio ref={media} {...common} />
            {cover ? <img className={styles.cover} src={cover} alt="Cover art" /> : null}
            {shownPeaks && shownPeaks.length > 0 ? (
              <Waveform
                peaks={shownPeaks}
                progress={progress}
                height={cover ? 48 : 96}
                onSeek={(f) => seek(f * durationMs)}
                className={styles.wave}
              />
            ) : null}
          </div>
        )}
      </div>
      <div className={styles.controls}>
        <IconButton label={playing ? "Pause" : "Play"} icon={playing ? "pause" : "play"} kbd="Space" onClick={toggle} />
        <IconButton label="Previous frame" icon="step-back" kbd="," onClick={() => step(-1)} />
        <IconButton label="Next frame" icon="step-forward" kbd="." onClick={() => step(1)} />
        <TimecodeInput
          aria-label="Current time"
          className={styles.time}
          value={editing ?? formatMs(curMs)}
          invalid={timecodeInvalid}
          onFocus={(e) => {
            setEditing(formatMs(curMs));
            e.currentTarget.select();
          }}
          onChange={(v) => {
            setEditing(v);
            setTimecodeInvalid(false);
          }}
          onBlur={() => {
            setEditing(null);
            setTimecodeInvalid(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitTimecode(e.currentTarget.value);
            else if (e.key === "Escape") {
              setEditing(null);
              e.currentTarget.blur();
            }
          }}
        />
        <span className={styles.duration}>/ {durText}</span>
        <span className={styles.spacer} />
        <IconButton
          label={muted || volume === 0 ? "Unmute" : "Mute"}
          icon={muted || volume === 0 ? "volume-x" : "volume-2"}
          onClick={() => {
            const next = !muted;
            setMuted(next);
            if (media.current) media.current.muted = next;
          }}
        />
        <input
          type="range"
          className={styles.volume}
          aria-label="Volume"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          onChange={(e) => {
            const v = Number(e.target.value);
            setVolume(v);
            setMuted(false);
            if (media.current) {
              media.current.volume = v;
              media.current.muted = false;
            }
          }}
        />
        <Select
          size="sm"
          aria-label="Playback speed"
          value={speed}
          options={SPEEDS.map((s) => ({ value: s, label: `${s}×` }))}
          onChange={(v) => {
            setSpeed(v);
            if (media.current) media.current.playbackRate = Number(v);
          }}
        />
      </div>
    </div>
  );
});
