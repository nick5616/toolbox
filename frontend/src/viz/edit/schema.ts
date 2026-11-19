/**
 * Parsing and validation of Edit Studio's JSON-in-string fields (Phase 9 SPEC
 * §6.3). CONTRACT (Wave 0): frozen.
 *
 * Every parser returns a usable value: "" gives the default, and anything
 * invalid is dropped or clamped with a problem string. Parsers never throw.
 */
import type { TextLine, TextWord } from "../analysis";
import "../post";
import { postDef } from "../post/registry";
import { LAYER_TYPES, PALETTE_IDS, POST_TYPES, SECTION_LABELS, SIGNAL_IDS, type LayerType, type ModShape, type PaletteId, type PostType, type SectionLabel, type TextStyle, type TransitionKind } from "../types";
import {
  MARKER_LANES,
  type ClipTransform,
  type ClipCrop,
  type EditMod,
  type EditParam,
  type EditPost,
  type EditSignalId,
  type EditTransition,
  type Key,
  type Mask,
  type TextClip,
  type VisualClip,
} from "./types";

export interface Parsed<T> {
  ok: boolean; // problems.length === 0
  value: T;
  problems: string[];
}

const done = <T>(value: T, problems: string[]): Parsed<T> => ({ ok: problems.length === 0, value, problems });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function parseJSON(raw: string, what: string, problems: string[]): unknown {
  if (raw === "") return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    problems.push(`${what}: not valid JSON`);
    return undefined;
  }
}

// ---- limits ----

export const MAX_KEYS = 64;
export const MAX_MODS = 4;
export const MAX_EFFECTS = 8;
export const MAX_MASKS = 4;
export const MAX_PATH_POINTS = 32;
export const MAX_TRANSITION_MS = 2000;
export const SPEED_MIN = 0;
export const SPEED_MAX = 4;

export const TRANSITION_KINDS: readonly TransitionKind[] = [
  "cut", "crossfade", "flash", "zoom", "sweep", "glitch",
  "zoomout", "spin", "whip", "slide", "blur", "rgbsplit", "shake", "warp", "luma", "iris", "stripes", "flashblack",
];
const SHAPES: readonly ModShape[] = ["linear", "ease", "exp", "gate"];
const EASES: readonly Key["ease"][] = ["linear", "ease", "hold", "in", "out", "inout", "bezier"];

/** Post types Edit Studio offers on clips and adjustment clips (§9.1): passes, no stateful ones. */
export const CLIP_POST_TYPES: readonly PostType[] = POST_TYPES.filter((t) => t !== "feedback" && t !== "bloom" && t !== "vignette" && t !== "grain");
/** Post types the project Look offers: the clip ones plus the output effects. */
export const LOOK_POST_TYPES: readonly PostType[] = POST_TYPES.filter((t) => t !== "feedback");

const MARKER_SIGNALS = new Set<string>(MARKER_LANES.map((l) => `marker.${l}`));
const VIZ_SIGNALS = new Set<string>(SIGNAL_IDS);

export function isEditSignal(s: unknown): s is EditSignalId {
  return typeof s === "string" && (VIZ_SIGNALS.has(s) || MARKER_SIGNALS.has(s));
}

export function isMarkerSignal(s: string): boolean {
  return MARKER_SIGNALS.has(s);
}

// ---- EditParam ----

export interface ParamRules {
  min: number;
  max: number;
  allowKeys?: boolean; // default true
  allowMods?: boolean; // default true
}

/** Validates an EditParam against [min, max]; out-of-range numbers are clamped. */
export function parseEditParam(v: unknown, def: number, rules: ParamRules, where: string, problems: string[]): EditParam {
  const { min, max } = rules;
  if (v === undefined) return def;
  if (isNum(v)) {
    if (v < min || v > max) problems.push(`${where}: ${v} is outside ${min}..${max}`);
    return clamp(v, min, max);
  }
  if (!isObj(v) || !isNum(v.base)) {
    problems.push(`${where}: not a number or {base, keys, mods}`);
    return def;
  }
  const base = clamp(v.base, min, max);
  if (base !== v.base) problems.push(`${where}: base is outside ${min}..${max}`);
  const out: { base: number; keys?: Key[]; mods?: EditMod[] } = { base };
  if (v.keys !== undefined) {
    if (rules.allowKeys === false) problems.push(`${where}: keyframes aren't allowed here`);
    else if (!Array.isArray(v.keys)) problems.push(`${where}: keys must be a list`);
    else {
      const keys: Key[] = [];
      for (const k of v.keys.slice(0, MAX_KEYS)) {
        if (!isObj(k) || !isNum(k.t) || !isNum(k.v) || k.t < 0) {
          problems.push(`${where}: a keyframe is invalid`);
          continue;
        }
        let ease = EASES.includes(k.ease as Key["ease"]) ? (k.ease as Key["ease"]) : "linear";
        const key: Key = { t: Math.round(k.t), v: clamp(k.v, min, max), ease };
        if (ease === "bezier") {
          const b = k.bez;
          if (Array.isArray(b) && b.length === 4 && b.every(isNum)) {
            key.bez = [clamp(b[0] as number, 0, 1), clamp(b[1] as number, -1, 2), clamp(b[2] as number, 0, 1), clamp(b[3] as number, -1, 2)];
          } else {
            problems.push(`${where}: a bezier keyframe needs bez [x1, y1, x2, y2]`);
            ease = "ease";
            key.ease = ease;
          }
        }
        keys.push(key);
      }
      if (v.keys.length > MAX_KEYS) problems.push(`${where}: at most ${MAX_KEYS} keyframes`);
      keys.sort((a, b) => a.t - b.t);
      if (keys.length) out.keys = keys;
    }
  }
  if (v.mods !== undefined) {
    if (rules.allowMods === false) problems.push(`${where}: reactions aren't allowed here`);
    else if (!Array.isArray(v.mods)) problems.push(`${where}: mods must be a list`);
    else {
      const mods: EditMod[] = [];
      for (const m of v.mods.slice(0, MAX_MODS)) {
        const mod = parseMod(m, `${where}.mods`, problems);
        if (mod) mods.push(mod);
      }
      if (v.mods.length > MAX_MODS) problems.push(`${where}: at most ${MAX_MODS} reactions`);
      if (mods.length) out.mods = mods;
    }
  }
  return out.keys || out.mods ? out : base;
}

function parseMod(m: unknown, where: string, problems: string[]): EditMod | null {
  if (!isObj(m) || !isEditSignal(m.signal) || !isNum(m.amount)) {
    problems.push(`${where}: a reaction is invalid`);
    return null;
  }
  const mod: EditMod = {
    signal: m.signal,
    amount: clamp(m.amount, -2, 2),
    shape: SHAPES.includes(m.shape as ModShape) ? (m.shape as ModShape) : "linear",
  };
  if (isNum(m.attackMs)) mod.attackMs = clamp(m.attackMs, 0, 5000);
  if (isNum(m.releaseMs)) mod.releaseMs = clamp(m.releaseMs, 0, 5000);
  if (m.every !== undefined) {
    if (isMarkerSignal(m.signal) && isNum(m.every)) mod.every = clamp(Math.round(m.every), 1, 16);
    else problems.push(`${where}: "every" works only with marker signals`);
  }
  if (m.sections !== undefined) {
    if (Array.isArray(m.sections)) {
      const s = m.sections.filter((x): x is SectionLabel => (SECTION_LABELS as readonly string[]).includes(String(x)));
      if (s.length !== m.sections.length) problems.push(`${where}: unknown section label`);
      if (s.length) mod.sections = s;
    } else problems.push(`${where}: sections must be a list`);
  }
  return mod;
}

/** The base value of a param (keys and mods ignored). */
export function baseOf(p: EditParam): number {
  return typeof p === "number" ? p : p.base;
}

// ---- transform ----

export const TRANSFORM_RULES: Record<Exclude<keyof ClipTransform, "edges" | "crop">, ParamRules & { def: number }> = {
  x: { min: -2, max: 2, def: 0 },
  y: { min: -2, max: 2, def: 0 },
  scale: { min: 0.05, max: 8, def: 1 },
  rotation: { min: -3600, max: 3600, def: 0 },
  opacity: { min: 0, max: 1, def: 1 },
};

export const IDENTITY_TRANSFORM: ClipTransform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };

export function parseTransform(raw: string): Parsed<ClipTransform> {
  const problems: string[] = [];
  const v = parseJSON(raw, "transform", problems);
  if (v === undefined) return done({ ...IDENTITY_TRANSFORM }, problems);
  if (!isObj(v)) return done({ ...IDENTITY_TRANSFORM }, [...problems, "transform: not an object"]);
  const out = { ...IDENTITY_TRANSFORM };
  for (const k of Object.keys(TRANSFORM_RULES) as Array<keyof typeof TRANSFORM_RULES>) {
    const r = TRANSFORM_RULES[k];
    out[k] = parseEditParam(v[k], r.def, r, `transform.${k}`, problems);
  }
  if (v.edges === "mirror") out.edges = "mirror";
  else if (v.edges !== undefined && v.edges !== "clear") problems.push("transform.edges: unknown");
  if (v.crop !== undefined) {
    if (!isObj(v.crop)) problems.push("transform.crop: not an object");
    else {
      const c = v.crop;
      const crop: ClipCrop = { l: 0, r: 0, t: 0, b: 0 };
      for (const k of ["l", "r", "t", "b"] as const) crop[k] = parseEditParam(c[k], 0, CROP_RULES, `transform.crop.${k}`, problems);
      if (!(["l", "r", "t", "b"] as const).every((k) => crop[k] === 0)) out.crop = crop;
    }
  }
  return done(out, problems);
}

/** Crop edges (Phase 21 §B4): fraction of the source from each edge. */
export const CROP_RULES: ParamRules & { def: number } = { min: 0, max: 0.45, def: 0 };

export function serializeTransform(t: ClipTransform): string {
  const identity = (Object.keys(IDENTITY_TRANSFORM) as Array<keyof ClipTransform>).every((k) => t[k] === IDENTITY_TRANSFORM[k]) && (t.edges ?? "clear") === "clear" && t.crop === undefined;
  return identity ? "" : JSON.stringify(t);
}

// ---- masks ----

const MASK_RULES = {
  x: { min: -1, max: 2, def: 0.5 },
  y: { min: -1, max: 2, def: 0.5 },
  w: { min: 0, max: 2, def: 0.5 },
  h: { min: 0, max: 2, def: 0.5 },
  rotation: { min: -3600, max: 3600, def: 0 },
} as const;

export function newMask(id: string, shape: Mask["shape"]): Mask {
  const m: Mask = { id, shape, x: 0.5, y: 0.5, w: 0.5, h: 0.5, rotation: 0, feather: 0.02, invert: false, op: "add" };
  if (shape === "path") {
    m.w = 1;
    m.h = 1;
    m.points = [
      [0.3, 0.3],
      [0.7, 0.3],
      [0.7, 0.7],
      [0.3, 0.7],
    ];
    m.smooth = false;
  }
  return m;
}

export function parseMasks(raw: string): Parsed<Mask[]> {
  const problems: string[] = [];
  const v = parseJSON(raw, "masks", problems);
  if (v === undefined) return done([], problems);
  if (!Array.isArray(v)) return done([], [...problems, "masks: not a list"]);
  const out: Mask[] = [];
  const ids = new Set<string>();
  for (const [i, m] of v.slice(0, MAX_MASKS).entries()) {
    const w = `masks[${i}]`;
    if (!isObj(m) || typeof m.id !== "string" || !m.id || ids.has(m.id) || !["rect", "ellipse", "path"].includes(String(m.shape))) {
      problems.push(`${w}: invalid mask`);
      continue;
    }
    ids.add(m.id);
    const mask = newMask(m.id, m.shape as Mask["shape"]);
    for (const k of Object.keys(MASK_RULES) as Array<keyof typeof MASK_RULES>) {
      const r = MASK_RULES[k];
      mask[k] = parseEditParam(m[k], mask.shape === "path" && (k === "w" || k === "h") ? 1 : r.def, r, `${w}.${k}`, problems);
    }
    mask.feather = isNum(m.feather) ? clamp(m.feather, 0, 0.5) : 0.02;
    mask.invert = m.invert === true;
    mask.op = ["add", "subtract", "intersect"].includes(String(m.op)) ? (m.op as Mask["op"]) : "add";
    if (mask.shape === "path") {
      const pts = Array.isArray(m.points) ? m.points : [];
      const ok = pts.filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1]));
      if (ok.length < 3 || ok.length > MAX_PATH_POINTS || ok.length !== pts.length) {
        problems.push(`${w}: a path needs 3–${MAX_PATH_POINTS} points`);
        if (ok.length < 3) continue;
      }
      mask.points = ok.slice(0, MAX_PATH_POINTS).map(([x, y]) => [clamp(x, -1, 2), clamp(y, -1, 2)]);
      mask.smooth = m.smooth === true;
    } else {
      delete mask.points;
      delete mask.smooth;
    }
    out.push(mask);
  }
  if (v.length > MAX_MASKS) problems.push(`masks: at most ${MAX_MASKS}`);
  return done(out, problems);
}

export function serializeMasks(m: Mask[]): string {
  return m.length ? JSON.stringify(m) : "";
}

// ---- effects and the Look ----

function parsePosts(raw: string, what: string, allowed: readonly PostType[]): Parsed<EditPost[]> {
  const problems: string[] = [];
  const v = parseJSON(raw, what, problems);
  if (v === undefined) return done([], problems);
  if (!Array.isArray(v)) return done([], [...problems, `${what}: not a list`]);
  const out: EditPost[] = [];
  const ids = new Set<string>();
  for (const [i, p] of v.slice(0, MAX_EFFECTS).entries()) {
    const w = `${what}[${i}]`;
    if (!isObj(p) || typeof p.id !== "string" || !p.id || ids.has(p.id)) {
      problems.push(`${w}: invalid effect`);
      continue;
    }
    if (!allowed.includes(p.type as PostType)) {
      problems.push(`${w}: "${String(p.type)}" isn't offered here`);
      continue;
    }
    ids.add(p.id);
    const type = p.type as PostType;
    const params: EditPost["params"] = {};
    const rawParams = isObj(p.params) ? p.params : {};
    const def = postDef(type);
    if (def) {
      for (const [k, spec] of Object.entries(def.params)) {
        const pv = rawParams[k];
        if (pv === undefined) continue;
        if (spec.kind === "number") params[k] = parseEditParam(pv, spec.default, { min: spec.min, max: spec.max }, `${w}.${k}`, problems);
        else if (spec.kind === "bool") {
          if (typeof pv === "boolean") params[k] = pv;
          else problems.push(`${w}.${k}: not on/off`);
        } else if (spec.kind === "enum" && spec.options.length === 0) {
          // An enum without options is free text (Phase 21: gradelook's compiled look table, ≤ 64 KiB).
          if (typeof pv === "string" && pv.length <= 65536) params[k] = pv;
          else problems.push(`${w}.${k}: not text`);
        } else if (spec.kind === "enum") {
          if (typeof pv === "string" && spec.options.includes(pv)) params[k] = pv;
          else problems.push(`${w}.${k}: unknown option`);
        } else if (typeof pv === "string") params[k] = pv;
        else problems.push(`${w}.${k}: not a colour`);
      }
      for (const k of Object.keys(rawParams)) if (!(k in def.params)) problems.push(`${w}.${k}: unknown setting dropped`);
    } else {
      // Not registered in this build (a newer pass): keep well-formed values.
      for (const [k, pv] of Object.entries(rawParams)) {
        if (typeof pv === "string" || typeof pv === "boolean") params[k] = pv;
        else params[k] = parseEditParam(pv, 0, { min: -1e6, max: 1e6 }, `${w}.${k}`, problems);
      }
    }
    out.push({ id: p.id, type, enabled: p.enabled !== false, params });
  }
  if (v.length > MAX_EFFECTS) problems.push(`${what}: at most ${MAX_EFFECTS} effects`);
  return done(out, problems);
}

export function parseEffects(raw: string): Parsed<EditPost[]> {
  return parsePosts(raw, "effects", CLIP_POST_TYPES);
}

export function parseLook(raw: string): Parsed<EditPost[]> {
  return parsePosts(raw, "look", LOOK_POST_TYPES);
}

export function serializeEffects(p: EditPost[]): string {
  return p.length ? JSON.stringify(p) : "";
}

export const serializeLook = serializeEffects;

// ---- transition ----

export const CUT: EditTransition = { kind: "cut", ms: 0 };

export function parseTransition(raw: string): Parsed<EditTransition> {
  const problems: string[] = [];
  const v = parseJSON(raw, "in", problems);
  if (v === undefined) return done({ ...CUT }, problems);
  if (!isObj(v) || !TRANSITION_KINDS.includes(v.kind as TransitionKind)) return done({ ...CUT }, [...problems, "in: unknown transition"]);
  const kind = v.kind as TransitionKind;
  const ms = isNum(v.ms) ? clamp(Math.round(v.ms), 0, MAX_TRANSITION_MS) : 0;
  if (isNum(v.ms) && ms !== Math.round(v.ms)) problems.push(`in: length is outside 0..${MAX_TRANSITION_MS} ms`);
  return done({ kind, ms: kind === "cut" ? 0 : ms }, problems);
}

export function serializeTransition(t: EditTransition): string {
  return t.kind === "cut" ? "" : JSON.stringify(t);
}

// ---- speed ----

export function parseSpeed(raw: string): Parsed<EditParam> {
  const problems: string[] = [];
  const v = parseJSON(raw, "speed", problems);
  if (v === undefined) return done(1, problems);
  return done(parseEditParam(v, 1, { min: SPEED_MIN, max: SPEED_MAX, allowMods: false }, "speed", problems), problems);
}

export function serializeSpeed(p: EditParam): string {
  return p === 1 ? "" : JSON.stringify(p);
}

// ---- captions ----

export const DEFAULT_TEXT_STYLE: TextStyle = {
  preset: "pop",
  font: "Arial",
  weight: 900,
  size: 9,
  color: "#ffffff",
  highlight: "#ffd400",
  position: "center",
  showNext: false,
  uppercase: true,
  outline: 0.08,
  glow: 0.2,
  emphasis: { scale: 1.25, glow: 0.6, color: "highlight", sparks: false },
  react: { signal: null, amount: 1 },
  titleCard: null,
};

const TEXT_PRESETS = ["karaoke", "pop", "rise", "typewriter", "fade", "wave", "subtitle", "subtitle-boxed"];
const HEX = /^#[0-9a-fA-F]{6}$/;

export function parseTextStyle(raw: string): Parsed<TextStyle> {
  const problems: string[] = [];
  const v = parseJSON(raw, "captions.style", problems);
  const d = DEFAULT_TEXT_STYLE;
  if (v === undefined) return done({ ...d, emphasis: { ...d.emphasis }, react: { ...d.react } }, problems);
  if (!isObj(v)) return done({ ...d, emphasis: { ...d.emphasis }, react: { ...d.react } }, [...problems, "captions.style: not an object"]);
  const num = (k: string, lo: number, hi: number, def: number) => {
    const x = v[k];
    if (x === undefined) return def;
    if (!isNum(x)) {
      problems.push(`captions.style.${k}: not a number`);
      return def;
    }
    return clamp(x, lo, hi);
  };
  const pick = <T extends string>(k: string, set: readonly string[], def: T): T => {
    const x = v[k];
    if (x === undefined) return def;
    if (typeof x === "string" && set.includes(x)) return x as T;
    problems.push(`captions.style.${k}: unknown option`);
    return def;
  };
  const em = isObj(v.emphasis) ? v.emphasis : {};
  const re = isObj(v.react) ? v.react : {};
  const style: TextStyle = {
    preset: pick("preset", TEXT_PRESETS, d.preset),
    font: typeof v.font === "string" && v.font ? v.font : d.font,
    weight: ([400, 700, 900] as const).find((w) => w === v.weight) ?? d.weight,
    size: num("size", 3, 12, d.size),
    color: typeof v.color === "string" && HEX.test(v.color) ? v.color : d.color,
    highlight: typeof v.highlight === "string" && (HEX.test(v.highlight) || v.highlight === "mood") ? v.highlight : d.highlight,
    position: pick("position", ["center", "lower", "upper"], d.position),
    showNext: typeof v.showNext === "boolean" ? v.showNext : d.showNext,
    uppercase: typeof v.uppercase === "boolean" ? v.uppercase : d.uppercase,
    outline: num("outline", 0, 0.15, d.outline),
    glow: num("glow", 0, 1, d.glow),
    emphasis: {
      scale: isNum(em.scale) ? clamp(em.scale, 1, 2) : d.emphasis.scale,
      glow: isNum(em.glow) ? clamp(em.glow, 0, 1) : d.emphasis.glow,
      color: em.color === "mood" ? "mood" : "highlight",
      sparks: typeof em.sparks === "boolean" ? em.sparks : d.emphasis.sparks,
    },
    react: {
      signal: typeof re.signal === "string" && VIZ_SIGNALS.has(re.signal) ? (re.signal as TextStyle["react"]["signal"]) : null,
      amount: isNum(re.amount) ? clamp(re.amount, 0, 2) : d.react.amount,
    },
    titleCard: null,
  };
  return done(style, problems);
}

export function serializeTextStyle(s: TextStyle): string {
  return JSON.stringify(s);
}

export function parseCaptionLines(raw: string): Parsed<TextLine[] | null> {
  const problems: string[] = [];
  const v = parseJSON(raw, "captions.lines", problems);
  if (v === undefined) return done(null, problems);
  if (!Array.isArray(v)) return done(null, [...problems, "captions.lines: not a list"]);
  const lines: TextLine[] = [];
  for (const [i, l] of v.entries()) {
    if (!isObj(l) || !isNum(l.startMs) || !isNum(l.endMs) || typeof l.text !== "string" || l.endMs < l.startMs) {
      problems.push(`captions.lines[${i}]: invalid line`);
      continue;
    }
    const words: TextWord[] = [];
    for (const w of Array.isArray(l.words) ? l.words : []) {
      if (!isObj(w) || !isNum(w.startMs) || !isNum(w.endMs) || typeof w.text !== "string") {
        problems.push(`captions.lines[${i}]: invalid word`);
        continue;
      }
      const word: TextWord = { startMs: w.startMs, endMs: Math.max(w.startMs, w.endMs), text: w.text };
      if (w.emphasis === true) word.emphasis = true;
      words.push(word);
    }
    words.sort((a, b) => a.startMs - b.startMs);
    lines.push({ startMs: l.startMs, endMs: l.endMs, text: l.text, words });
  }
  lines.sort((a, b) => a.startMs - b.startMs);
  return done(lines, problems);
}

export function serializeCaptionLines(lines: TextLine[] | null): string {
  return lines ? JSON.stringify(lines.map((l) => ({ startMs: l.startMs, endMs: l.endMs, text: l.text, words: l.words }))) : "";
}

// ---- Part B: text and visual clips ----

export const MAX_CLIP_TEXT = 500;
export const MAX_TEXT_CLIP_SIZE = 30;

export function defaultTextClip(text = "TEXT"): TextClip {
  return { text, style: { ...DEFAULT_TEXT_STYLE, preset: "pop", size: 16, weight: 900, uppercase: true, position: "center", emphasis: { ...DEFAULT_TEXT_STYLE.emphasis }, react: { ...DEFAULT_TEXT_STYLE.react } }, reveal: "all", wordMs: 250, lane: "beat", every: 1 };
}

export function parseTextClip(raw: string): Parsed<TextClip> {
  const problems: string[] = [];
  const v = parseJSON(raw, "text", problems);
  const d = defaultTextClip("");
  if (!isObj(v)) return done(d, v === undefined ? problems : [...problems, "text: not an object"]);
  const text = typeof v.text === "string" ? Array.from(v.text).slice(0, MAX_CLIP_TEXT).join("") : "";
  if (typeof v.text !== "string") problems.push("text.text: missing");
  const st = parseTextStyle(v.style === undefined ? "" : JSON.stringify(v.style));
  for (const m of st.problems) problems.push(m.replace(/^captions\.style/, "text.style"));
  // Text clips may be much bigger than captions (3–30 % of the short side).
  const rawStyle = isObj(v.style) ? v.style : {};
  if (isNum(rawStyle.size)) st.value.size = clamp(rawStyle.size, 3, MAX_TEXT_CLIP_SIZE);
  const reveal = v.reveal === "words" || v.reveal === "beats" ? v.reveal : "all";
  const wordMs = isNum(v.wordMs) ? clamp(v.wordMs, 40, 2000) : d.wordMs;
  const lane = typeof v.lane === "string" && (MARKER_LANES as readonly string[]).includes(v.lane) ? (v.lane as TextClip["lane"]) : "beat";
  const every = isNum(v.every) ? clamp(Math.round(v.every), 1, 16) : 1;
  return done({ text, style: st.value, reveal, wordMs, lane, every }, problems);
}

export function serializeTextClip(t: TextClip): string {
  return JSON.stringify(t);
}

export function defaultVisualClip(layer: LayerType = "lightrays"): VisualClip {
  return { layer, params: {}, palette: "neon" };
}

export function parseVisualClip(raw: string): Parsed<VisualClip> {
  const problems: string[] = [];
  const v = parseJSON(raw, "visual", problems);
  const d = defaultVisualClip();
  if (!isObj(v)) return done(d, v === undefined ? problems : [...problems, "visual: not an object"]);
  const layer = typeof v.layer === "string" && (LAYER_TYPES as readonly string[]).includes(v.layer) ? (v.layer as LayerType) : d.layer;
  if (layer !== v.layer) problems.push("visual.layer: unknown");
  const palette = typeof v.palette === "string" && (PALETTE_IDS as readonly string[]).includes(v.palette) ? (v.palette as PaletteId) : d.palette;
  const params: VisualClip["params"] = {};
  if (isObj(v.params)) {
    for (const [k, x] of Object.entries(v.params)) {
      if (typeof x === "string" || typeof x === "boolean") params[k] = x;
      else if (x !== undefined) params[k] = parseEditParam(x, 0, { min: -1e6, max: 1e6 }, `visual.params.${k}`, problems);
    }
  }
  return done({ layer, params, palette }, problems);
}

export function serializeVisualClip(v: VisualClip): string {
  return JSON.stringify(v);
}
