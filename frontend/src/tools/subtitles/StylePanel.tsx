import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, ColorSwatchPicker, IconButton, Section, SegmentedControl, Select, cx, toast, useClickIn } from "@/components";
import { VisualsCanvas, VisualsPicker } from "@/components/viz";
import { parseShow } from "@/components/viz/pickerModel";
import { FilesService, MediaService, type SubtitleStyleInfo } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import type { Analysis } from "@/viz/analysis";
import type { Show } from "@/viz/types";
import { CueOverlay } from "./CueOverlay";
import { activeCueIndex, basename } from "./logic";
import { BACKGROUND_CHOICES, CANVAS_CHOICES, POSITION_CHOICES, QUALITY_CHOICES, SIZE_CHOICES, canvasAspect, type Prefs } from "./options";
import { useRows } from "./hooks";
import { useSubtitles } from "./store";
import { cuesToLines, defaultVisuals, useCachedAnalysis, useImageThumb } from "./visuals";
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
    <button type="button" role="radio" aria-checked={selected} data-tip={`${info.label}: a look for the burned-in text; click to use it`} className={cx(styles.styleCard, selected && styles.styleOn)} onClick={onSelect}>
      <span ref={box} className={styles.still} style={{ aspectRatio: String(aspect) }}>
        {still && <img src={still} alt="" className={styles.stillImg} />}
        {backdrop}
        <CueOverlay rect={{ left: 0, top: 0, width: size.w, height: size.h }} text={text} style={info.id} size={prefs.size} position={prefs.position} font={prefs.font} />
      </span>
      <span className={styles.styleLabel}>{info.label}</span>
    </button>
  );
}

/** Style panel: how burned-in text looks, the video made from audio, and the visuals behind or over the picture. */
export function StylePanel() {
  const prefs = useSubtitles((s) => s.prefs);
  const patchPrefs = useSubtitles((s) => s.patchPrefs);
  const styleInfos = useSubtitles((s) => s.styleInfos);
  const fonts = useSubtitles((s) => s.fonts);
  const media = useSubtitles((s) => s.media);
  const mediaPath = useSubtitles((s) => s.mediaPath);
  const playheadMs = useSubtitles((s) => s.playheadMs);
  const chosen = useSubtitles((s) => s.chosen);
  const addVisuals = useSubtitles((s) => s.addVisuals);
  const setVisuals = useSubtitles((s) => s.setVisuals);
  const setAddVisuals = useSubtitles((s) => s.setAddVisuals);
  const openDesigner = useSubtitles((s) => s.openDesigner);
  const openInVisualizer = useSubtitles((s) => s.openInVisualizer);
  const rows = useRows();
  const lines = useMemo(() => cuesToLines(rows), [rows]);
  const { close } = useClickIn();

  const hasVideo = media.isVideo;
  const isAudio = media.status === "ready" && !hasVideo;
  const aspect = isAudio ? canvasAspect(prefs.canvas) : media.height > 0 ? media.width / media.height : 16 / 9;
  const mode = hasVideo ? "overlay" : "background";
  const visuals = useMemo(() => chosen ?? defaultVisuals(mode), [chosen, mode]);
  const visualized = isAudio ? prefs.background === "visualizer" : addVisuals;
  const show = visualized ? parseShow(visuals?.showJson) : null;
  const still = useStill(mediaPath, playheadMs, hasVideo);
  const analysis = useCachedAnalysis(mediaPath, visuals?.stems ?? false, show !== null);
  const imageThumb = useImageThumb(prefs.backgroundPath, isAudio && prefs.background === "image");
  const backdrop = burnBackdrop({ audio: isAudio, background: prefs.background, color: prefs.backgroundColor, image: imageThumb, show, analysis, timeMs: playheadMs, aspect });
  const sampleText = rows[activeCueIndex(rows, playheadMs)]?.text || SAMPLE;
  const fontOptions = Array.from(new Set([prefs.font, ...fonts])).map((f) => ({ value: f, label: f }));

  const pickImage = async () => {
    try {
      const paths = (await FilesService.PickWith("Choose a background image", IMAGE_EXTS, false)) ?? [];
      const first = paths[0];
      if (first) patchPrefs({ backgroundPath: first });
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };

  const picker = (m: "background" | "overlay") =>
    mediaPath && visuals ? (
      <div className={styles.visualsBox}>
        <VisualsPicker
          inputPath={mediaPath}
          lines={lines}
          value={visuals}
          onChange={setVisuals}
          mode={m}
          aspect={aspect}
          playheadMs={playheadMs}
          onOpenDesigner={() => {
            close();
            openDesigner();
          }}
        />
        <div className={styles.buttonRow}>
          <Button variant="ghost" icon="sparkles" onClick={() => openInVisualizer()} data-tip="Open Visualizer with this audio and these words for the full set of reactions">
            Make it fully reactive in Visualizer
          </Button>
          <IconButton size="sm" icon="app-window" label="Open Visualizer in its own window" data-tip="Open Visualizer with this in its own window" onClick={() => openInVisualizer(true)} />
        </div>
      </div>
    ) : null;

  if (!mediaPath) {
    return (
      <div className={styles.panel}>
        <p className={styles.muted}>Styling draws the text into the picture. It needs the video, or an audio file to make a video from.</p>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <Section label="Look" tip="Choose how the burned-in text looks">
        <div role="radiogroup" aria-label="Style" className={styles.styleCards}>
          {styleInfos.map((s) => (
            <StyleCard key={s.id} info={s} selected={prefs.style === s.id} still={still} backdrop={backdrop} aspect={aspect} text={sampleText} prefs={prefs} onSelect={() => patchPrefs({ style: s.id as Prefs["style"] })} />
          ))}
        </div>
      </Section>

      <Section label="Text" tip="Size, position and typeface of the burned-in text">
        <div className={styles.drawerForm}>
          <div className={styles.field}>
            <span className={styles.fieldLabel} data-tip="How big the text is relative to the picture">Size</span>
            <SegmentedControl aria-label="Size" value={prefs.size} options={SIZE_CHOICES} onChange={(size) => patchPrefs({ size })} />
          </div>
          <div className={styles.field}>
            <span className={styles.fieldLabel} data-tip="Where on the picture the text sits">Position</span>
            <SegmentedControl aria-label="Position" value={prefs.position} options={POSITION_CHOICES} onChange={(position) => patchPrefs({ position })} />
          </div>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Font</span>
            <Select aria-label="Font" data-tip="The typeface for the burned-in text" value={prefs.font} options={fontOptions} onChange={(font) => patchPrefs({ font })} />
          </label>
        </div>
      </Section>

      {isAudio && (
        <Section label="Video" tip="The shape, size and background of the video that will be made">
          <div className={styles.drawerForm}>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Canvas</span>
              <SegmentedControl aria-label="Canvas" data-tip="The shape of the video that will be made" value={prefs.canvas} options={CANVAS_CHOICES} onChange={(canvas) => patchPrefs({ canvas })} />
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Quality</span>
              <SegmentedControl aria-label="Quality" value={String(prefs.canvasHeight)} options={QUALITY_CHOICES} onChange={(v) => patchPrefs({ canvasHeight: Number(v) })} />
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Background</span>
              <SegmentedControl aria-label="Background" value={prefs.background} options={BACKGROUND_CHOICES} onChange={(background) => patchPrefs({ background })} />
            </div>
            {prefs.background === "color" && <ColorSwatchPicker aria-label="Background colour" value={prefs.backgroundColor} onChange={(backgroundColor) => patchPrefs({ backgroundColor })} />}
            {prefs.background === "image" && (
              <div className={styles.field}>
                <Button variant="secondary" icon="image" data-tip="Pick a picture to use as the background" onClick={() => void pickImage()}>
                  {prefs.backgroundPath ? "Change the image" : "Choose an image"}
                </Button>
                {prefs.backgroundPath && (
                  <span className={styles.muted} data-tip={prefs.backgroundPath}>
                    {basename(prefs.backgroundPath)}
                  </span>
                )}
              </div>
            )}
          </div>
        </Section>
      )}

      {isAudio && prefs.background === "visualizer" && (
        <Section label="Visuals" tip="The animated visuals behind the subtitles">
          {picker("background")}
        </Section>
      )}
      {!isAudio && (
        <Section label="Visuals" tip="Optional animated graphics drawn over the video">
          <div className={styles.drawerForm}>
            <SegmentedControl
              aria-label="Visuals"
              value={addVisuals ? "add" : "none"}
              options={[
                { value: "none", label: "None", tip: "Only the subtitles are added to the picture" },
                { value: "add", label: "Add visuals over the video", tip: "Draw animated visuals that react to the sound over your video" },
              ]}
              onChange={(v) => setAddVisuals(v === "add")}
            />
            {addVisuals && picker("overlay")}
          </div>
        </Section>
      )}
    </div>
  );
}
