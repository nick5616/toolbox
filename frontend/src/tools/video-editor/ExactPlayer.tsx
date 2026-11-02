// Plays the rendered 540p preview file in place of the sequence player.
import { forwardRef, useEffect, useImperativeHandle, useRef, type CSSProperties } from "react";
import { aspectRatio } from "./timeline";
import type { PlayerHandle } from "./playerTypes";
import styles from "./SequencePlayer.module.css";

export interface ExactPlayerProps {
  url: string;
  aspect: string;
  initialMs: number;
  onTime: (ms: number) => void;
  onPlayingChange: (playing: boolean) => void;
}

export const ExactPlayer = forwardRef<PlayerHandle, ExactPlayerProps>(function ExactPlayer(
  { url, aspect, initialMs, onTime, onPlayingChange },
  ref,
) {
  const el = useRef<HTMLVideoElement>(null);
  const live = useRef({ onTime, onPlayingChange });
  live.current = { onTime, onPlayingChange };

  useImperativeHandle(ref, () => ({
    play() {
      void el.current?.play()?.catch(() => undefined);
    },
    pause() {
      el.current?.pause();
    },
    toggle() {
      const v = el.current;
      if (!v) return;
      if (v.paused) void v.play()?.catch(() => undefined);
      else v.pause();
    },
    seek(ms: number) {
      const v = el.current;
      if (v) v.currentTime = Math.max(0, ms) / 1000;
    },
    playing: () => !!el.current && !el.current.paused && !el.current.ended,
  }));

  useEffect(() => {
    const v = el.current;
    if (!v) return;
    let raf = 0;
    const loop = () => {
      live.current.onTime(v.currentTime * 1000);
      raf = requestAnimationFrame(loop);
    };
    const onPlay = () => {
      live.current.onPlayingChange(true);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    };
    const onPause = () => {
      cancelAnimationFrame(raf);
      live.current.onPlayingChange(false);
      live.current.onTime(v.currentTime * 1000);
    };
    const onSeeked = () => live.current.onTime(v.currentTime * 1000);
    const onMeta = () => {
      if (initialMs > 0) v.currentTime = initialMs / 1000;
    };
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onPause);
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("loadedmetadata", onMeta);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onPause);
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("loadedmetadata", onMeta);
    };
    // initialMs is only read once, when the file loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return (
    <div className={styles.stage}>
      <div className={styles.frame} style={{ "--ar": String(aspectRatio(aspect)) } as CSSProperties}>
        <video ref={el} src={url} className={`${styles.media} ${styles.contain}`} playsInline preload="auto" data-testid="exact-video" />
      </div>
    </div>
  );
});
