import { useEffect, useMemo, useRef, useState } from "react";
import { Banner, Button, IconButton, Slider, Spinner, Switch } from "@/components";
import { MediaPlayer, Timeline, formatMs, useMediaSource, type Marker, type MediaPlayerHandle, type Range } from "@/components/media";
import type { PostLimits, PostSlide, ProjectInfo } from "@/lib/api";
import { FramedMedia } from "./FramedMedia";
import { clampZoom, normalizeRotation } from "./framing";
import { isPending, maxClipMs } from "./logic";
import { KIND_ICON, KIND_LABEL } from "./SlideStrip";
import { useSlideVisual } from "./useSlideVisual";
import styles from "./SlideStage.module.css";

export interface SlideStageProps {
  slide: PostSlide;
  format: string;
  aspect: string;
  project: ProjectInfo | undefined;
  limits: PostLimits;
  onChange: (patch: Partial<PostSlide>) => void;
  /** Opens Photo Composer / Video Editor for this slide. */
  onEdit: () => void;
}

export function SlideStage({ slide, format, aspect, project, limits, onChange, onEdit }: SlideStageProps) {
  const isClip = slide.kind === "clip";
  const isProject = slide.kind === "composition" || slide.kind === "video";
  const [stillMs, setStillMs] = useState(slide.inMs);
  useEffect(() => setStillMs(slide.inMs), [slide.id, slide.inMs]);

  const stillSlide = useMemo(() => (isClip ? { ...slide, inMs: stillMs } : slide), [slide, isClip, stillMs]);
  const visual = useSlideVisual(stillSlide, project, 1280);
  const framable = slide.kind !== "video";
  const pending = isPending(slide);

  const patchFraming = (p: Partial<Pick<PostSlide, "zoom" | "panX" | "panY">>) => onChange(p);
  const rotate = (dir: 1 | -1) => onChange({ rotation: normalizeRotation(slide.rotation + dir * 90) });
  const reset = () => onChange({ zoom: 1, panX: 0, panY: 0, rotation: 0 });

  return (
    <section className={styles.root} aria-label="Selected slide">
      <div className={styles.area}>
        {pending ? (
          <div className={styles.pending}>
            <p>{slide.kind === "composition" ? "This composition isn't made yet." : "This video isn't made yet."}</p>
            <Button variant="primary" icon="pencil" data-tip={slide.kind === "composition" ? "Open Photo Composer to design this slide" : "Open Video Editor to make this slide"} onClick={onEdit}>
              {slide.kind === "composition" ? "Make it in Photo Composer" : "Make it in Video Editor"}
            </Button>
          </div>
        ) : (
          <FramedMedia
            key={slide.id}
            fit
            url={visual.url}
            aspect={aspect}
            framing={framable ? slide : { zoom: 1, panX: 0, panY: 0, rotation: 0 }}
            onFraming={framable ? patchFraming : undefined}
            placeholderIcon={KIND_ICON[slide.kind] ?? "image"}
            loading={visual.status === "loading"}
            alt={slide.altText || KIND_LABEL[slide.kind]}
          />
        )}
      </div>

      {visual.status === "error" && !pending && (
        <Banner tone="danger" title="This picture can't be shown">
          {slide.path ? "The file may have moved or be in a format the preview can't read." : "The project has no picture yet; open it and save."}
        </Banner>
      )}

      <div className={styles.controls}>
        {framable && !pending && (
          <>
            <label className={styles.zoom} data-tip="Zoom into the picture to choose what shows in the frame (or scroll over it)">
              <span className={styles.label}>Zoom</span>
              <Slider aria-label="Zoom" min={1} max={4} step={0.01} value={slide.zoom} onChange={(v) => onChange({ zoom: clampZoom(v) })} format={(v) => `${v.toFixed(2)}×`} />
            </label>
            <IconButton icon="rotate-ccw" label="Rotate left" data-tip="Turn the picture 90 degrees counter-clockwise" onClick={() => rotate(-1)} />
            <IconButton icon="rotate-cw" label="Rotate right" data-tip="Turn the picture 90 degrees clockwise" onClick={() => rotate(1)} />
            <Button size="sm" variant="ghost" data-tip="Undo zoom, position and rotation so the picture fills the frame again" onClick={reset} disabled={slide.zoom === 1 && slide.panX === 0 && slide.panY === 0 && slide.rotation === 0}>
              Reset framing
            </Button>
          </>
        )}
        {isProject && !pending && (
          <Button icon="pencil" data-tip={slide.kind === "composition" ? "Open this composition in Photo Composer" : "Open this video in Video Editor"} onClick={onEdit}>
            Edit {slide.kind === "composition" ? "composition" : "video"}
          </Button>
        )}
        {isProject && !pending && project && <span className={styles.projectName} data-tip="The saved project behind this slide">{project.name}</span>}
      </div>

      {isClip && <ClipControls slide={slide} format={format} limits={limits} onChange={onChange} onSeek={setStillMs} />}
    </section>
  );
}

function ClipControls({
  slide,
  format,
  limits,
  onChange,
  onSeek,
}: {
  slide: PostSlide;
  format: string;
  limits: PostLimits;
  onChange: (patch: Partial<PostSlide>) => void;
  onSeek: (ms: number) => void;
}) {
  const media = useMediaSource(slide.path);
  const source = media.status === "ready" ? media.source : undefined;
  const durationMs = source?.info.durationMs ?? 0;
  const [playhead, setPlayhead] = useState(0);
  const player = useRef<MediaPlayerHandle>(null);
  const limit = maxClipMs(limits, format);

  // A newly probed clip with no sensible Out takes its whole length (up to the limit).
  useEffect(() => {
    if (durationMs > 0 && slide.outMs <= slide.inMs) onChange({ inMs: 0, outMs: Math.min(durationMs, limit) });
  }, [durationMs]); // eslint-disable-line react-hooks/exhaustive-deps

  const ranges = useMemo<Range[]>(() => [{ id: "trim", startMs: slide.inMs, endMs: Math.max(slide.outMs, slide.inMs + 1), label: "In – Out" }], [slide.inMs, slide.outMs]);
  const markers = useMemo<Marker[]>(
    () => (durationMs > 0 && slide.inMs + limit < durationMs ? [{ id: "limit", startMs: slide.inMs + limit, label: `${limit / 1000} s limit`, tone: "warn" }] : []),
    [slide.inMs, limit, durationMs],
  );

  const seek = (ms: number) => {
    const t = Math.max(0, ms);
    player.current?.seek(t);
    setPlayhead(t);
    onSeek(t);
  };
  const now = () => player.current?.currentMs() ?? playhead;
  const length = slide.outMs - slide.inMs;

  return (
    <div className={styles.clip}>
      {media.status === "error" && <Banner tone="danger" title="This clip can't be opened">{media.error?.message}</Banner>}
      {(media.status === "loading" || media.status === "preparing") && (
        <p className={styles.hint}>
          <Spinner size={14} label="Opening the clip" /> {media.status === "preparing" ? "Making a preview copy…" : "Opening…"}
        </p>
      )}
      {source && (
        <>
          <div className={styles.player}>
            <MediaPlayer
              ref={player}
              source={source}
              kind="video"
              keyboard={false}
              onTime={(ms) => {
                setPlayhead(ms);
              }}
            />
          </div>
          <Timeline
            durationMs={durationMs}
            playheadMs={playhead}
            onSeek={seek}
            ranges={ranges}
            selectedRange="trim"
            markers={markers}
            frameMs={source.info.video?.fps ? 1000 / source.info.video.fps : undefined}
            onRangesChange={(rs) => {
              const r = rs.find((x) => x.id === "trim");
              if (r) onChange({ inMs: Math.round(r.startMs), outMs: Math.round(r.endMs) });
            }}
          />
          <div className={styles.trimRow}>
            <Button size="sm" variant="secondary" data-tip="Start the clip at the current playback position" onClick={() => onChange({ inMs: Math.min(Math.round(now()), Math.max(0, slide.outMs - 100)) })}>
              Set In
            </Button>
            <Button size="sm" variant="secondary" data-tip="End the clip at the current playback position" onClick={() => onChange({ outMs: Math.max(Math.round(now()), slide.inMs + 100) })}>
              Set Out
            </Button>
            <span className={styles.mono} data-testid="clip-range" data-tip="Where the clip starts and ends in the source video, and how long it will be">
              {formatMs(slide.inMs)} – {formatMs(slide.outMs)} ({(length / 1000).toFixed(1)} s)
            </span>
            <span className={styles.spacer} />
            <Switch checked={slide.mute} onChange={(mute) => onChange({ mute })} label="Mute" tip="Export this clip without its sound" />
          </div>
          {length > limit && (
            <Banner tone="warn" title={`Over the ${limit / 1000} s limit`}>
              Instagram takes up to {limit / 1000} seconds for this slide. Move In or Out to shorten it.
            </Banner>
          )}
        </>
      )}
    </div>
  );
}
