/**
 * Palettes (SPEC.md §6.6): 24 curated palettes mixed in OKLab, and the palette
 * modes (fixed, journey, mood, chords, sections). Shaders get linear RGB.
 */
import type { Analysis } from "./analysis";
import { fifthsHue } from "./signals";
import type { Emotion, PaletteId, PaletteMode } from "./types";

export interface PaletteDef {
  id: PaletteId;
  name: string;
  bg: string;
  colors: [string, string, string, string];
  accent: string;
  glow: string;
}

/** Linear-RGB triplet. */
export type RGB = [number, number, number];

export interface ResolvedPalette {
  bg: RGB;
  colors: [RGB, RGB, RGB, RGB];
  accent: RGB;
  glow: RGB;
}

const P = (id: PaletteId, name: string, bg: string, colors: [string, string, string, string], accent: string, glow: string): PaletteDef => ({ id, name, bg, colors, accent, glow });

/** The 20 song-visualizer palettes (backgrounds darkened for bloom) + golden hour's four phases. */
export const PALETTES: readonly PaletteDef[] = [
  P("cyber", "Cyber", "#04070b", ["#00ffaa", "#00ccff", "#ff2d6e", "#ff77aa"], "#00ffaa", "#00ccff"),
  P("fire", "Fire", "#0b0502", ["#ff6b00", "#ffdd00", "#ff3300", "#ff9900"], "#ffdd00", "#ff6b00"),
  P("ice", "Ice", "#03060c", ["#00c8ff", "#a64dff", "#ffffff", "#4dffd0"], "#ffffff", "#00c8ff"),
  P("mono", "Mono", "#050505", ["#ffffff", "#cccccc", "#888888", "#444444"], "#ffffff", "#cccccc"),
  P("sunset", "Sunset", "#0b0408", ["#ff6ec7", "#ffb347", "#ff8c00", "#e040fb"], "#ffb347", "#ff6ec7"),
  P("matrix", "Matrix", "#010502", ["#00ff41", "#00cc33", "#88ff88", "#0a5a1a"], "#88ff88", "#00ff41"),
  P("neon", "Neon", "#06030a", ["#ff00ff", "#00ffff", "#ffff00", "#ff0080"], "#00ffff", "#ff00ff"),
  P("galaxy", "Galaxy", "#03020a", ["#6a0dad", "#1a1aff", "#00bfff", "#cc88ff"], "#cc88ff", "#1a1aff"),
  P("lava", "Lava", "#0a0201", ["#ff1a00", "#ff4400", "#ff8800", "#ffcc00"], "#ffcc00", "#ff4400"),
  P("ocean", "Ocean", "#01060a", ["#006994", "#00b4d8", "#0077b6", "#48cae4"], "#48cae4", "#00b4d8"),
  P("toxic", "Toxic", "#030702", ["#39ff14", "#ccff00", "#ff6600", "#aaff00"], "#ccff00", "#39ff14"),
  P("vaporwave", "Vaporwave", "#07030b", ["#ff71ce", "#01cdfe", "#05ffa1", "#b967ff"], "#05ffa1", "#ff71ce"),
  P("rose", "Rose", "#0a0206", ["#ff0055", "#ff6b9d", "#ff99c8", "#c71585"], "#ff99c8", "#ff0055"),
  P("plasma", "Plasma", "#05030a", ["#9b5de5", "#f15bb5", "#fee440", "#00bbf9"], "#fee440", "#f15bb5"),
  P("gold", "Gold", "#0a0702", ["#ffd700", "#ffaa00", "#ff8c00", "#ffe066"], "#ffe066", "#ffaa00"),
  P("arctic", "Arctic", "#03070b", ["#e0f7ff", "#a8d8ea", "#4fc3f7", "#0288d1"], "#e0f7ff", "#4fc3f7"),
  P("candy", "Candy", "#08040a", ["#ff6b8a", "#ffd166", "#06d6a0", "#118ab2"], "#ffd166", "#ff6b8a"),
  P("blood", "Blood", "#070101", ["#8b0000", "#cc0000", "#ff2222", "#ff8888"], "#ff8888", "#cc0000"),
  P("forest", "Forest", "#020602", ["#1a6b1a", "#4caf50", "#8bc34a", "#cddc39"], "#cddc39", "#4caf50"),
  P("synthwave", "Synthwave", "#07020c", ["#ff2975", "#f222ff", "#8c1eff", "#00ffdd"], "#00ffdd", "#f222ff"),
  P("deep-night", "Deep night", "#050408", ["#786ea0", "#3c375a", "#b4a0dc", "#6450b4"], "#b4a0dc", "#6450b4"),
  P("dawn", "Dawn", "#120a0c", ["#dc8c50", "#b45a3c", "#ffc896", "#f0a050"], "#ffc896", "#f0a050"),
  P("golden", "Golden", "#0c0802", ["#ffb428", "#dc7814", "#ffdc64", "#ffa014"], "#ffdc64", "#ffa014"),
  P("electric", "Electric", "#04040a", ["#ffc83c", "#1eb4dc", "#fff078", "#32c8ff"], "#fff078", "#32c8ff"),
];

export const PALETTE_BY_ID = new Map<PaletteId, PaletteDef>(PALETTES.map((p) => [p.id, p]));

/** Emotion → palette for the "mood" mode. */
export const MOOD_PALETTE: Record<Emotion, PaletteId> = {
  joy: "sunset",
  love: "rose",
  sadness: "ocean",
  anger: "blood",
  fear: "galaxy",
  calm: "arctic",
  hope: "dawn",
  awe: "plasma",
};

// ---- colour maths (sRGB ↔ linear ↔ OKLab) ----

export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m?.[1] ? parseInt(m[1], 16) : 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(0, c) ** (1 / 2.4) - 0.055);

export function srgbToLinear(c: RGB): RGB {
  return [toLin(c[0]), toLin(c[1]), toLin(c[2])];
}
export function linearToSrgb(c: RGB): RGB {
  return [toSrgb(c[0]), toSrgb(c[1]), toSrgb(c[2])];
}
export function linearToOklab([r, g, b]: RGB): RGB {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
export function oklabToLinear([L, a, b]: RGB): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
export function hexToLinear(hex: string): RGB {
  return srgbToLinear(hexToRgb(hex));
}

/** Mixes two linear colours in OKLab. */
export function mixLinear(a: RGB, b: RGB, t: number): RGB {
  const A = linearToOklab(a);
  const B = linearToOklab(b);
  const w = Math.max(0, Math.min(1, t));
  const o = oklabToLinear([A[0] + (B[0] - A[0]) * w, A[1] + (B[1] - A[1]) * w, A[2] + (B[2] - A[2]) * w]);
  return [Math.max(0, o[0]), Math.max(0, o[1]), Math.max(0, o[2])];
}

/** Rotates a linear colour's OKLab hue by turns (0..1). */
export function rotateHue(c: RGB, turns: number): RGB {
  const [L, a, b] = linearToOklab(c);
  const ang = Math.atan2(b, a) + turns * Math.PI * 2;
  const ch = Math.hypot(a, b);
  const o = oklabToLinear([L, ch * Math.cos(ang), ch * Math.sin(ang)]);
  return [Math.max(0, o[0]), Math.max(0, o[1]), Math.max(0, o[2])];
}

export function resolveDef(p: PaletteDef): ResolvedPalette {
  return {
    bg: hexToLinear(p.bg),
    colors: p.colors.map(hexToLinear) as [RGB, RGB, RGB, RGB],
    accent: hexToLinear(p.accent),
    glow: hexToLinear(p.glow),
  };
}

const resolvedCache = new Map<PaletteId, ResolvedPalette>();
export function paletteById(id: PaletteId): ResolvedPalette {
  let r = resolvedCache.get(id);
  if (!r) {
    r = resolveDef(PALETTE_BY_ID.get(id) ?? (PALETTES[0] as PaletteDef));
    resolvedCache.set(id, r);
  }
  return r;
}

export function mixPalettes(a: ResolvedPalette, b: ResolvedPalette, t: number): ResolvedPalette {
  if (t <= 0) return a;
  if (t >= 1) return b;
  return {
    bg: mixLinear(a.bg, b.bg, t),
    colors: a.colors.map((c, i) => mixLinear(c, b.colors[i] as RGB, t)) as [RGB, RGB, RGB, RGB],
    accent: mixLinear(a.accent, b.accent, t),
    glow: mixLinear(a.glow, b.glow, t),
  };
}

function mapPalette(p: ResolvedPalette, f: (c: RGB) => RGB): ResolvedPalette {
  return { bg: f(p.bg), colors: p.colors.map(f) as [RGB, RGB, RGB, RGB], accent: f(p.accent), glow: f(p.glow) };
}

/** Scales OKLab lightness and chroma (mood valence/energy shading). */
export function shade(p: ResolvedPalette, lightness: number, chroma: number): ResolvedPalette {
  return mapPalette(p, (c) => {
    const [L, a, b] = linearToOklab(c);
    const o = oklabToLinear([L * lightness, a * chroma, b * chroma]);
    return [Math.max(0, o[0]), Math.max(0, o[1]), Math.max(0, o[2])];
  });
}

const smooth = (x: number) => x * x * (3 - 2 * x);

// ---- Calm palette modes (SPEC section C2.6) ----

/** The mood wheel: a mood may only move to a neighbour on it, never across it. */
export const MOOD_WHEEL: readonly Emotion[] = ["joy", "hope", "love", "calm", "sadness", "fear", "anger", "awe"];
/** A mood palette holds at least this many bars, and blends over MOOD_BLEND_MS. */
export const MOOD_HOLD_BARS = 8;
export const MOOD_BLEND_MS = 4000;
/** Chord colours move accents only, at most this many turns (30 degrees) either way, over one bar. */
export const CHORD_MAX_TURNS = 30 / 360;
/** A chord must hold this many beats before it counts. */
export const CHORD_HOLD_BEATS = 2;

function barMsOf(a: Analysis): number {
  return a.audio.tempo > 0 ? (60000 / a.audio.tempo) * (a.audio.beatsPerBar || 4) : 2000;
}

/** One step along the wheel from `from` towards `to` (the shorter way round). */
export function wheelStep(from: Emotion, to: Emotion): Emotion {
  const n = MOOD_WHEEL.length;
  const i = MOOD_WHEEL.indexOf(from);
  const j = MOOD_WHEEL.indexOf(to);
  if (i < 0 || j < 0 || i === j) return to;
  const fwd = (j - i + n) % n;
  return MOOD_WHEEL[(i + (fwd <= n / 2 ? 1 : n - 1)) % n] as Emotion;
}

export interface MoodChange {
  ms: number;
  emotion: Emotion;
}

const moodCache = new WeakMap<Analysis, MoodChange[]>();

/**
 * The emotions the mood palette actually uses: the first key, then a change only after the current one has held
 * MOOD_HOLD_BARS bars, and each change moves one neighbour along the wheel towards what the words ask for.
 */
export function moodPaletteChanges(a: Analysis): MoodChange[] {
  const hit = moodCache.get(a);
  if (hit) return hit;
  const keys = a.text?.mood ?? [];
  const hold = MOOD_HOLD_BARS * barMsOf(a);
  const out: MoodChange[] = [];
  const first = keys[0];
  if (first) {
    out.push({ ms: first.ms, emotion: first.emotion });
    for (const k of keys.slice(1)) {
      const cur = out[out.length - 1] as MoodChange;
      if (k.emotion === cur.emotion || k.ms - cur.ms < hold) continue;
      out.push({ ms: k.ms, emotion: wheelStep(cur.emotion, k.emotion) });
    }
  }
  moodCache.set(a, out);
  return out;
}

/** Accent hue offset (turns) a chord asks for: its circle-of-fifths position, mapped into +-CHORD_MAX_TURNS. */
export function chordTurns(root: number): number {
  return root < 0 ? 0 : (fifthsHue(root) - 0.5) * 2 * CHORD_MAX_TURNS;
}

/** The accent offset (turns) at tMs: chords count after CHORD_HOLD_BEATS beats, and the offset glides over one bar. */
export function chordAccentTurns(a: Analysis, tMs: number): number {
  const beat = a.audio.tempo > 0 ? 60000 / a.audio.tempo : 500;
  const barMs = barMsOf(a);
  const need = CHORD_HOLD_BEATS * beat;
  let cur: { start: number; turns: number } | null = null;
  let before = 0;
  for (const c of a.audio.chords) {
    if (c.root < 0 || c.endMs - c.startMs < need) continue;
    const counts = c.startMs + need;
    if (counts > tMs) break;
    before = cur ? cur.turns : 0;
    cur = { start: counts, turns: chordTurns(c.root) };
  }
  if (!cur) return 0;
  return before + (cur.turns - before) * smooth(Math.min(1, (tMs - cur.start) / barMs));
}

/** The palette at tMs for a show's palette settings (SPEC.md section 6.6); `intensity` is the show's master intensity. */
export function resolvePalette(cfg: { mode: PaletteMode; ids: PaletteId[] }, a: Analysis | null, tMs: number, override?: PaletteId, intensity = 1): ResolvedPalette {
  if (override) return paletteById(override);
  const ids = cfg.ids.length > 0 ? cfg.ids : (["cyber"] as PaletteId[]);
  const first = ids[0] as PaletteId;
  if (!a) return paletteById(first);
  const churn = Math.max(0, Math.min(1.5, intensity));
  switch (cfg.mode) {
    case "journey": {
      if (ids.length === 1) return paletteById(first);
      const x = Math.max(0, Math.min(1, tMs / Math.max(1, a.durationMs))) * (ids.length - 1);
      const i = Math.min(ids.length - 2, Math.floor(x));
      return mixPalettes(paletteById(ids[i] as PaletteId), paletteById(ids[i + 1] as PaletteId), smooth(x - i));
    }
    case "mood": {
      const changes = moodPaletteChanges(a);
      let idx = -1;
      for (let i = 0; i < changes.length && (changes[i]?.ms ?? Infinity) <= tMs; i++) idx = i;
      const cur = changes[idx];
      if (!cur) return paletteById(MOOD_PALETTE[a.moodAt(tMs).emotion]);
      const prev = changes[idx - 1];
      const base = prev ? mixPalettes(paletteById(MOOD_PALETTE[prev.emotion]), paletteById(MOOD_PALETTE[cur.emotion]), smooth(Math.min(1, (tMs - cur.ms) / MOOD_BLEND_MS))) : paletteById(MOOD_PALETTE[cur.emotion]);
      const m = a.moodAt(tMs);
      return shade(base, 1 + 0.08 * m.valence * churn, 1 + 0.15 * (m.energy * 2 - 1) * churn);
    }
    case "chords": {
      // only the accents rotate (never the background or the four colours), a little, and slowly
      const base = paletteById(first);
      const turns = chordAccentTurns(a, tMs) * churn;
      if (turns === 0) return base;
      return { ...base, accent: rotateHue(base.accent, turns), glow: rotateHue(base.glow, turns) };
    }
    case "sections": {
      const s = a.sectionAt(tMs)?.section;
      const groups = [...new Set(a.audio.sections.map((x) => x.group))];
      const gi = s ? Math.max(0, groups.indexOf(s.group)) : 0;
      return paletteById(ids[gi % ids.length] as PaletteId);
    }
    default:
      return paletteById(first);
  }
}
