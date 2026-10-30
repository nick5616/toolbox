import { useEffect, useRef, useState, type ReactNode } from "react";
import { Banner, Button, ColorSwatchPicker, PathText, Section, SegmentedControl, Select, cx, toast } from "@/components";
import type { MediaSourceState } from "@/components/media";
import { VisualsCanvas, VisualsPicker } from "@/components/viz";
import { parseShow } from "@/components/viz/pickerModel";
import { FilesService, MediaService, type SubtitleLanguage, type SubtitleStyleInfo, type TimedLine, type VisualsSpec } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import type { Analysis } from "@/viz/analysis";
import type { Show } from "@/viz/types";
import type { EditorTab } from "./editor";
import { TabBar } from "./EditStep";
import { CueOverlay } from "./CueOverlay";
import { BACKGROUND_CHOICES, CANVAS_CHOICES, POSITION_CHOICES, QUALITY_CHOICES, SIZE_CHOICES, canvasAspect, type Prefs } from "./options";
import { RunStatus } from "./RunStatus";
import type { JobRun } from "./useJobRun";
import { useCachedAnalysis, useImageThumb } from "./visuals";
import styles from "./SubtitlesView.module.css";

const SAMPLE = "The quick brown fox\njumps over the lazy dog";
const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".bmp"];

function useStill(path: string | null, ms: number, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path || !enabled) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    MediaService.Frame(path, Math.max(0, Math.round(ms)), 640)
      .then((u) => !cancelled && setUrl(u))
      .catch(() => !cancelled && setUrl(null));
    return () => {
      cancelled = true;
    };
  }, [path, ms, enabled]);
  return url;
}

interface BackdropArgs {
  audio: boolean;
  background: string;
  color: string;
  image: string | null;
  show: Show | null;
  analysis: Analysis | null;
  timeMs: number;
  aspect: number;
}

/** What the style previews draw under the cue: visuals, a colour or an image (SPEC.md 9.3). */
function burnBackdrop(a: BackdropArgs): ReactNode {
  if (a.audio && a.background === "color") return <div className={styles.layer} style={{ background: a.color }} />;
  if (a.audio && a.background === "image") {
    return <div className={styles.layer}>{a.image && <img src={a.image} alt="" className={styles.layerImg} />}</div>;
  }
  if (!a.show) return null;
  return (
    <div className={styles.layer}>
      <VisualsCanvas show={a.show} analysis={a.analysis} timeMs={a.timeMs} aspect={a.aspect} mode={a.audio ? "opaque" : "overlay"} />
    </div>
  );
}

function StyleCard({
  info,
  selected,
  still,
  backdrop,
  aspect,
  text,
  prefs,
  onSelect,
}: {
  info: SubtitleStyleInfo;
  selected: boolean;
  still: string | null;
  /** Drawn between the still and the text. */
  backdrop?: ReactNode;
  aspect: number;
  text: string;
  prefs: Prefs;
  onSelect: () => void;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <button type="button" role="radio" aria-checked={selected} className={cx(styles.styleCard, selected && styles.styleOn)} onClick={onSelect}>
      <span ref={box} className={styles.still} style={{ aspectRatio: String(aspect) }}>
        {still && <img src={still} alt="" className={styles.stillImg} />}
        {backdrop}
        <CueOverlay
          rect={{ left: 0, top: 0, width: size.w, height: size.h }}
          text={text}
          style={info.id}
          size={prefs.size}
          position={prefs.position}
          font={prefs.font}
        />
      </span>
      <span className={styles.styleLabel}>{info.label}</span>
    </button>
  );
}

export interface ExportStepProps {
  tabs: EditorTab[];
  activeId: string;
  onSelectTab: (id: string) => void;
  cueCount: number;
  /** Text to show on the style previews (the cue at the playhead). */
  sampleText: string;
  playheadMs: number;
  blocker: string | null;
  prefs: Prefs;
  setPrefs: (next: Prefs | ((p: Prefs) => Prefs)) => void;
  styleInfos: SubtitleStyleInfo[];
  fonts: string[];
  languages: SubtitleLanguage[];
  mediaPath: string | null;
  media: MediaSourceState;
  save: JobRun;
  burn: JobRun;
  embed: JobRun;
  onSave: () => void;
  onBurn: () => void;
  onEmbed: () => void;
  onPickMedia: () => void;
  /** The burn's visuals (SPEC.md 9.3): the background for audio, an optional overlay for video. */
  visuals: VisualsSpec | null;
  onVisuals: (v: VisualsSpec) => void;
  /** Video only: "Add visuals over the video". */
  addVisuals: boolean;
  onAddVisuals: (on: boolean) => void;
  /** The cues as timed lines (words included). */
  lines: TimedLine[];
  onOpenDesigner: () => void;
  onOpenInVisualizer: () => void;
}

/** Step 4: save files, add a track, or burn into the picture. */
export function ExportStep(p: ExportStepProps) {
  const info = p.media.source?.info;
  const hasVideo = !!info?.video;
  const isAudio = p.media.status === "ready" && !hasVideo;
  const aspect = isAudio
    ? canvasAspect(p.prefs.canvas)
    : info?.video && info.video.height > 0
      ? info.video.width / info.video.height
      : 16 / 9;
  const still = useStill(p.mediaPath, p.playheadMs, hasVideo);
  const formats = p.prefs.formats;
  const toggleFormat = (f: string) =>
    p.setPrefs((o) => {
      const has = o.formats.includes(f);
      const next = has ? o.formats.filter((x) => x !== f) : [...o.formats, f];
      return next.length === 0 ? o : { ...o, formats: next };
    });
  const needVideo = p.mediaPath === null || isAudio; // a track needs a picture to ride with
  const anyBusy = p.save.busy || p.burn.busy || p.embed.busy;
  const fontOptions = Array.from(new Set([p.prefs.font, ...p.fonts])).map((f) => ({ value: f, label: f }));
  const langOptions = [{ value: "", label: "Not set" }, ...p.languages.map((l) => ({ value: l.code, label: l.name }))];
  const text = p.sampleText || SAMPLE;

  const visualized = isAudio ? p.prefs.background === "visualizer" : p.addVisuals;
  const show = visualized ? parseShow(p.visuals?.showJson) : null;
  const analysis = useCachedAnalysis(p.mediaPath, p.visuals?.stems ?? false, show !== null);
  const imageThumb = useImageThumb(p.prefs.backgroundPath, isAudio && p.prefs.background === "image");
  const backdrop = burnBackdrop({ audio: isAudio, background: p.prefs.background, color: p.prefs.backgroundColor, image: imageThumb, show, analysis, timeMs: p.playheadMs, aspect });
  const needsImage = isAudio && p.prefs.background === "image" && !p.prefs.backgroundPath;
  const pickImage = async () => {
    try {
      const paths = (await FilesService.PickWith("Choose a background image", IMAGE_EXTS, false)) ?? [];
      const first = paths[0];
      if (first) p.setPrefs((o) => ({ ...o, backgroundPath: first }));
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };

  const visualsPicker = (mode: "background" | "overlay") =>
    p.mediaPath && p.visuals ? (
      <div className={styles.visualsBox}>
        <VisualsPicker
          inputPath={p.mediaPath}
          lines={p.lines}
          value={p.visuals}
          onChange={p.onVisuals}
          mode={mode}
          aspect={aspect}
          playheadMs={p.playheadMs}
          onOpenDesigner={p.onOpenDesigner}
        />
        <div>
          <Button variant="ghost" icon="sparkles" onClick={p.onOpenInVisualizer}>
            Make it fully reactive in Visualizer
          </Button>
        </div>
      </div>
    ) : null;

  return (
    <div className={styles.sourceBody}>
      <TabBar tabs={p.tabs} activeId={p.activeId} onSelect={p.onSelectTab} />
      {p.blocker && (
        <Banner tone="warn" title="Fix this before exporting">
          {p.blocker}
        </Banner>
      )}

      <Section label="Save as a file">
        <div className={styles.form}>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Formats</span>
            <div className={styles.chips} role="group" aria-label="Formats">
              {["srt", "vtt"].map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={formats.includes(f)}
                  className={cx(styles.chip, formats.includes(f) && styles.chipOn)}
                  onClick={() => toggleFormat(f)}
                >
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div>
            <Button icon="check" loading={p.save.busy} disabled={p.blocker !== null || p.cueCount === 0 || anyBusy} onClick={p.onSave}>
              Save {formats.map((f) => f.toUpperCase()).join(" + ")}
            </Button>
          </div>
          <RunStatus run={p.save} runningLabel="Saving…" doneLabel="Saved" />
        </div>
      </Section>

      <Section label="Add as a track">
        <div className={styles.form}>
          <div className={styles.muted}>
            No quality loss: the video is copied as is, and the player can turn the subtitles on or off.
          </div>
          {needVideo ? (
            <Button variant="secondary" icon="film" onClick={p.onPickMedia}>
              Pick the video
            </Button>
          ) : (
            <>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Track language</span>
                <Select
                  aria-label="Track language"
                  value={p.prefs.trackLanguage}
                  options={langOptions}
                  onChange={(trackLanguage) => p.setPrefs((o) => ({ ...o, trackLanguage }))}
                />
              </label>
              <div>
                <Button icon="captions" loading={p.embed.busy} disabled={p.blocker !== null || p.cueCount === 0 || anyBusy || p.media.status === "error"} onClick={p.onEmbed}>
                  Add subtitle track
                </Button>
              </div>
            </>
          )}
          <RunStatus run={p.embed} runningLabel="Adding the track…" doneLabel="Track added" />
        </div>
      </Section>

      <Section label={isAudio ? "Make a video" : "Burn into the video"}>
        <div className={styles.form}>
          {p.mediaPath === null ? (
            <>
              <div className={styles.muted}>Burning draws the text into the picture. It needs the video, or an audio file to make a video from.</div>
              <div>
                <Button variant="secondary" icon="film" onClick={p.onPickMedia}>
                  Pick the video
                </Button>
              </div>
            </>
          ) : (
            <>
              {isAudio && (
                <>
                  <div className={styles.muted}>Makes a video from the audio, with the subtitles drawn on a background.</div>
                  <div className={styles.inlineFields}>
                    <div className={styles.field}>
                      <span className={styles.fieldLabel}>Canvas</span>
                      <SegmentedControl aria-label="Canvas" value={p.prefs.canvas} options={CANVAS_CHOICES} onChange={(canvas) => p.setPrefs((o) => ({ ...o, canvas }))} />
                    </div>
                    <div className={styles.field}>
                      <span className={styles.fieldLabel}>Quality</span>
                      <SegmentedControl
                        aria-label="Quality"
                        value={String(p.prefs.canvasHeight)}
                        options={QUALITY_CHOICES}
                        onChange={(v) => p.setPrefs((o) => ({ ...o, canvasHeight: Number(v) }))}
                      />
                    </div>
                    <div className={styles.field}>
                      <span className={styles.fieldLabel}>Background</span>
                      <SegmentedControl
                        aria-label="Background"
                        value={p.prefs.background}
                        options={BACKGROUND_CHOICES}
                        onChange={(background) => p.setPrefs((o) => ({ ...o, background }))}
                      />
                    </div>
                  </div>
                  {p.prefs.background === "color" && (
                    <ColorSwatchPicker aria-label="Background colour" value={p.prefs.backgroundColor} onChange={(backgroundColor) => p.setPrefs((o) => ({ ...o, backgroundColor }))} />
                  )}
                  {p.prefs.background === "image" && (
                    <div className={styles.field}>
                      <Button variant="secondary" icon="image" onClick={() => void pickImage()}>
                        {p.prefs.backgroundPath ? "Change the image" : "Choose an image"}
                      </Button>
                      {p.prefs.backgroundPath && <PathText path={p.prefs.backgroundPath} />}
                    </div>
                  )}
                  {p.prefs.background === "visualizer" && visualsPicker("background")}
                </>
              )}
              {!isAudio && (
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Visuals</span>
                  <SegmentedControl
                    aria-label="Visuals"
                    value={p.addVisuals ? "add" : "none"}
                    options={[
                      { value: "none", label: "None" },
                      { value: "add", label: "Add visuals over the video" },
                    ]}
                    onChange={(v) => p.onAddVisuals(v === "add")}
                  />
                </div>
              )}
              {!isAudio && p.addVisuals && visualsPicker("overlay")}
              <div role="radiogroup" aria-label="Style" className={styles.styleCards}>
                {p.styleInfos.map((s) => (
                  <StyleCard
                    key={s.id}
                    info={s}
                    selected={p.prefs.style === s.id}
                    still={still}
                    backdrop={backdrop}
                    aspect={aspect}
                    text={text}
                    prefs={p.prefs}
                    onSelect={() => p.setPrefs((o) => ({ ...o, style: s.id }))}
                  />
                ))}
              </div>
              <div className={styles.inlineFields}>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Size</span>
                  <SegmentedControl
                    aria-label="Size"
                    value={p.prefs.size}
                    options={SIZE_CHOICES}
                    onChange={(size) => p.setPrefs((o) => ({ ...o, size }))}
                  />
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Position</span>
                  <SegmentedControl
                    aria-label="Position"
                    value={p.prefs.position}
                    options={POSITION_CHOICES}
                    onChange={(position) => p.setPrefs((o) => ({ ...o, position }))}
                  />
                </div>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Font</span>
                  <Select aria-label="Font" value={p.prefs.font} options={fontOptions} onChange={(font) => p.setPrefs((o) => ({ ...o, font }))} />
                </label>
              </div>
              <div>
                <Button
                  icon="film"
                  loading={p.burn.busy}
                  disabled={p.blocker !== null || p.cueCount === 0 || anyBusy || p.media.status === "error" || needsImage || (visualized && !p.visuals)}
                  onClick={p.onBurn}
                >
                  {isAudio ? "Make a video" : "Burn into the video"}
                </Button>
              </div>
            </>
          )}
          <RunStatus run={p.burn} runningLabel={isAudio ? "Making the video…" : "Burning subtitles…"} doneLabel="Video ready" />
        </div>
      </Section>
    </div>
  );
}
