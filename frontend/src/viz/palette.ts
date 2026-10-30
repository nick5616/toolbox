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

/** The palette at tMs for a show's palette settings (SPEC.md §6.6). */
export function resolvePalette(cfg: { mode: PaletteMode; ids: PaletteId[] }, a: Analysis | null, tMs: number, override?: PaletteId): ResolvedPalette {
  if (override) return paletteById(override);
  const ids = cfg.ids.length > 0 ? cfg.ids : (["cyber"] as PaletteId[]);
  const first = ids[0] as PaletteId;
  if (!a) return paletteById(first);
  switch (cfg.mode) {
    case "journey": {
      if (ids.length === 1) return paletteById(first);
      const x = Math.max(0, Math.min(1, tMs / Math.max(1, a.durationMs))) * (ids.length - 1);
      const i = Math.min(ids.length - 2, Math.floor(x));
      return mixPalettes(paletteById(ids[i] as PaletteId), paletteById(ids[i + 1] as PaletteId), smooth(x - i));
    }
    case "mood": {
      const keys = a.text?.mood ?? [];
      let idx = -1;
      for (let i = 0; i < keys.length && (keys[i]?.ms ?? Infinity) <= tMs; i++) idx = i;
      const cur = keys[idx];
      if (!cur) return paletteById(MOOD_PALETTE[a.moodAt(tMs).emotion]);
      let prevEmotion = cur.emotion;
      let changeAt = cur.ms;
      for (let i = idx; i >= 0; i--) {
        const k = keys[i];
        if (k && k.emotion !== cur.emotion) {
          prevEmotion = k.emotion;
          changeAt = keys[i + 1]?.ms ?? cur.ms;
          break;
        }
      }
      const base = mixPalettes(paletteById(MOOD_PALETTE[prevEmotion]), paletteById(MOOD_PALETTE[cur.emotion]), smooth(Math.min(1, (tMs - changeAt) / 2000)));
      const m = a.moodAt(tMs);
      return shade(base, 1 + 0.08 * m.valence, 1 + 0.15 * (m.energy * 2 - 1));
    }
    case "chords": {
      const base = paletteById(first);
      const chords = a.audio.chords;
      let i = -1;
      for (let k = 0; k < chords.length && (chords[k]?.startMs ?? Infinity) <= tMs; k++) i = k;
      const cur = chords[i];
      if (!cur || cur.root < 0) return base;
      const prev = chords[i - 1];
      const target = fifthsHue(cur.root);
      const from = prev && prev.root >= 0 ? fifthsHue(prev.root) : target;
      let d = target - from;
      if (d > 0.5) d -= 1;
      if (d < -0.5) d += 1;
      const hue = from + d * smooth(Math.min(1, (tMs - cur.startMs) / 400));
      const [L0, a0, b0] = linearToOklab(base.colors[0]);
      const baseTurn = Math.atan2(b0, a0) / (Math.PI * 2);
      void L0;
      return mapPalette(base, (c) => rotateHue(c, hue - baseTurn));
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
