/**
 * The keyframe strip under a selected clip (Phase 21 SPEC §B2): one diamond
 * per keyed time, merged across every keyed param of the clip (transform and
 * crop, effects, masks, speed, gain). Pure: each function reads a clip and
 * returns the fields that change (or null).
 */
import type { EditClip } from "@/lib/api";
import { parseEffects, parseMasks, parseSpeed, parseTransform, serializeEffects, serializeMasks, serializeSpeed, serializeTransform } from "@/viz/edit/schema";
import type { EditParam, Key } from "@/viz/edit/types";
import { parseGain, serializeGain } from "./gain";

/** Maps one param (with its id: "transform.x", "transform.crop.l", "effect:<id>.<param>", "mask:<id>.x", "speed", "gain"). */
type ParamFn = (p: EditParam, id: string) => EditParam;

const keyed = (p: EditParam): p is { base: number; keys: Key[] } => typeof p === "object" && !!p.keys?.length;

/** Applies `fn` to every param with keys; returns the fields whose JSON changed. */
function mapParams(c: EditClip, fn: ParamFn): Partial<EditClip> {
  const patch: Partial<EditClip> = {};
  const wrap: ParamFn = (p, id) => (keyed(p) ? fn(p, id) : p);

  if (c.transform.includes('"keys"')) {
    const t = parseTransform(c.transform).value;
    const next = {
      ...t,
      x: wrap(t.x, "transform.x"),
      y: wrap(t.y, "transform.y"),
      scale: wrap(t.scale, "transform.scale"),
      rotation: wrap(t.rotation, "transform.rotation"),
      opacity: wrap(t.opacity, "transform.opacity"),
      ...(t.crop ? { crop: { l: wrap(t.crop.l, "transform.crop.l"), r: wrap(t.crop.r, "transform.crop.r"), t: wrap(t.crop.t, "transform.crop.t"), b: wrap(t.crop.b, "transform.crop.b") } } : {}),
    };
    const s = serializeTransform(next);
    if (s !== serializeTransform(t)) patch.transform = s;
  }
  if (c.speed.includes('"keys"')) {
    const sp = parseSpeed(c.speed).value;
    const s = serializeSpeed(wrap(sp, "speed"));
    if (s !== serializeSpeed(sp)) patch.speed = s;
  }
  if (c.gain?.includes('"keys"')) {
    const g = parseGain(c.gain);
    const s = serializeGain(wrap(g, "gain"));
    if (s !== serializeGain(g)) patch.gain = s;
  }
  if (c.effects.includes('"keys"')) {
    const list = parseEffects(c.effects).value;
    const next = list.map((fx) => {
      const params: typeof fx.params = {};
      for (const [k, v] of Object.entries(fx.params)) params[k] = typeof v === "object" ? wrap(v, `effect:${fx.id}.${k}`) : v;
      return { ...fx, params };
    });
    const s = serializeEffects(next);
    if (s !== serializeEffects(list)) patch.effects = s;
  }
  if (c.masks.includes('"keys"')) {
    const list = parseMasks(c.masks).value;
    const next = list.map((m) => ({
      ...m,
      x: wrap(m.x, `mask:${m.id}.x`),
      y: wrap(m.y, `mask:${m.id}.y`),
      w: wrap(m.w, `mask:${m.id}.w`),
      h: wrap(m.h, `mask:${m.id}.h`),
      rotation: wrap(m.rotation, `mask:${m.id}.rotation`),
    }));
    const s = serializeMasks(next);
    if (s !== serializeMasks(list)) patch.masks = s;
  }
  return patch;
}

/** Every keyed time of the clip, clip-relative ms, ascending and merged across params. */
export function clipKeyTimes(c: EditClip): number[] {
  const times = new Set<number>();
  mapParams(c, (p) => {
    for (const k of (p as { keys: Key[] }).keys) times.add(k.t);
    return p;
  });
  return [...times].sort((a, b) => a - b);
}

/** The params (ids as in `mapParams`) that have a key at clip-relative t. */
export function keyParamsAt(c: EditClip, tMs: number): string[] {
  const ids: string[] = [];
  mapParams(c, (p, id) => {
    if ((p as { keys: Key[] }).keys.some((k) => Math.abs(k.t - tMs) < 0.5)) ids.push(id);
    return p;
  });
  return ids;
}

/** The key times in timeline ms (what the strip draws against the ruler). */
export const keyTimesOnTimeline = (c: EditClip): number[] => clipKeyTimes(c).map((t) => c.startMs + t);

/** The strip is worth drawing only when the clip has any key. */
export const hasKeys = (c: EditClip): boolean => clipKeyTimes(c).length > 0;

const dedupe = (keys: Key[]): Key[] => {
  const out: Key[] = [];
  for (const k of keys.slice().sort((a, b) => a.t - b.t)) {
    if (out.length && (out[out.length - 1] as Key).t === k.t) out[out.length - 1] = k;
    else out.push(k);
  }
  return out;
};

/**
 * Moves every key at `fromT` to `toT` (clip-relative ms, clamped to the clip's
 * length). A key already at `toT` in the same param is replaced.
 */
export function moveKeysAt(c: EditClip, fromT: number, toT: number): Partial<EditClip> | null {
  const len = c.endMs - c.startMs;
  const to = Math.round(Math.max(0, Math.min(len, toT)));
  if (Math.abs(to - fromT) < 0.5) return null;
  const patch = mapParams(c, (p) => {
    const keys = (p as { base: number; keys: Key[] }).keys;
    if (!keys.some((k) => Math.abs(k.t - fromT) < 0.5)) return p;
    // The moved key wins over one that was already at the destination.
    const kept = keys.filter((k) => Math.abs(k.t - fromT) >= 0.5 && k.t !== to);
    const moved = keys.filter((k) => Math.abs(k.t - fromT) < 0.5).map((k) => ({ ...k, t: to }));
    return { ...(p as object), keys: dedupe([...kept, ...moved]) } as EditParam;
  });
  return Object.keys(patch).length ? patch : null;
}

/** Deletes every key at t; a param left with no keys goes back to its base value. */
export function deleteKeysAt(c: EditClip, tMs: number): Partial<EditClip> | null {
  const patch = mapParams(c, (p) => {
    const q = p as { base: number; keys: Key[]; mods?: unknown[] };
    const rest = q.keys.filter((k) => Math.abs(k.t - tMs) >= 0.5);
    if (rest.length === q.keys.length) return p;
    if (rest.length) return { ...q, keys: rest } as EditParam;
    const { keys: _k, ...noKeys } = q;
    void _k;
    return (noKeys.mods?.length ? noKeys : noKeys.base) as EditParam;
  });
  return Object.keys(patch).length ? patch : null;
}

/** The previous or next key time of the clip in timeline ms (strictly before/after t), or null. */
export function neighbourKey(c: EditClip, tMs: number, dir: -1 | 1): number | null {
  const times = keyTimesOnTimeline(c);
  if (dir > 0) return times.find((m) => m > tMs + 0.5) ?? null;
  for (let i = times.length - 1; i >= 0; i--) if ((times[i] as number) < tMs - 0.5) return times[i] as number;
  return null;
}
