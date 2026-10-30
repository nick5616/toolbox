/** The designer's preview (SPEC.md §8.3): the live canvas, text from the host or the engine, quality and full screen. */
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Banner, Button, IconButton, SegmentedControl, Spinner } from "@/components";
import { MediaPlayer, computeContentRect, useMediaSource, type ContentRect, type MediaPlayerHandle } from "@/components/media";
import { VisualsCanvas } from "@/components/viz";
import type { Analysis } from "@/viz/analysis";
import type { Show } from "@/viz/types";
import styles from "./designer.module.css";

export type PreviewQuality = "auto" | "full" | "draft";
export type DesignerText = "engine" | { overlay: (rect: ContentRect, timeMs: number) => ReactNode };

export interface PreviewProps {
  inputPath: string;
  analysis: Analysis;
  show: Show;
  aspect: number;
  mode: "full" | "overlay";
  /** The host's player; null = this component plays the file itself. */
  hostPlayer: MediaPlayerHandle | null;
  ownPlayer: RefObject<MediaPlayerHandle | null>;
  text: DesignerText;
  timeMs: number;
  onTime(ms: number): void;
  cover?: string | null;
  image?: string | null;
}

const ZERO: ContentRect = { left: 0, top: 0, width: 0, height: 0 };

/** Fullscreen state for an element, with F / Esc handled by the caller and the browser. */
export function useFullscreen(target: RefObject<HTMLElement | null>): { active: boolean; toggle(): void } {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const on = () => setActive(!!document.fullscreenElement && document.fullscreenElement === target.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, [target]);
  const toggle = useCallback(() => {
    const el = target.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void el.requestFullscreen?.().catch(() => undefined);
  }, [target]);
  return { active, toggle };
}

export function Preview({ inputPath, analysis, show, aspect, mode, hostPlayer, ownPlayer, text, timeMs, onTime, cover, image, fsRef }: PreviewProps & { fsRef: RefObject<(() => void) | null> }) {
  const stage = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<ContentRect>(ZERO);
  const [quality, setQuality] = useState<PreviewQuality>("auto");
  const [fps, setFps] = useState(0);
  const fs = useFullscreen(stage);
  fsRef.current = fs.toggle;

  const media = useMediaSource(hostPlayer ? null : inputPath);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setRect(computeContentRect(el.clientWidth, el.clientHeight, aspect, 1));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);

  const canvas = (
    <VisualsCanvas show={show} analysis={analysis} timeMs={timeMs} aspect={aspect} mode={mode === "overlay" ? "overlay" : "opaque"} quality={quality} cover={cover ?? null} image={image ?? null} onFps={setFps} className={styles.canvas} />
  );
  const words = (r: ContentRect) =>
    text !== "engine" && r.width > 0 ? (
      <div className={styles.textLayer} style={{ left: r.left, top: r.top, width: r.width, height: r.height }}>
        {text.overlay(r, timeMs)}
      </div>
    ) : null;

  let body: ReactNode;
  if (mode === "overlay" && !hostPlayer) {
    if (media.status === "ready" && media.source) {
      body = (
        <MediaPlayer
          ref={ownPlayer}
          source={media.source}
          kind="video"
          onTime={onTime}
          className={styles.videoPlayer}
          overlay={(r) => (
            <div className={styles.overlayRect} style={{ left: r.left, top: r.top, width: r.width, height: r.height }}>
              <VisualsCanvas show={show} analysis={analysis} timeMs={timeMs} aspect={aspect} mode="overlay" quality={quality} onFps={setFps} className={styles.canvasFill} />
              {text !== "engine" && <div className={styles.textLayer}>{text.overlay(r, timeMs)}</div>}
            </div>
          )}
        />
      );
    } else if (media.status === "error") {
      body = (
        <Banner tone="danger" title={media.error?.message ?? "Couldn't open the video"} action={<Button size="sm" onClick={media.retry}>Try again</Button>}>
          {media.error?.hint}
        </Banner>
      );
    } else {
      body = (
        <div className={styles.loading}>
          <Spinner size={18} label="Opening" />
        </div>
      );
    }
  } else {
    body = (
      <>
        <div className={styles.stageFrame}>
          <div
            ref={stage}
            className={styles.stage}
            data-testid="design-stage"
            onClick={() => {
              if (document.fullscreenElement === stage.current) (hostPlayer ?? ownPlayer.current)?.toggle();
            }}
          >
            {canvas}
            {words(rect)}
          </div>
        </div>
        {!hostPlayer &&
          (media.status === "ready" && media.source ? (
            <MediaPlayer ref={ownPlayer} source={media.source} kind="audio" onTime={onTime} className={styles.audioPlayer} />
          ) : media.status === "error" ? (
            <Banner tone="danger" title={media.error?.message ?? "Couldn't open the song"} action={<Button size="sm" onClick={media.retry}>Try again</Button>}>
              {media.error?.hint}
            </Banner>
          ) : (
            <div className={styles.loadingBar}>
              <Spinner size={14} label="Opening" /> Opening the song…
            </div>
          ))}
      </>
    );
  }

  return (
    <div className={styles.preview}>
      {mode === "overlay" && !hostPlayer ? (
        <div ref={stage} className={styles.videoStage}>
          {body}
        </div>
      ) : (
        body
      )}
      <div className={styles.previewBar}>
        <SegmentedControl
          size="sm"
          aria-label="Preview quality"
          value={quality}
          onChange={setQuality}
          options={[
            { value: "auto", label: "Auto" },
            { value: "full", label: "Full" },
            { value: "draft", label: "Draft" },
          ]}
        />
        <span className={styles.fps} aria-label="Frames per second">
          {fps > 0 ? `${Math.round(fps)} fps` : "-- fps"}
        </span>
        <span className={styles.spacer} />
        <IconButton size="sm" icon="maximize" label={fs.active ? "Leave full screen" : "Full screen"} kbd="F" pressed={fs.active} onClick={fs.toggle} />
      </div>
    </div>
  );
}
