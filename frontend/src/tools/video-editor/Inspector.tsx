// The inspector (SPEC.md Part B §B6.5): clip, title and music settings.
import { useRef, useState, type Ref } from "react";
import { Button, ColorSwatchPicker, Field, Section, SegmentedControl, Select, Slider, Switch, TextArea, TimecodeInput } from "@/components";
import {
  CropOverlay,
  MediaPlayer,
  Timeline,
  formatMs,
  parseTimecodeMs,
  useMediaSource,
  type MediaPlayerHandle,
  type Range,
} from "@/components/media";
import { cropWindow } from "@/components/media/logic";
import type { VideoClip, VideoClipInfo, VideoProject, VideoTitle } from "@/lib/api";
import { clipsOf, deleteClip, deleteTitle, displaySize, setClipRange, setTransition, SPEEDS, titlesOf, updateClip, updateTitle } from "./edit";
import { MAX_PHOTO_MS, MAX_TRANSITION_MS, MIN_PHOTO_MS, MIN_TRANSITION_MS, aspectRatio, type Span } from "./timeline";
import type { Selection } from "./types";
import { useThumb } from "./useThumbs";
import styles from "./Inspector.module.css";

export interface InspectorProps {
  doc: VideoProject;
  selection: Selection;
  spans: Span[];
  infos: Record<string, VideoClipInfo | undefined>;
  fonts: string[];
  titleTextRef?: Ref<HTMLTextAreaElement>;
  onChange: (next: VideoProject, key?: string) => void;
  onPickMusic: () => void;
  onSelect: (s: Selection) => void;
}

const FIT_OPTIONS = [
  { value: "fill", label: "Fill the frame" },
  { value: "fit-blur", label: "Fit, blurred edges" },
  { value: "fit-color", label: "Fit, colour bars" },
] as const;

const LOOK_OPTIONS = ["none", "vivid", "warm", "cool", "mono", "fade", "noir"].map((v) => ({
  value: v,
  label: v === "none" ? "None" : v[0]!.toUpperCase() + v.slice(1),
}));

const MOTION_OPTIONS = [
  { value: "none", label: "None" },
  { value: "in", label: "Zoom in" },
  { value: "out", label: "Zoom out" },
  { value: "left", label: "Pan left" },
  { value: "right", label: "Pan right" },
] as const;

const STYLE_OPTIONS = [
  { value: "title", label: "Title" },
  { value: "lower-third", label: "Lower third" },
  { value: "caption", label: "Caption" },
  { value: "label", label: "Label" },
] as const;

const POSITION_OPTIONS = [
  { value: "top", label: "Top" },
  { value: "center", label: "Centre" },
  { value: "bottom", label: "Bottom" },
] as const;

const TRANSITION_OPTIONS = [
  { value: "cut", label: "Cut" },
  { value: "fade", label: "Fade" },
  { value: "dip", label: "Dip to black" },
  { value: "slide", label: "Slide" },
] as const;

/** A timecode box that keeps what you type until you leave it. */
function TimeField({ label, valueMs, onCommit }: { label: string; valueMs: number; onCommit: (ms: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const parsed = draft === null ? null : parseTimecodeMs(draft);
  const commit = () => {
    if (draft !== null && parsed !== null) onCommit(parsed);
    setDraft(null);
  };
  return (
    <TimecodeInput
      aria-label={label}
      value={draft ?? formatMs(valueMs)}
      invalid={draft !== null && parsed === null}
      onChange={setDraft}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          commit();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Maps the crop window's centre (0..1) to the pan range -1..1 and back. */
export function panFromCenter(c: number, w: number): number {
  return w >= 1 ? 0 : Math.min(1, Math.max(-1, ((c - w / 2) / (1 - w)) * 2 - 1));
}
export function centerFromPan(pan: number, w: number): number {
  return w / 2 + ((1 + pan) / 2) * (1 - w);
}

function ClipTrim({ clip, index, info, frameAspect, onChange, doc }: { clip: VideoClip; index: number; info: VideoClipInfo | undefined; frameAspect: number; doc: VideoProject; onChange: InspectorProps["onChange"] }) {
  const media = useMediaSource(clip.path);
  const strip = useThumb(clip.path, "video");
  const player = useRef<MediaPlayerHandle>(null);
  const [playMs, setPlayMs] = useState(0);
  const source = media.status === "ready" ? media.source : undefined;
  const durationMs = source?.info.durationMs ?? info?.durationMs ?? 0;
  const sz = info ? displaySize(info) : { w: 0, h: 0 };
  const srcAspect = sz.w > 0 && sz.h > 0 ? sz.w / sz.h : 0;
  const win = srcAspect > 0 ? cropWindow(frameAspect, srcAspect) : { w: 1, h: 1 };
  const ranges: Range[] = [{ id: "range", startMs: clip.inMs, endMs: Math.min(clip.outMs, durationMs || clip.outMs), label: "In to Out" }];

  if (!source) {
    return (
      <div className={styles.playerHolder} role="status">
        {media.status === "error" ? media.error?.message : media.status === "preparing" ? `Preparing a preview copy… ${Math.round((media.progress ?? 0) * 100)}%` : "Loading…"}
      </div>
    );
  }
  return (
    <div className={styles.trim}>
      <MediaPlayer
        ref={player}
        className={styles.player}
        source={source}
        kind="video"
        keyboard={false}
        path={clip.path}
        onTime={setPlayMs}
        overlay={
          clip.fit === "fill" && srcAspect > 0
            ? (rect) => (
                <CropOverlay
                  rect={rect}
                  aspect={frameAspect}
                  sourceAspect={srcAspect}
                  x={centerFromPan(clip.panX, win.w)}
                  y={centerFromPan(clip.panY, win.h)}
                  onChange={(x, y) => onChange(updateClip(doc, index, { panX: panFromCenter(x, win.w), panY: panFromCenter(y, win.h) }), `pan-${clip.id}`)}
                />
              )
            : undefined
        }
      />
      <Timeline
        durationMs={durationMs}
        playheadMs={playMs}
        onSeek={(ms) => player.current?.seek(ms)}
        {...(strip ? { filmstripUrl: strip } : {})}
        ranges={ranges}
        onRangesChange={(r) => {
          const first = r[0];
          if (first) onChange(setClipRange(doc, index, first.startMs, first.endMs), `range-${clip.id}`);
        }}
        selectedRange="range"
        zoomable
      />
      <div className={styles.row}>
        <Field label="In">
          <TimeField label="In" valueMs={clip.inMs} onCommit={(ms) => onChange(setClipRange(doc, index, Math.min(ms, Math.max(durationMs, 0)), clip.outMs))} />
        </Field>
        <Field label="Out">
          <TimeField label="Out" valueMs={clip.outMs} onCommit={(ms) => onChange(setClipRange(doc, index, clip.inMs, durationMs > 0 ? Math.min(ms, durationMs) : ms))} />
        </Field>
      </div>
    </div>
  );
}

function ClipInspector({ clip, index, span, p }: { clip: VideoClip; index: number; span: Span | undefined; p: InspectorProps }) {
  const { doc, onChange } = p;
  const clips = clipsOf(doc);
  const info = p.infos[clip.path];
  const isVideo = clip.kind === "video";
  const isLast = index >= clips.length - 1;
  const frameAspect = aspectRatio(doc.aspect);
  const patch = (u: Partial<VideoClip>, key?: string) => onChange(updateClip(doc, index, u), key);
  const name = clip.path.split(/[\\/]/).pop() ?? clip.path;
  const nextSpan = p.spans[index + 1];
  const limit = span && nextSpan ? Math.min(MAX_TRANSITION_MS, Math.floor(span.lenMs / 2), Math.floor(nextSpan.lenMs / 2)) : 0;

  return (
    <div className={styles.body} data-testid="clip-inspector">
      <div className={styles.fileName} title={clip.path}>
        {name}
      </div>
      {info?.error && <div className={styles.warn}>{info.error}</div>}
      {isVideo ? (
        <ClipTrim clip={clip} index={index} info={info} frameAspect={frameAspect} doc={doc} onChange={onChange} />
      ) : (
        <Field label="Shown for">
          <Slider
            aria-label="Duration"
            min={MIN_PHOTO_MS}
            max={MAX_PHOTO_MS}
            step={100}
            value={clip.durationMs}
            format={(v) => `${(v / 1000).toFixed(1)} s`}
            onChange={(v) => patch({ durationMs: v }, `dur-${clip.id}`)}
          />
        </Field>
      )}
      <Section label="Playback">
        {isVideo && (
          <Field label="Speed">
            {(c) => (
              <Select
                {...c}
                value={String(clip.speed)}
                options={SPEEDS.map((s) => ({ value: String(s), label: `${s}×` }))}
                onChange={(v) => patch({ speed: Number(v) })}
              />
            )}
          </Field>
        )}
        {isVideo && (
          <Field label="Volume">
            <Slider aria-label="Volume" min={0} max={2} step={0.05} value={clip.volume} format={pct} onChange={(v) => patch({ volume: v }, `vol-${clip.id}`)} />
            <Switch label="Mute" checked={clip.volume === 0} onChange={(m) => patch({ volume: m ? 0 : 1 })} />
          </Field>
        )}
        {!isVideo && (
          <Field label="Motion">
            {(c) => <Select {...c} value={clip.motion || "none"} options={MOTION_OPTIONS} onChange={(motion) => patch({ motion })} />}
          </Field>
        )}
      </Section>
      <Section label="Picture">
        <Field label="Framing">
          {(c) => <Select {...c} value={clip.fit as "fill"} options={FIT_OPTIONS} onChange={(fit) => patch({ fit })} />}
        </Field>
        {clip.fit === "fit-color" && (
          <Field label="Bar colour">
            <ColorSwatchPicker aria-label="Bar colour" value={clip.fitColor} onChange={(fitColor) => patch({ fitColor }, `col-${clip.id}`)} />
          </Field>
        )}
        {clip.fit === "fill" && (
          <>
            <Field label="Zoom">
              <Slider aria-label="Zoom" min={1} max={3} step={0.05} value={clip.zoom || 1} format={(v) => `${v.toFixed(2)}×`} onChange={(zoom) => patch({ zoom }, `zoom-${clip.id}`)} />
            </Field>
            <Field label="Position across">
              <Slider aria-label="Pan across" min={-1} max={1} step={0.05} value={clip.panX} format={(v) => v.toFixed(2)} onChange={(panX) => patch({ panX }, `pan-${clip.id}`)} />
            </Field>
            <Field label="Position up and down">
              <Slider aria-label="Pan up and down" min={-1} max={1} step={0.05} value={clip.panY} format={(v) => v.toFixed(2)} onChange={(panY) => patch({ panY }, `pan-${clip.id}`)} />
            </Field>
          </>
        )}
        <Field label="Look">
          {(c) => <Select {...c} value={clip.look || "none"} options={LOOK_OPTIONS} onChange={(look) => patch({ look })} />}
        </Field>
      </Section>
      {!isLast && (
        <Section label="Into the next clip">
          <SegmentedControl
            aria-label="Transition"
            size="sm"
            value={(clip.transition.kind || "cut") as "cut"}
            options={TRANSITION_OPTIONS}
            onChange={(kind) => {
              if (kind !== "cut" && limit < MIN_TRANSITION_MS) return;
              const cur = clip.transition.durationMs;
              onChange(setTransition(doc, index, kind, cur >= MIN_TRANSITION_MS ? cur : Math.min(500, limit)));
            }}
          />
          {limit < MIN_TRANSITION_MS && <div className={styles.note}>These clips are too short for a transition.</div>}
          {clip.transition.kind !== "cut" && limit >= MIN_TRANSITION_MS && (
            <Slider
              aria-label="Transition length"
              min={MIN_TRANSITION_MS}
              max={limit}
              step={50}
              value={Math.min(Math.max(clip.transition.durationMs, MIN_TRANSITION_MS), limit)}
              format={(v) => `${(v / 1000).toFixed(2)} s`}
              onChange={(v) => onChange(setTransition(doc, index, clip.transition.kind, v), `tr-${index}`)}
            />
          )}
        </Section>
      )}
      <Button variant="danger" size="sm" icon="trash-2" onClick={() => onChange(deleteClip(doc, index))}>
        Remove clip
      </Button>
    </div>
  );
}

function TitleInspector({ title, p }: { title: VideoTitle; p: InspectorProps }) {
  const { doc, onChange } = p;
  const patch = (u: Partial<VideoTitle>, key?: string) => onChange(updateTitle(doc, title.id, u), key);
  const fontOptions = [{ value: "", label: "Default" }, ...(title.font && !p.fonts.includes(title.font) ? [{ value: title.font, label: title.font }] : []), ...p.fonts.map((f) => ({ value: f, label: f }))];
  return (
    <div className={styles.body} data-testid="title-inspector">
      <Field label="Text">
        {(c) => (
          <TextArea {...c} ref={p.titleTextRef} maxLength={200} value={title.text} onChange={(e) => patch({ text: e.target.value }, `text-${title.id}`)} />
        )}
      </Field>
      <Field label="Style">
        {(c) => <Select {...c} value={title.style as "title"} options={STYLE_OPTIONS} onChange={(style) => patch({ style })} />}
      </Field>
      <Field label="Position">
        <SegmentedControl aria-label="Position" size="sm" value={title.position as "center"} options={POSITION_OPTIONS} onChange={(position) => patch({ position })} />
      </Field>
      <Field label="Font">{(c) => <Select {...c} value={title.font} options={fontOptions} onChange={(font) => patch({ font })} />}</Field>
      <Field label="Colour">
        <ColorSwatchPicker aria-label="Title colour" value={title.color} onChange={(color) => patch({ color }, `col-${title.id}`)} />
      </Field>
      <div className={styles.row}>
        <Field label="Starts at">
          <TimeField label="Starts at" valueMs={title.startMs} onCommit={(startMs) => patch({ startMs })} />
        </Field>
        <Field label="Lasts">
          <TimeField label="Lasts" valueMs={title.durationMs} onCommit={(durationMs) => patch({ durationMs })} />
        </Field>
      </div>
      <Button variant="danger" size="sm" icon="trash-2" onClick={() => { onChange(deleteTitle(doc, title.id)); p.onSelect(null); }}>
        Remove title
      </Button>
    </div>
  );
}

function MusicInspector({ p }: { p: InspectorProps }) {
  const { doc, onChange } = p;
  const m = doc.music;
  if (!m) return null;
  const patch = (u: Partial<NonNullable<typeof m>>, key?: string) => onChange({ ...doc, music: { ...m, ...u } }, key);
  return (
    <div className={styles.body} data-testid="music-inspector">
      <div className={styles.fileName} title={m.path}>
        {m.path.split(/[\\/]/).pop()}
      </div>
      <div className={styles.row}>
        <Button size="sm" icon="music" onClick={p.onPickMusic}>
          Change song
        </Button>
        <Button size="sm" variant="danger" icon="trash-2" onClick={() => { onChange({ ...doc, music: null }); p.onSelect(null); }}>
          Remove
        </Button>
      </div>
      <Field label="Volume">
        <Slider aria-label="Music volume" min={0} max={1.5} step={0.05} value={m.volume} format={pct} onChange={(volume) => patch({ volume }, "music-volume")} />
      </Field>
      <Field label="Starts at (in the song)">
        <TimeField label="Song offset" valueMs={m.offsetMs} onCommit={(offsetMs) => patch({ offsetMs })} />
      </Field>
      <Field label="Fade in">
        <Slider aria-label="Fade in" min={0} max={5000} step={100} value={m.fadeInMs} format={(v) => `${(v / 1000).toFixed(1)} s`} onChange={(fadeInMs) => patch({ fadeInMs }, "music-fadein")} />
      </Field>
      <Field label="Fade out">
        <Slider aria-label="Fade out" min={0} max={8000} step={100} value={m.fadeOutMs} format={(v) => `${(v / 1000).toFixed(1)} s`} onChange={(fadeOutMs) => patch({ fadeOutMs }, "music-fadeout")} />
      </Field>
      <Switch label="Lower the music while clips have sound" checked={m.duck} onChange={(duck) => patch({ duck })} />
      <Switch label="End the video when the song ends" checked={m.endWithMusic} onChange={(endWithMusic) => patch({ endWithMusic })} />
    </div>
  );
}

export function Inspector(p: InspectorProps) {
  const { selection, doc } = p;
  if (selection?.kind === "clip") {
    const index = clipsOf(doc).findIndex((c) => c.id === selection.id);
    const clip = clipsOf(doc)[index];
    if (clip) return <ClipInspector key={clip.id} clip={clip} index={index} span={p.spans[index]} p={p} />;
  }
  if (selection?.kind === "title") {
    const t = titlesOf(doc).find((x) => x.id === selection.id);
    if (t) return <TitleInspector key={t.id} title={t} p={p} />;
  }
  if (selection?.kind === "music" && doc.music) return <MusicInspector p={p} />;
  return (
    <div className={styles.empty}>
      <p>Select a clip, title or the song on the timeline to change it.</p>
      <p className={styles.hint}>Space plays, S splits at the playhead, Delete removes, Ctrl+Z undoes.</p>
    </div>
  );
}
