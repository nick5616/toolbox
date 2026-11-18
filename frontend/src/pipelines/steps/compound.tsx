import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Button,
  ColorSwatchPicker,
  Section,
  SegmentedControl,
  Select,
  Stepper,
  Switch,
  TemplateField,
  cx,
  normalizeHex,
  toast,
} from "@/components";
import {
  FilesService,
  LyricVideoService,
  SubtitleStyle,
  SubtitlesService,
  TranscribeService,
  VisualizerMode,
  VisualizerService,
  type LyricVideoStepOptions,
  type SubtitlesStepOptions,
  type VisualizerDesign,
  type VisualizerStepOptions,
  type VisualsSpec,
} from "@/lib/api";
import { FromLibraryButton } from "@/blocks/library-picker";
import { toAppError } from "@/lib/errors";
import { PRESETS } from "@/viz/presets";
import { presetShowJson } from "../visualizerDesigns";
import { parseObject, registerSteps, type StepEditorProps, type StepUI } from "./registry";
import { PARAMS } from "./paramDefs";
import styles from "./compound.module.css";

// Step editors owned by WP-AD2: Subtitles, Lyric Video and Visualizer (SPEC.md §11.4).

// ---- parsing helpers ----------------------------------------------------------

function str(v: unknown, d: string): string {
  return typeof v === "string" ? v : d;
}
function bool(v: unknown, d: boolean): boolean {
  return typeof v === "boolean" ? v : d;
}
function oneOf(v: unknown, allowed: readonly string[], d: string): string {
  return typeof v === "string" && allowed.includes(v) ? v : d;
}
function oneOfNum(v: unknown, allowed: readonly number[], d: number): number {
  return typeof v === "number" && allowed.includes(v) ? v : d;
}
function intIn(v: unknown, min: number, max: number, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d;
}
function hex(v: unknown, d: string): string {
  return typeof v === "string" ? (normalizeHex(v) ?? d) : d;
}
function visuals(v: unknown): VisualsSpec | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  return { showJson: str(o.showJson, ""), stems: bool(o.stems, false), useWords: bool(o.useWords, false) } as VisualsSpec;
}

// ---- lists from the services (cached; failures leave the list empty) ----------

const listCache = new Map<string, unknown[]>();

function useList<T>(key: string, load: () => Promise<T[] | null>): T[] {
  const [items, setItems] = useState<T[]>(() => (listCache.get(key) as T[] | undefined) ?? []);
  useEffect(() => {
    if (listCache.has(key)) return;
    let alive = true;
    load()
      .then((r) => {
        const list = r ?? [];
        if (list.length > 0) listCache.set(key, list);
        if (alive) setItems(list);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // load is a stable service call per key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return items;
}

const useFonts = (current: string): Array<{ value: string; label: string }> => {
  const fonts = useList("fonts", () => LyricVideoService.Fonts());
  return useMemo(() => (fonts.includes(current) || !current ? fonts : [current, ...fonts]).map((f) => ({ value: f, label: f })), [fonts, current]);
};

function useSpokenLanguages(): Array<{ value: string; label: string }> {
  const langs = useList("spoken", () => TranscribeService.Languages());
  return useMemo(() => [{ value: "", label: "Detect automatically" }, ...langs.map((l) => ({ value: l.code, label: l.name }))], [langs]);
}

// ---- layout bits -----------------------------------------------------------------

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      {children}
    </div>
  );
}

function withValue(options: Array<{ value: string; label: string }>, value: string): Array<{ value: string; label: string }> {
  return options.some((o) => o.value === value) ? options : [{ value, label: value || "None" }, ...options];
}

async function pickFile(title: string, exts: string[]): Promise<string | null> {
  try {
    const paths = (await FilesService.PickWith(title, exts, false)) ?? [];
    return paths[0] ?? null;
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
    return null;
  }
}

const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".bmp"];
const VIDEO_EXTS = [".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"];

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

const ASPECT_OPTIONS = [
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
  { value: "1:1", label: "1:1" },
];

// ---- Subtitles ------------------------------------------------------------------

export const DEFAULT_SUBTITLES: SubtitlesStepOptions = {
  model: "small",
  language: "",
  translateToEnglish: false,
  targetLanguage: "",
  maxLineChars: 42,
  maxLines: 2,
  save: ["srt"],
  video: "burn",
  style: SubtitleStyle.StyleClassic,
  size: "m",
  position: "bottom",
  font: "Arial",
  trackLanguage: "",
  maxSizeMB: 0,
  canvas: "16:9",
  canvasHeight: 1080,
  background: "color",
  backgroundColor: "#11131a",
  backgroundPath: "",
  visuals: null,
};

const STYLE_OPTIONS = [
  { value: SubtitleStyle.StyleClassic, label: "Classic" },
  { value: SubtitleStyle.StyleBoxed, label: "Boxed" },
  { value: SubtitleStyle.StyleYellow, label: "Yellow" },
  { value: SubtitleStyle.StyleMinimal, label: "Minimal" },
];

export function parseSubtitles(json: string): SubtitlesStepOptions {
  const o = parseObject(json);
  const d = DEFAULT_SUBTITLES;
  const save = Array.isArray(o.save) ? o.save.filter((f): f is string => f === "srt" || f === "vtt") : null;
  const background = oneOf(o.background, ["color", "image", "visualizer"], d.background);
  const vis = visuals(o.visuals);
  return {
    model: oneOf(o.model, ["base", "small", "turbo"], d.model),
    language: str(o.language, d.language),
    translateToEnglish: bool(o.translateToEnglish, d.translateToEnglish),
    targetLanguage: str(o.targetLanguage, d.targetLanguage),
    maxLineChars: intIn(o.maxLineChars, 32, 60, d.maxLineChars),
    maxLines: oneOfNum(o.maxLines, [1, 2], d.maxLines),
    save: save === null ? [...(d.save ?? [])] : Array.from(new Set(save)).sort(),
    video: oneOf(o.video, ["none", "burn", "embed"], d.video),
    style: oneOf(o.style, STYLE_OPTIONS.map((s) => s.value), d.style) as SubtitleStyle,
    size: oneOf(o.size, ["s", "m", "l"], d.size),
    position: oneOf(o.position, ["bottom", "top"], d.position),
    font: str(o.font, d.font) || d.font,
    trackLanguage: str(o.trackLanguage, d.trackLanguage),
    maxSizeMB: intIn(o.maxSizeMB, 0, 4000, d.maxSizeMB),
    canvas: oneOf(o.canvas, ["16:9", "9:16", "1:1"], d.canvas),
    canvasHeight: oneOfNum(o.canvasHeight, [720, 1080], d.canvasHeight),
    // A visuals background needs a design chosen in the tool; without one it is a colour.
    background: background === "visualizer" && !vis ? "color" : background,
    backgroundColor: hex(o.backgroundColor, d.backgroundColor),
    backgroundPath: str(o.backgroundPath, d.backgroundPath),
    visuals: vis,
  };
}

function SubtitlesEditor({ value, onChange }: StepEditorProps<SubtitlesStepOptions>) {
  const set = (patch: Partial<SubtitlesStepOptions>) => onChange({ ...value, ...patch });
  const spoken = useSpokenLanguages();
  const targets = useList("translate", () => SubtitlesService.TranslationLanguages());
  const fonts = useFonts(value.font);
  const save = value.save ?? [];
  const toggleSave = (f: string, on: boolean) => set({ save: (on ? [...save.filter((x) => x !== f), f] : save.filter((x) => x !== f)).sort() });
  const targetOptions = useMemo(
    () => withValue([{ value: "", label: "Keep the spoken language" }, ...targets.map((l) => ({ value: l.code, label: l.name }))], value.targetLanguage),
    [targets, value.targetLanguage],
  );
  const trackOptions = useMemo(
    () => withValue([{ value: "", label: "Not set" }, ...targets.map((l) => ({ value: l.code, label: l.name }))], value.trackLanguage),
    [targets, value.trackLanguage],
  );
  const burn = value.video === "burn";

  return (
    <div className={styles.stack}>
      <Section label="Speech">
        <div className={styles.group}>
          <Row label="Model">
            <SegmentedControl
              aria-label="Model"
              value={value.model}
              options={[
                { value: "base", label: "Base" },
                { value: "small", label: "Small" },
                { value: "turbo", label: "Turbo" },
              ]}
              onChange={(model) => set({ model })}
            />
          </Row>
          <Row label="Spoken language">
            <Select aria-label="Spoken language" value={value.language} options={withValue(spoken, value.language)} onChange={(language) => set({ language })} />
          </Row>
          <Row label="Translate to English">
            <Switch checked={value.translateToEnglish} onChange={(translateToEnglish) => set({ translateToEnglish })} label="With the speech model" />
          </Row>
          <Row label="Translate to">
            <Select aria-label="Translate to" value={value.targetLanguage} options={targetOptions} onChange={(targetLanguage) => set({ targetLanguage })} />
          </Row>
          {value.targetLanguage !== "" && <div className={styles.muted}>Translating uses a Local Chat model, so it needs one downloaded.</div>}
          <Row label="Characters per line">
            <Stepper aria-label="Characters per line" value={value.maxLineChars} min={32} max={60} onChange={(maxLineChars) => set({ maxLineChars })} />
          </Row>
          <Row label="Lines">
            <SegmentedControl
              aria-label="Lines"
              value={String(value.maxLines)}
              options={[
                { value: "1", label: "1" },
                { value: "2", label: "2" },
              ]}
              onChange={(v) => set({ maxLines: Number(v) })}
            />
          </Row>
        </div>
      </Section>

      <Section label="Make">
        <div className={styles.group}>
          <Row label="Save files">
            <Switch checked={save.includes("srt")} onChange={(on) => toggleSave("srt", on)} label="SRT" />
            <Switch checked={save.includes("vtt")} onChange={(on) => toggleSave("vtt", on)} label="VTT" />
          </Row>
          <Row label="Video">
            <SegmentedControl
              aria-label="Video"
              value={value.video}
              options={[
                { value: "none", label: "No video" },
                { value: "burn", label: "Burn in" },
                { value: "embed", label: "Add as a track" },
              ]}
              onChange={(video) => set({ video })}
            />
          </Row>
          {value.video === "none" && save.length === 0 && <div className={styles.muted}>Pick a file to save or a video to make.</div>}
        </div>
      </Section>

      {burn && (
        <Section label="Burned-in look">
          <div className={styles.group}>
            <Row label="Style">
              <SegmentedControl aria-label="Style" value={value.style} options={STYLE_OPTIONS} onChange={(style) => set({ style })} />
            </Row>
            <Row label="Size">
              <SegmentedControl
                aria-label="Size"
                value={value.size}
                options={[
                  { value: "s", label: "Small" },
                  { value: "m", label: "Medium" },
                  { value: "l", label: "Large" },
                ]}
                onChange={(size) => set({ size })}
              />
            </Row>
            <Row label="Position">
              <SegmentedControl
                aria-label="Position"
                value={value.position}
                options={[
                  { value: "bottom", label: "Bottom" },
                  { value: "top", label: "Top" },
                ]}
                onChange={(position) => set({ position })}
              />
            </Row>
            <Row label="Font">
              <Select aria-label="Font" value={value.font} options={fonts.length > 0 ? fonts : [{ value: value.font, label: value.font }]} onChange={(font) => set({ font })} />
            </Row>
            <Row label="Largest file (MB)">
              <Stepper aria-label="Largest file in MB" value={value.maxSizeMB} min={0} max={4000} step={5} unit="MB" onChange={(maxSizeMB) => set({ maxSizeMB })} />
              <span className={styles.muted}>{value.maxSizeMB === 0 ? "No limit" : "The video bitrate follows its length"}</span>
            </Row>
          </div>
        </Section>
      )}

      {burn && (
        <Section label="For audio files">
          <div className={styles.group}>
            <div className={styles.muted}>Audio has no picture, so the subtitles are burned onto this.</div>
            <Row label="Shape">
              <SegmentedControl aria-label="Canvas" value={value.canvas} options={ASPECT_OPTIONS} onChange={(canvas) => set({ canvas })} />
              <SegmentedControl
                aria-label="Canvas height"
                value={String(value.canvasHeight)}
                options={[
                  { value: "720", label: "720p" },
                  { value: "1080", label: "1080p" },
                ]}
                onChange={(v) => set({ canvasHeight: Number(v) })}
              />
            </Row>
            <Row label="Background">
              <SegmentedControl
                aria-label="Background"
                value={value.background === "image" ? "image" : "color"}
                options={[
                  { value: "color", label: "Colour" },
                  { value: "image", label: "Image" },
                ]}
                onChange={(background) => set({ background })}
              />
            </Row>
            {value.background === "image" ? (
              <Row label="Image">
                <Button
                  size="sm"
                  variant="secondary"
                  icon="folder-open"
                  onClick={async () => {
                    const p = await pickFile("Choose a background image", IMAGE_EXTS);
                    if (p) set({ backgroundPath: p });
                  }}
                >
                  {value.backgroundPath ? "Change…" : "Choose an image…"}
                </Button>
                <FromLibraryButton iconOnly size="sm" title="Choose a background image from Library" label="Image from Library…" exts={IMAGE_EXTS} multiple={false} have={value.backgroundPath ? [value.backgroundPath] : undefined} onPick={(p) => p[0] && set({ backgroundPath: p[0] })} />
                <span className={styles.muted}>{value.backgroundPath ? baseName(value.backgroundPath) : "Nothing chosen yet"}</span>
              </Row>
            ) : (
              <Row label="Colour">
                <ColorSwatchPicker aria-label="Background colour" value={value.backgroundColor} onChange={(backgroundColor) => set({ backgroundColor })} />
              </Row>
            )}
          </div>
        </Section>
      )}

      {value.video === "embed" && (
        <Section label="Track">
          <Row label="Track language">
            <Select aria-label="Track language" value={value.trackLanguage} options={trackOptions} onChange={(trackLanguage) => set({ trackLanguage })} />
          </Row>
        </Section>
      )}
    </div>
  );
}

// ---- Lyric Video ----------------------------------------------------------------

export const DEFAULT_LYRIC_VIDEO: LyricVideoStepOptions = {
  language: "",
  look: {
    background: "blur-cover",
    backgroundPath: "",
    color1: "#1b1f2a",
    color2: "#3a2f5b",
    font: "Arial",
    textColor: "#ffffff",
    highlightColor: "#ffd166",
    karaoke: true,
    position: "center",
    showNext: true,
    visualizer: "none",
    titleCard: true,
    title: "{item}",
    artist: "",
    visuals: { showJson: "", stems: false, useWords: false },
  },
  audio: "original",
  aspect: "16:9",
  height: 1080,
};

const LV_BACKGROUNDS = ["blur-cover", "cover", "color", "gradient", "image", "video", "visualizer"] as const;

export function parseLyricVideo(json: string): LyricVideoStepOptions {
  const o = parseObject(json);
  const d = DEFAULT_LYRIC_VIDEO;
  const l = typeof o.look === "object" && o.look !== null ? (o.look as Record<string, unknown>) : {};
  const vis = visuals(l.visuals);
  return {
    language: str(o.language, d.language),
    look: {
      background: oneOf(l.background, LV_BACKGROUNDS, d.look.background),
      backgroundPath: str(l.backgroundPath, d.look.backgroundPath),
      color1: hex(l.color1, d.look.color1),
      color2: hex(l.color2, d.look.color2),
      font: str(l.font, d.look.font) || d.look.font,
      textColor: hex(l.textColor, d.look.textColor),
      highlightColor: hex(l.highlightColor, d.look.highlightColor),
      karaoke: bool(l.karaoke, d.look.karaoke),
      position: oneOf(l.position, ["center", "lower"], d.look.position),
      showNext: bool(l.showNext, d.look.showNext),
      visualizer: oneOf(l.visualizer, ["none", "wave", "bars"], d.look.visualizer),
      titleCard: bool(l.titleCard, d.look.titleCard),
      title: str(l.title, d.look.title),
      artist: str(l.artist, d.look.artist),
      visuals: vis ?? d.look.visuals,
    },
    audio: oneOf(o.audio, ["original", "instrumental"], d.audio),
    aspect: oneOf(o.aspect, ["16:9", "9:16", "1:1"], d.aspect),
    height: oneOfNum(o.height, [720, 1080], d.height),
  };
}

const LV_BACKGROUND_OPTIONS = [
  { value: "blur-cover", label: "Blurred cover" },
  { value: "cover", label: "Cover and blur" },
  { value: "color", label: "Colour" },
  { value: "gradient", label: "Gradient" },
  { value: "image", label: "Image" },
  { value: "video", label: "Video" },
];

function LyricVideoEditor({ value, onChange, vars }: StepEditorProps<LyricVideoStepOptions>) {
  const look = value.look;
  const setLook = (patch: Partial<LyricVideoStepOptions["look"]>) => onChange({ ...value, look: { ...look, ...patch } });
  const set = (patch: Partial<LyricVideoStepOptions>) => onChange({ ...value, ...patch });
  const spoken = useSpokenLanguages();
  const fonts = useFonts(look.font);
  const bgOptions = look.background === "visualizer" ? [...LV_BACKGROUND_OPTIONS, { value: "visualizer", label: "Visuals (from the tool)" }] : LV_BACKGROUND_OPTIONS;
  const fileBackground = look.background === "image" || look.background === "video";

  return (
    <div className={styles.stack}>
      <Section label="Song">
        <div className={styles.group}>
          <Row label="Language">
            <Select aria-label="Language" value={value.language} options={withValue(spoken, value.language)} onChange={(language) => set({ language })} />
          </Row>
          <Row label="Audio">
            <SegmentedControl
              aria-label="Audio"
              value={value.audio}
              options={[
                { value: "original", label: "Original" },
                { value: "instrumental", label: "Instrumental" },
              ]}
              onChange={(audio) => set({ audio })}
            />
          </Row>
          <Row label="Shape">
            <SegmentedControl aria-label="Aspect" value={value.aspect} options={ASPECT_OPTIONS} onChange={(aspect) => set({ aspect })} />
            <SegmentedControl
              aria-label="Height"
              value={String(value.height)}
              options={[
                { value: "720", label: "720p" },
                { value: "1080", label: "1080p" },
              ]}
              onChange={(v) => set({ height: Number(v) })}
            />
          </Row>
        </div>
      </Section>

      <Section label="Look">
        <div className={styles.group}>
          <Row label="Background">
            <Select aria-label="Background" value={look.background} options={bgOptions} onChange={(background) => setLook({ background })} />
          </Row>
          {fileBackground && (
            <Row label={look.background === "image" ? "Image" : "Video"}>
              <Button
                size="sm"
                variant="secondary"
                icon="folder-open"
                onClick={async () => {
                  const p = await pickFile(look.background === "image" ? "Choose a background image" : "Choose a background video", look.background === "image" ? IMAGE_EXTS : VIDEO_EXTS);
                  if (p) setLook({ backgroundPath: p });
                }}
              >
                {look.backgroundPath ? "Change…" : "Choose a file…"}
              </Button>
              <FromLibraryButton
                iconOnly
                size="sm"
                title={look.background === "image" ? "Choose a background image from Library" : "Choose a background video from Library"}
                label={look.background === "image" ? "Image from Library…" : "Video from Library…"}
                exts={look.background === "image" ? IMAGE_EXTS : VIDEO_EXTS}
                multiple={false}
                have={look.backgroundPath ? [look.backgroundPath] : undefined}
                onPick={(p) => p[0] && setLook({ backgroundPath: p[0] })}
              />
              <span className={styles.muted}>{look.backgroundPath ? baseName(look.backgroundPath) : "Nothing chosen yet"}</span>
            </Row>
          )}
          {(look.background === "color" || look.background === "gradient") && (
            <Row label={look.background === "gradient" ? "Top colour" : "Colour"}>
              <ColorSwatchPicker aria-label="Background colour" value={look.color1} onChange={(color1) => setLook({ color1 })} />
            </Row>
          )}
          {look.background === "gradient" && (
            <Row label="Bottom colour">
              <ColorSwatchPicker aria-label="Bottom colour" value={look.color2} onChange={(color2) => setLook({ color2 })} />
            </Row>
          )}
          <Row label="Font">
            <Select aria-label="Font" value={look.font} options={fonts.length > 0 ? fonts : [{ value: look.font, label: look.font }]} onChange={(font) => setLook({ font })} />
          </Row>
          <Row label="Text colour">
            <ColorSwatchPicker aria-label="Text colour" value={look.textColor} onChange={(textColor) => setLook({ textColor })} />
          </Row>
          <Row label="Highlight colour">
            <ColorSwatchPicker aria-label="Highlight colour" value={look.highlightColor} onChange={(highlightColor) => setLook({ highlightColor })} />
          </Row>
          <Row label="Karaoke">
            <Switch checked={look.karaoke} onChange={(karaoke) => setLook({ karaoke })} label="Fill word by word" />
          </Row>
          <Row label="Position">
            <SegmentedControl
              aria-label="Position"
              value={look.position}
              options={[
                { value: "center", label: "Centre" },
                { value: "lower", label: "Lower" },
              ]}
              onChange={(position) => setLook({ position })}
            />
          </Row>
        </div>
      </Section>

      <Section label="Title card">
        <div className={styles.group}>
          <Switch checked={look.titleCard} onChange={(titleCard) => setLook({ titleCard })} label="Show a title card" />
          <TemplateField label="Title" value={look.title} onChange={(title) => setLook({ title })} vars={vars} />
          <TemplateField label="Artist" value={look.artist} onChange={(artist) => setLook({ artist })} vars={vars} />
        </div>
      </Section>
    </div>
  );
}

// ---- Visualizer -----------------------------------------------------------------

export const DEFAULT_VISUALIZER: VisualizerStepOptions = {
  presetId: "",
  designName: "",
  showJson: "",
  mode: VisualizerMode.ModeFull,
  aspect: "16:9",
  height: 1080,
  fps: 30,
  audio: "original",
  background: "none",
  stems: true,
  saveStems: false,
  words: "none",
  language: "",
  mood: true,
};

export function parseVisualizer(json: string): VisualizerStepOptions {
  const o = parseObject(json);
  const d = DEFAULT_VISUALIZER;
  const stems = bool(o.stems, d.stems);
  return {
    presetId: str(o.presetId, d.presetId),
    designName: str(o.designName, d.designName),
    showJson: str(o.showJson, d.showJson),
    mode: oneOf(o.mode, [VisualizerMode.ModeFull, VisualizerMode.ModeOverlay], d.mode) as VisualizerMode,
    aspect: oneOf(o.aspect, ["16:9", "9:16", "1:1", "4:5"], d.aspect),
    height: oneOfNum(o.height, [720, 1080, 1440, 2160], d.height),
    fps: oneOfNum(o.fps, [30, 60], d.fps),
    // The instrumental and the saved stems need the instruments separated.
    audio: stems ? oneOf(o.audio, ["original", "instrumental"], d.audio) : "original",
    background: oneOf(o.background, ["none", "cover"], d.background),
    stems,
    saveStems: stems && bool(o.saveStems, d.saveStems),
    words: oneOf(o.words, ["none", "detect"], d.words),
    language: str(o.language, d.language),
    mood: bool(o.mood, d.mood),
  };
}

function DesignCard({ name, description, on, onPick }: { name: string; description: string; on: boolean; onPick: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={on} className={cx(styles.design, on && styles.designOn)} onClick={onPick}>
      <span className={styles.designName}>{name}</span>
      {description && <span className={styles.designDesc}>{description}</span>}
    </button>
  );
}

function VisualizerEditor({ value, onChange }: StepEditorProps<VisualizerStepOptions>) {
  const set = (patch: Partial<VisualizerStepOptions>) => onChange({ ...value, ...patch });
  const designs = useList<VisualizerDesign>("viz-designs", () => VisualizerService.Designs());
  const spoken = useSpokenLanguages();
  const overlay = value.mode === VisualizerMode.ModeOverlay;
  const presets = useMemo(() => (overlay ? [...PRESETS].sort((a, b) => Number(b.overlayFirst ?? false) - Number(a.overlayFirst ?? false)) : PRESETS), [overlay]);

  const pickPreset = (id: string) => {
    const json = presetShowJson(id);
    const p = PRESETS.find((x) => x.id === id);
    if (json && p) set({ presetId: id, designName: p.name, showJson: json });
  };
  const pickDesign = (d: VisualizerDesign) => set({ presetId: "", designName: d.name, showJson: d.showJson });
  const chosen = value.showJson === "" ? "No design picked yet" : `Design: ${value.designName || value.presetId || "Custom"}`;

  return (
    <div className={styles.stack}>
      <Section label="Design">
        <div className={styles.group}>
          <div className={styles.chosen} data-testid="chosen-design">
            {chosen}
          </div>
          <div className={styles.designs} role="radiogroup" aria-label="Presets">
            {presets.map((p) => (
              <DesignCard key={p.id} name={p.name} description={p.description} on={value.presetId === p.id} onPick={() => pickPreset(p.id)} />
            ))}
          </div>
          {designs.length > 0 && (
            <>
              <div className={styles.muted}>My designs</div>
              <div className={styles.designs} role="radiogroup" aria-label="My designs">
                {designs.map((d) => (
                  <DesignCard key={d.id} name={d.name} description="" on={value.presetId === "" && value.showJson === d.showJson} onPick={() => pickDesign(d)} />
                ))}
              </div>
            </>
          )}
        </div>
      </Section>

      <Section label="Video">
        <div className={styles.group}>
          <Row label="Visuals">
            <SegmentedControl
              aria-label="Mode"
              value={value.mode}
              options={[
                { value: VisualizerMode.ModeFull, label: "Full frame" },
                { value: VisualizerMode.ModeOverlay, label: "Over the video" },
              ]}
              onChange={(mode) => set({ mode })}
            />
          </Row>
          {overlay && <div className={styles.muted}>This needs a video file as its input.</div>}
          {!overlay && (
            <>
              <Row label="Shape">
                <SegmentedControl
                  aria-label="Aspect"
                  value={value.aspect}
                  options={[...ASPECT_OPTIONS, { value: "4:5", label: "4:5" }]}
                  onChange={(aspect) => set({ aspect })}
                />
              </Row>
              <Row label="Quality">
                <SegmentedControl
                  aria-label="Height"
                  value={String(value.height)}
                  options={[
                    { value: "720", label: "720p" },
                    { value: "1080", label: "1080p" },
                    { value: "1440", label: "1440p" },
                    { value: "2160", label: "2160p" },
                  ]}
                  onChange={(v) => set({ height: Number(v) })}
                />
                <SegmentedControl
                  aria-label="Frame rate"
                  value={String(value.fps)}
                  options={[
                    { value: "30", label: "30 fps" },
                    { value: "60", label: "60 fps" },
                  ]}
                  onChange={(v) => set({ fps: Number(v) })}
                />
              </Row>
              <Row label="Background">
                <SegmentedControl
                  aria-label="Background"
                  value={value.background}
                  options={[
                    { value: "none", label: "None" },
                    { value: "cover", label: "Cover art" },
                  ]}
                  onChange={(background) => set({ background })}
                />
              </Row>
            </>
          )}
          <Row label="Audio">
            <SegmentedControl
              aria-label="Audio"
              value={value.audio}
              options={[
                { value: "original", label: "Original" },
                { value: "instrumental", label: "Instrumental", disabled: !value.stems },
              ]}
              onChange={(audio) => set({ audio })}
            />
          </Row>
        </div>
      </Section>

      <Section label="Listening">
        <div className={styles.group}>
          <Row label="Instruments">
            <Switch checked={value.stems} onChange={(stems) => set(stems ? { stems } : { stems, saveStems: false, audio: "original" })} label="Separate instruments" />
          </Row>
          <Row label="Save stems">
            <Switch checked={value.saveStems} disabled={!value.stems} onChange={(saveStems) => set({ saveStems })} label="Also keep the four stems" />
          </Row>
          <Row label="Words">
            <SegmentedControl
              aria-label="Words"
              value={value.words}
              options={[
                { value: "none", label: "None" },
                { value: "detect", label: "Detect" },
              ]}
              onChange={(words) => set({ words })}
            />
          </Row>
          {value.words === "detect" && (
            <Row label="Language">
              <Select aria-label="Language" value={value.language} options={withValue(spoken, value.language)} onChange={(language) => set({ language })} />
            </Row>
          )}
          <Row label="Mood">
            <Switch checked={value.mood} onChange={(mood) => set({ mood })} label="Read the mood of the music" />
          </Row>
        </div>
      </Section>
    </div>
  );
}

/** Types a step editor against its own options (registerSteps takes the erased form). */
function define<T>(ui: StepUI<T>): StepUI<never> {
  return { ...ui, params: PARAMS[ui.type] } as unknown as StepUI<never>;
}

registerSteps([
  define({ type: "subtitles", parse: parseSubtitles, Editor: SubtitlesEditor }),
  define({ type: "lyric-video", parse: parseLyricVideo, Editor: LyricVideoEditor }),
  define({ type: "visualizer", parse: parseVisualizer, Editor: VisualizerEditor }),
]);
