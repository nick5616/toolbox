/**
 * Pure editing of an EditParam (§6.3): keys at a clip time, mods, base.
 * The Inspector's editors and the preview overlays both write through these,
 * so a keyed param always gets a key at the playhead and a plain one its base.
 */
import { evalEditParam } from "@/viz/edit/params";
import { MAX_KEYS, MAX_MODS } from "@/viz/edit/schema";
import type { EditMod, EditParam, Key } from "@/viz/edit/types";

/** Two key times closer than this (ms) are "the same place". */
export const KEY_TOL_MS = 10;

const EMPTY_KEYS: readonly Key[] = [];
const EMPTY_MODS: readonly EditMod[] = [];

export function paramBase(p: EditParam): number {
  return typeof p === "number" ? p : p.base;
}
export function paramKeys(p: EditParam): readonly Key[] {
  return typeof p === "number" ? EMPTY_KEYS : (p.keys ?? EMPTY_KEYS);
}
export function paramMods(p: EditParam): readonly EditMod[] {
  return typeof p === "number" ? EMPTY_MODS : (p.mods ?? EMPTY_MODS);
}
export function isKeyed(p: EditParam): boolean {
  return paramKeys(p).length > 0;
}

/** A param from its parts: a bare number when there are no keys or mods. */
export function buildParam(base: number, keys: readonly Key[], mods: readonly EditMod[]): EditParam {
  if (!keys.length && !mods.length) return base;
  const out: { base: number; keys?: Key[]; mods?: EditMod[] } = { base };
  if (keys.length) out.keys = [...keys];
  if (mods.length) out.mods = [...mods];
  return out;
}

export function withBase(p: EditParam, base: number): EditParam {
  return buildParam(base, paramKeys(p), paramMods(p));
}
export function withKeys(p: EditParam, keys: readonly Key[]): EditParam {
  return buildParam(paramBase(p), keys, paramMods(p));
}
export function withMods(p: EditParam, mods: readonly EditMod[]): EditParam {
  return buildParam(paramBase(p), paramKeys(p), mods.slice(0, MAX_MODS));
}

/** Index of the key within tolerance of clip time t, or −1. */
export function keyIndexAt(keys: readonly Key[], t: number): number {
  let best = -1;
  let bestD = KEY_TOL_MS + 1;
  for (const [i, k] of keys.entries()) {
    const d = Math.abs(k.t - t);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

/** The value of a param at clip time `clipMs`, ignoring reactions. */
export function valueAt(p: EditParam, min: number, max: number, clipMs: number): number {
  const plain: EditParam = isKeyed(p) ? { base: paramBase(p), keys: [...paramKeys(p)] } : paramBase(p);
  return evalEditParam(plain, min, max, clipMs, 0, null);
}

/** Sets (or adds) the key at clip time t. Returns the same param when the list is full. */
export function setKeyAt(p: EditParam, t: number, v: number, ease?: Key["ease"]): EditParam {
  const keys = paramKeys(p).slice();
  const at = Math.max(0, Math.round(t));
  const i = keyIndexAt(keys, at);
  if (i >= 0) {
    const cur = keys[i] as Key;
    const next: Key = { ...cur, v, ease: ease ?? cur.ease };
    if (next.ease !== "bezier") delete next.bez;
    keys[i] = next;
  } else {
    if (keys.length >= MAX_KEYS) return p;
    keys.push({ t: at, v, ease: ease ?? "ease" });
    keys.sort((a, b) => a.t - b.t);
  }
  return withKeys(p, keys);
}

/** Removes the key at clip time t; the last key's value becomes the base. */
export function removeKeyAt(p: EditParam, t: number): EditParam {
  const keys = paramKeys(p).slice();
  const i = keyIndexAt(keys, t);
  if (i < 0) return p;
  const [gone] = keys.splice(i, 1);
  const base = keys.length === 0 && gone ? gone.v : paramBase(p);
  return buildParam(base, keys, paramMods(p));
}

/** The default custom curve: CSS "ease". */
export const DEFAULT_BEZ: [number, number, number, number] = [0.25, 0.1, 0.25, 1];

/** Sets the ease of the key at t. "bezier" keeps its curve (or starts from CSS "ease"); every other ease drops it. */
export function setEaseAt(p: EditParam, t: number, ease: Key["ease"]): EditParam {
  const keys = paramKeys(p).slice();
  const i = keyIndexAt(keys, t);
  if (i < 0) return p;
  const cur = keys[i] as Key;
  const next: Key = { ...cur, ease };
  if (ease === "bezier") next.bez = cur.bez ?? [...DEFAULT_BEZ];
  else delete next.bez;
  keys[i] = next;
  return withKeys(p, keys);
}

/** Makes the key at t a custom-curve key. x1, x2 clamp to 0..1 and y1, y2 to −1..2. */
export function setBezierAt(p: EditParam, t: number, bez: readonly [number, number, number, number]): EditParam {
  const keys = paramKeys(p).slice();
  const i = keyIndexAt(keys, t);
  if (i < 0) return p;
  const c = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v * 1000) / 1000));
  keys[i] = { ...(keys[i] as Key), ease: "bezier", bez: [c(bez[0], 0, 1), c(bez[1], -1, 2), c(bez[2], 0, 1), c(bez[3], -1, 2)] };
  return withKeys(p, keys);
}

/** The nearest key strictly before / after clip time t (outside the tolerance). */
export function neighbourKey(keys: readonly Key[], t: number, dir: -1 | 1): Key | null {
  if (dir < 0) {
    for (let i = keys.length - 1; i >= 0; i--) if ((keys[i] as Key).t < t - KEY_TOL_MS) return keys[i] as Key;
    return null;
  }
  for (const k of keys) if (k.t > t + KEY_TOL_MS) return k;
  return null;
}

/**
 * Writes a value from the UI or an overlay: a key at the playhead when the
 * param is keyed, else the base. Clamped to [min, max].
 */
export function writeValue(p: EditParam, v: number, min: number, max: number, clipMs: number): EditParam {
  const c = Math.max(min, Math.min(max, v));
  return isKeyed(p) ? setKeyAt(p, clipMs, c) : withBase(p, c);
}
