import { describe, expect, it } from "vitest";
import { MAX_KEYS } from "@/viz/edit/schema";
import type { EditParam, EditPost, Key, Marker } from "@/viz/edit/types";
import { paramKeys } from "../inspector/paramOps";
import {
  accentMoments,
  applyUnuse,
  applyUse,
  beatLengthMs,
  buildSourceMap,
  clipMoments,
  footageMoments,
  formatMoment,
  hasFreeze,
  hasPulse,
  momentTip,
  removeFreeze,
  removePulse,
  sourceToClipMs,
  speedOfClip,
  usedEffect,
  writeFreeze,
  writePulse,
  type ClipFx,
  type UseCtx,
} from "./logic";

const F = 1000 / 30;
const clip = (over: Partial<{ startMs: number; endMs: number; inMs: number }> = {}) => ({ startMs: 1000, endMs: 9000, inMs: 2000, ...over });
const opts = (t: number, lenMs = 8000, decayMs = 250) => ({ t, frameMs: F, decayMs, lenMs });
const keysOf = (p: EditParam): Key[] => [...paramKeys(p)];
const ctx: UseCtx = { fps: 30, beatMs: 500, lenMs: 8000, strength: 1 };

describe("source to clip time", () => {
  it("maps linearly at speed 1", () => {
    const map = buildSourceMap(clip(), 30, speedOfClip(1));
    expect(sourceToClipMs(map, 2000)).toBeCloseTo(0, 3);
    expect(sourceToClipMs(map, 5200)).toBeCloseTo(3200, 0);
    expect(sourceToClipMs(map, 1999)).toBeNull();
    expect(sourceToClipMs(map, 10_001)).toBeNull();
  });

  it("follows a constant speed", () => {
    const map = buildSourceMap(clip(), 30, speedOfClip(2));
    expect(sourceToClipMs(map, 4000)).toBeCloseTo(1000, 0);
    expect(sourceToClipMs(map, 18_100)).toBeNull(); // source ends at 2000 + 16000
    expect(sourceToClipMs(map, 17_900)).not.toBeNull();
  });

  it("integrates speed keys, holds included", () => {
    // 1x for 2 s, then a 1 s hold at 0, then 1x.
    const speed: EditParam = {
      base: 1,
      keys: [
        { t: 0, v: 1, ease: "hold" },
        { t: 2000, v: 0, ease: "hold" },
        { t: 3000, v: 1, ease: "hold" },
      ],
    };
    const map = buildSourceMap(clip(), 30, speedOfClip(speed));
    expect(sourceToClipMs(map, 3000)).toBeCloseTo(1000, -1);
    // The frozen source time (4000) first appears at the start of the hold.
    expect(sourceToClipMs(map, 4000)).toBeCloseTo(2000, -2);
    // After the hold the source continues: 5000 is one second past 4000, at 4 s of clip time.
    expect(sourceToClipMs(map, 5000)).toBeCloseTo(4000, -2);
  });

  it("keeps only footage moments the clip plays, with kinds and timeline times", () => {
    const c = { ...clip(), id: "c", kind: "video" } as never;
    const out = footageMoments(c, 30, 1, [
      { ms: 500, strength: 0.9, kind: "cut" },
      { ms: 3200, strength: 0.5, kind: "motion" },
      { ms: 50_000, strength: 0.5, kind: "cut" },
    ]);
    expect(out.map((m) => [m.kind, m.clipMs, m.timelineMs])).toEqual([["motion", 1200, 2200]]);
  });
});

describe("accents and lists", () => {
  const mk = (lane: Marker["lane"], ms: number, strength = 0.5): Marker => ({ id: `${lane}:${ms}`, lane, ms, strength });
  it("takes accent markers inside the clip only", () => {
    const out = accentMoments(clip(), [mk("accent", 500), mk("accent", 1500, 0.8), mk("kick", 2000), mk("accent", 9000)]);
    expect(out.map((m) => [m.kind, m.clipMs])).toEqual([["accent", 500]]);
  });
  it("merges by time and keeps the strongest when over the limit", () => {
    const a = [{ id: "a", kind: "accent" as const, clipMs: 100, timelineMs: 100, strength: 0.1 }];
    const f = [{ id: "b", kind: "cut" as const, clipMs: 50, timelineMs: 50, strength: 0.9 }];
    expect(clipMoments(f, a).map((m) => m.id)).toEqual(["b", "a"]);
    expect(clipMoments(f, a, 1).map((m) => m.id)).toEqual(["b"]);
  });
  it("finds a beat length and words", () => {
    const beats = [0, 480, 960, 1440].map((ms) => mk("beat", ms));
    expect(beatLengthMs(beats, 700)).toBe(480);
    expect(beatLengthMs([], 0)).toBe(500);
    expect(formatMoment(3240)).toBe("0:03.2");
    expect(momentTip("motion", 3200, 0.8)).toBe("Motion burst at 0:03.2 (strong)");
    expect(momentTip("accent", 65_000, 0.1)).toBe("Song accent at 1:05.0 (subtle)");
  });
});

describe("pulse keys", () => {
  it("writes rest, peak, rest around the moment", () => {
    const p = writePulse(0, opts(3000), 0.8) as EditParam;
    expect(keysOf(p).map((k) => [k.t, k.v])).toEqual([
      [2967, 0],
      [3000, 0.8],
      [3250, 0],
    ]);
  });

  it("is idempotent and never duplicates keys", () => {
    const once = writePulse(0, opts(3000), 0.8) as EditParam;
    const twice = writePulse(once, opts(3000), 0.8) as EditParam;
    expect(twice).toEqual(once);
    // Updating the peak keeps three keys.
    const louder = writePulse(once, opts(3000), 1) as EditParam;
    expect(keysOf(louder)).toHaveLength(3);
    expect(keysOf(louder)[1]?.v).toBe(1);
  });

  it("shares neighbours between close pulses and removes only its own", () => {
    // Second pulse starts exactly where the first one decays.
    let p = writePulse(0, opts(3000), 0.8) as EditParam;
    p = writePulse(p, opts(3250 + 33), 0.6) as EditParam;
    const n = keysOf(p).length;
    expect(n).toBeLessThanOrEqual(6);
    const only2 = removePulse(p, opts(3000));
    expect(hasPulse(only2, 3000)).toBe(false);
    expect(hasPulse(only2, 3283)).toBe(true);
    const none = removePulse(only2, opts(3283));
    expect(none).toBe(0); // all keys gone: back to a plain number
  });

  it("leaves the user's own keys alone", () => {
    const user: EditParam = { base: 0, keys: [{ t: 1000, v: 0, ease: "ease" }, { t: 5000, v: 0, ease: "ease" }] };
    const withPulse = writePulse(user, opts(3000), 0.5) as EditParam;
    expect(keysOf(withPulse)).toHaveLength(5);
    expect(removePulse(withPulse, opts(3000))).toEqual(user);
  });

  it("keeps existing mods through write and remove", () => {
    const base: EditParam = { base: 0, mods: [{ signal: "marker.kick", amount: 1, shape: "exp", attackMs: 5, releaseMs: 160 }] };
    const p = writePulse(base, opts(1000), 0.7) as Exclude<EditParam, number>;
    expect(p.mods).toHaveLength(1);
    expect(removePulse(p, opts(1000))).toEqual(base);
  });

  it("clamps to the clip", () => {
    const atStart = keysOf(writePulse(0, opts(0), 1) as EditParam);
    expect(atStart.map((k) => k.t)).toEqual([0, 250]);
    const nearEnd = keysOf(writePulse(0, opts(7900), 1) as EditParam);
    expect(nearEnd.map((k) => k.t)).toEqual([7867, 7900, 8000]);
    const atEnd = keysOf(writePulse(0, opts(9000), 1) as EditParam);
    expect(atEnd.every((k) => k.t <= 8000)).toBe(true);
  });

  it("never exceeds 64 keys", () => {
    let p: EditParam = 0;
    let wrote = 0;
    for (let i = 0; i < 40; i++) {
      const next = writePulse(p, opts(300 + i * 1000, 100_000), 1);
      if (!next) break;
      p = next;
      wrote++;
    }
    expect(keysOf(p).length).toBeLessThanOrEqual(MAX_KEYS);
    expect(wrote).toBeLessThan(40);
    // The failed write left the param untouched.
    expect(writePulse(p, opts(77_777, 100_000), 1)).toBeNull();
  });
});

describe("freeze", () => {
  it("holds speed 0 for a beat and resumes the previous speed", () => {
    const sp = writeFreeze(1, { t: 2000, frameMs: F, beatMs: 500, lenMs: 8000 }) as EditParam;
    expect(keysOf(sp).map((k) => [k.t, k.v, k.ease])).toEqual([
      [2000, 1, "hold"],
      [2033, 0, "hold"],
      [2500, 1, "linear"],
    ]);
    expect(hasFreeze(sp, 2000, F)).toBe(true);
    const map = buildSourceMap(clip({ inMs: 0 }), 30, speedOfClip(sp));
    // Source time 2000 is reached at 2000 ms and nothing between 2033 and 2500 advances.
    expect(sourceToClipMs(map, 2100)).toBeCloseTo(2567, -2);
  });

  it("removes only its keys", () => {
    const user: EditParam = { base: 1, keys: [{ t: 0, v: 1, ease: "linear" }, { t: 6000, v: 2, ease: "linear" }] };
    const sp = writeFreeze(user, { t: 2000, frameMs: F, beatMs: 500, lenMs: 8000 }) as EditParam;
    expect(keysOf(sp)).toHaveLength(5);
    expect(removeFreeze(sp, 2000, F)).toEqual(user);
  });

  it("needs room before the clip's end and respects the key limit", () => {
    expect(writeFreeze(1, { t: 7990, frameMs: F, beatMs: 500, lenMs: 8000 })).toBeNull();
    const full: EditParam = { base: 1, keys: Array.from({ length: MAX_KEYS }, (_, i) => ({ t: 100 + i * 100, v: 1, ease: "linear" as const })) };
    expect(writeFreeze(full, { t: 50, frameMs: F, beatMs: 500, lenMs: 8000 })).toBeNull();
  });
});

describe("using moments on a clip", () => {
  const empty: ClipFx = { effects: [], speed: 1 };

  it("adds the effect when missing, driven by its amount, and removes keys on Use off", () => {
    const on = applyUse(empty, 3000, 0.8, "shake", ctx) as ClipFx;
    expect(on.effects).toHaveLength(1);
    const post = on.effects[0] as EditPost;
    expect(post.type).toBe("shake");
    expect(post.params.trigger).toBe("amount");
    expect(keysOf(post.params.amount as EditParam)).toHaveLength(3);
    expect(usedEffect(on, 3000, 30)).toBe("shake");
    const off = applyUnuse(on, 3000, ctx);
    expect(usedEffect(off, 3000, 30)).toBeNull();
    expect((off.effects[0]?.params.amount as EditParam)).toBe(0);
  });

  it("reuses an existing effect of the type", () => {
    const first = applyUse(empty, 1000, 0.5, "flash", ctx) as ClipFx;
    const second = applyUse(first, 4000, 0.5, "flash", ctx) as ClipFx;
    expect(second.effects).toHaveLength(1);
    expect(keysOf(second.effects[0]?.params.amount as EditParam)).toHaveLength(6);
  });

  it("changing the effect of a used moment moves its keys", () => {
    const a = applyUse(empty, 3000, 0.8, "punch", ctx) as ClipFx;
    const b = applyUse(a, 3000, 0.8, "glitch", ctx) as ClipFx;
    expect(usedEffect(b, 3000, 30)).toBe("glitch");
    expect(b.effects.find((e) => e.type === "punch")?.params.amount).toBe(0);
  });

  it("scales the peak by strength", () => {
    const hard = applyUse(empty, 3000, 1, "flash", { ...ctx, strength: 1 }) as ClipFx;
    const soft = applyUse(empty, 3000, 1, "flash", { ...ctx, strength: 0.3 }) as ClipFx;
    const peak = (fx: ClipFx) => keysOf(fx.effects[0]?.params.amount as EditParam).find((k) => k.t === 3000)?.v ?? 0;
    expect(peak(hard)).toBeGreaterThan(peak(soft));
    expect(peak(hard)).toBeLessThanOrEqual(1);
  });

  it("Freeze uses speed keys", () => {
    const on = applyUse(empty, 2000, 0.5, "freeze", ctx) as ClipFx;
    expect(on.effects).toHaveLength(0);
    expect(usedEffect(on, 2000, 30)).toBe("freeze");
    expect(applyUnuse(on, 2000, ctx).speed).toBe(1);
  });
});
