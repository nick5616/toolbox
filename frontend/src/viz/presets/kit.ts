/**
 * Small builders shared by the preset files. They only produce plain Show data
 * (everything stays JSON), so presets read as a list of layers and mods.
 */
import type { Blend, DirectorRules, LayerConfig, LayerType, Mod, ModShape, Param, PaletteId, PaletteMode, PostConfig, PostType, ReactionSlot, Scene, SignalId, Show, TextPreset, TextStyle } from "../types";

type ParamValue = Param | string | boolean;

/** A modulation: `signal` moves the parameter by `amount` of its range. */
export function m(signal: SignalId, amount: number, shape: ModShape = "ease", attackMs?: number, releaseMs?: number): Mod {
  const mod: Mod = { signal, amount, shape };
  if (attackMs !== undefined) mod.attackMs = attackMs;
  if (releaseMs !== undefined) mod.releaseMs = releaseMs;
  return mod;
}

/** A parameter: a base value plus mods (a plain number without mods). */
export function P(base: number, ...mods: Mod[]): Param {
  return mods.length === 0 ? base : { base, mods };
}

export interface LayerOptions {
  blend?: Blend;
  opacity?: Param;
  enabled?: boolean;
}

export function L(id: string, type: LayerType, params: Record<string, ParamValue> = {}, o: LayerOptions = {}): LayerConfig {
  return { id, type, enabled: o.enabled ?? true, blend: o.blend ?? "add", opacity: o.opacity ?? 1, params };
}

/** A background layer: drawn normally (not added) so it replaces the clear colour. */
export function BG(id: string, type: LayerType, params: Record<string, ParamValue> = {}, o: LayerOptions = {}): LayerConfig {
  return L(id, type, params, { blend: "normal", ...o });
}

export function S(id: string, name: string, layers: LayerConfig[], post: PostConfig[] = []): Scene {
  return { id, name, layers, post };
}

export function X(id: string, type: PostType, params: Record<string, ParamValue> = {}): PostConfig {
  return { id, type, enabled: true, params };
}

export interface GlobalPost {
  bloom?: Param;
  threshold?: number;
  vignette?: number;
  grain?: number;
  extra?: PostConfig[];
}

/** The global chain: bloom, vignette and grain first (output effects), then pass effects. */
export function globalPost(g: GlobalPost = {}): PostConfig[] {
  return [
    X("bloom", "bloom", { intensity: g.bloom ?? 0.6, threshold: g.threshold ?? 0.85 }),
    X("vignette", "vignette", { amount: g.vignette ?? 0.4 }),
    X("grain", "grain", { amount: g.grain ?? 0.1 }),
    ...(g.extra ?? []),
  ];
}

export interface ShowSpec {
  name: string;
  id: string;
  scenes: Scene[];
  palette: { mode: PaletteMode; ids: PaletteId[] };
  post?: PostConfig[];
  controls: ReactionSlot[];
  text?: TextStyle | null;
  motifs?: boolean;
  director?: DirectorRules;
  mix?: Partial<Show["mix"]>;
  reactivity?: number;
  speed?: number;
}

export function makeShow(s: ShowSpec): Show {
  const show: Show = {
    version: 1,
    name: s.name,
    presetId: s.id,
    scenes: s.scenes,
    timeline: { mode: "auto", entries: [] },
    palette: s.palette,
    mix: { drums: 1, bass: 1, vocals: 1, other: 1, words: 1, mood: 1, ...s.mix },
    reactivity: s.reactivity ?? 1,
    speed: s.speed ?? 1,
    text: s.text ?? null,
    motifs: s.motifs ?? false,
    post: s.post ?? globalPost(),
    controls: s.controls,
  };
  if (s.director) show.director = s.director;
  return show;
}

export interface TextOptions {
  font?: string;
  weight?: TextStyle["weight"];
  size?: number;
  color?: string;
  highlight?: string;
  position?: TextStyle["position"];
  showNext?: boolean;
  uppercase?: boolean;
  outline?: number;
  glow?: number;
  emphasis?: Partial<TextStyle["emphasis"]>;
  react?: TextStyle["react"];
}

export function text(preset: TextPreset, o: TextOptions = {}): TextStyle {
  const subtitle = preset === "subtitle" || preset === "subtitle-boxed";
  return {
    preset,
    font: o.font ?? "Arial",
    weight: o.weight ?? (subtitle ? 700 : 900),
    size: o.size ?? (subtitle ? 5 : 7),
    color: o.color ?? "#ffffff",
    highlight: o.highlight ?? "mood",
    position: o.position ?? (subtitle ? "lower" : "center"),
    showNext: o.showNext ?? false, // the next line collides with two-line captions, so it is opt-in
    uppercase: o.uppercase ?? !subtitle,
    outline: o.outline ?? (subtitle ? 0.08 : 0.03),
    glow: o.glow ?? (subtitle ? 0 : 0.6),
    emphasis: { scale: 1.25, glow: 0.8, color: "highlight", sparks: true, ...o.emphasis },
    react: o.react ?? { signal: "vocals.level", amount: 0.4 },
    titleCard: null,
  };
}

const bar = (kind: "crossfade" | "zoom" | "sweep" | "flash" | "glitch", ms: number) => ({ kind, ms });

/** The usual director: calm intro/outro/bridge, main verses, full choruses and drops. */
export function director(o: Partial<DirectorRules> = {}): DirectorRules {
  return {
    sceneFor: { intro: "calm", outro: "calm", bridge: "calm", break: "calm", verse: "main", section: "main", chorus: "full", drop: "full" },
    transitions: { chorus: bar("crossfade", 2000), drop: bar("flash", 1000), chorusAfterLift: bar("zoom", 1600) },
    ...o,
  };
}
