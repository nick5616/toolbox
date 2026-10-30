/**
 * The Visualizer's design format (SPEC.md §6.4). This file is the source of
 * truth: Go treats a show as an opaque JSON string (`ShowJSON`).
 *
 * CONTRACT (foundation): frozen. Add layer/post types by extending the unions
 * below and registering a def (layers/registry.ts, post/registry.ts).
 */

/** Every reactive input a parameter can follow (SPEC.md §6.3). */
export const SIGNAL_IDS = [
  "mix.level", "mix.onset", "mix.brightness", "mix.balance",
  "mix.sub", "mix.bass", "mix.lowmid", "mix.mid", "mix.highmid", "mix.presence", "mix.brilliance", "mix.air",
  "kick", "snare", "hats",
  "drums.level", "bass.level", "vocals.level", "other.level",
  "bass.onset", "vocals.onset", "other.onset",
  "vocals.pitch", "vocals.voiced", "vocals.held",
  "beat.pulse", "beat.phase", "bar.pulse", "bar.phase",
  "section.energy", "section.progress", "song.progress",
  "lift.pulse", "drop.pulse", "break.pulse",
  "chord.change", "chord.hue", "key.minor",
  "word.pulse", "word.emphasis", "line.progress", "line.active",
  "mood.valence", "mood.energy",
  "lfo.slow", "lfo.mid", "time",
] as const;
export type SignalId = (typeof SIGNAL_IDS)[number];

/** Visual-mix fader groups (SPEC.md §6.3). */
export const MIX_GROUPS = ["drums", "bass", "vocals", "other", "words", "mood"] as const;
export type MixGroup = (typeof MIX_GROUPS)[number];

export const LAYER_TYPES = [
  "gradient", "nebula", "aurora", "ink", "synthgrid", "tunnel", "starfield", "terrain", "image", "kaleido",
  "bars", "radial", "ribbons", "wavering", "oscilloscope", "lissajous", "helix", "vortex", "geometry", "pitchribbon",
  "embers", "bursts", "fireflies", "ripples", "shockwave", "sweep", "lightrays", "frame",
  "highway", "motif",
] as const;
export type LayerType = (typeof LAYER_TYPES)[number];

export const POST_TYPES = [
  "bloom", "vignette", "grain", "chromatic", "feedback", "mirror", "shake", "zoompulse", "glitch", "grade",
] as const;
export type PostType = (typeof POST_TYPES)[number];

export const PALETTE_IDS = [
  "cyber", "fire", "ice", "mono", "sunset", "matrix", "neon", "galaxy", "lava", "ocean",
  "toxic", "vaporwave", "rose", "plasma", "gold", "arctic", "candy", "blood", "forest", "synthwave",
  "deep-night", "dawn", "golden", "electric",
] as const;
export type PaletteId = (typeof PALETTE_IDS)[number];

export const EMOTIONS = ["joy", "love", "sadness", "anger", "fear", "calm", "hope", "awe"] as const;
export type Emotion = (typeof EMOTIONS)[number];

export const MOTIFS = ["fire", "rain", "snow", "stars", "ocean", "flowers", "hearts", "city", "sun", "night", "storm", "smoke"] as const;
export type Motif = (typeof MOTIFS)[number];

export const SECTION_LABELS = ["intro", "verse", "chorus", "bridge", "break", "drop", "outro", "section"] as const;
export type SectionLabel = (typeof SECTION_LABELS)[number];

export type ModShape = "linear" | "ease" | "exp" | "gate";

export interface Mod {
  signal: SignalId;
  amount: number; // -2..2
  shape: ModShape;
  attackMs?: number; // default 10
  releaseMs?: number; // default 180
}

/** A numeric parameter: a constant or a base plus signal-driven mods. */
export type Param = number | { base: number; mods: Mod[] };

export type Blend = "normal" | "add" | "screen" | "multiply";

export interface LayerConfig {
  id: string;
  type: LayerType;
  enabled: boolean;
  blend: Blend;
  opacity: Param;
  params: Record<string, Param | string | boolean>;
}

export interface PostConfig {
  id: string;
  type: PostType;
  enabled: boolean;
  params: Record<string, Param | string | boolean>;
}

export interface Scene {
  id: string; // "calm" | "main" | "full" | anything
  name: string;
  layers: LayerConfig[]; // ≤ 12
  post: PostConfig[];
}

export type TransitionKind = "cut" | "crossfade" | "flash" | "zoom" | "sweep" | "glitch";
export interface Transition {
  kind: TransitionKind;
  ms: number;
}

export interface TimelineEntry {
  startMs: number;
  endMs: number;
  sceneId: string;
  transition: Transition;
  paletteId?: PaletteId;
}

export type PaletteMode = "fixed" | "journey" | "mood" | "chords" | "sections";

export type TextPreset = "karaoke" | "pop" | "rise" | "typewriter" | "fade" | "wave" | "subtitle" | "subtitle-boxed";

export interface TextStyle {
  preset: TextPreset;
  font: string;
  weight: 400 | 700 | 900;
  size: number; // % of the short side, 3–12
  color: string; // #rrggbb
  highlight: string; // #rrggbb or "mood"
  position: "center" | "lower" | "upper";
  showNext: boolean;
  uppercase: boolean;
  outline: number; // 0–0.15 of size
  glow: number; // 0–1
  emphasis: { scale: number; glow: number; color: "highlight" | "mood"; sparks: boolean };
  react: { signal: SignalId | null; amount: number };
  titleCard?: { title: string; artist: string } | null;
}

export interface ReactionSlot {
  label: string;
  target: string; // "<layerId>.<param>" (any scene) or "post.<postId>.<param>"
}

/** Director rules a preset carries (SPEC.md §6.9). */
export interface DirectorRules {
  sceneFor: Partial<Record<SectionLabel, string>>;
  transitions: Partial<Record<SectionLabel | "drop" | "chorusAfterLift", Transition>>;
  /** "emotion" makes scenes follow the mood instead of sections (Mood Field). */
  follow?: "sections" | "emotion";
  sceneForEmotion?: Partial<Record<Emotion, string>>;
}

export interface Show {
  version: 1;
  name: string;
  presetId: string | null;
  scenes: Scene[]; // 1–6
  timeline: { mode: "auto" | "manual"; entries: TimelineEntry[] };
  palette: { mode: PaletteMode; ids: PaletteId[] };
  mix: Record<MixGroup, number>; // 0–2
  reactivity: number; // 0–2
  speed: number; // 0.25–2
  text: TextStyle | null;
  motifs: boolean;
  post: PostConfig[];
  controls: ReactionSlot[];
  director?: DirectorRules;
}

/** What the export worker receives (written by Go, RenderPlan with URLs). */
export interface PlanForWorker {
  analysis: { audioJsonUrl: string; featuresUrl: string; textJsonUrl: string };
  showJson: string;
  width: number;
  height: number;
  fps: number;
  startMs: number;
  endMs: number;
  mode: "opaque" | "overlay";
  coverUrl: string;
  imageUrl: string;
  seed: number;
}

export const MAX_SHOW_BYTES = 512 * 1024;
export const MAX_LAYERS_PER_SCENE = 12;
export const MAX_SCENES = 6;
