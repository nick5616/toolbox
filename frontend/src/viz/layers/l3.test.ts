import { describe, expect, it } from "vitest";
import { buildFixture } from "../fixture";
import { paletteById } from "../palette";
import { MOTIFS } from "../types";
import { COLOR_OPTIONS, channelId, dampedDistance, ihash, lerp, pickColor, rnd, smoothstep } from "./_particles";
import { NATURAL } from "./_motifs";
import { Sprite } from "./_sprites";
import { eventsIn, triggerList } from "./_triggers";
import { layerDef } from "./index";

const L3_TYPES = ["embers", "bursts", "fireflies", "ripples", "shockwave", "sweep", "lightrays", "frame", "motif"] as const;

describe("L3 layer registration", () => {
  it.each(L3_TYPES)("%s is registered with valid params", (type) => {
    const def = layerDef(type);
    expect(def).toBeDefined();
    expect(Object.keys(def?.params ?? {}).length).toBeGreaterThan(2);
    for (const [name, spec] of Object.entries(def?.params ?? {})) {
      if (spec.kind === "number") {
        expect(spec.default, `${type}.${name}`).toBeGreaterThanOrEqual(spec.min);
        expect(spec.default, `${type}.${name}`).toBeLessThanOrEqual(spec.max);
      } else if (spec.kind === "enum") {
        expect(spec.options, `${type}.${name}`).toContain(spec.default);
      }
    }
  });

  it("groups match the catalogue", () => {
    expect(layerDef("embers")?.group).toBe("particles");
    expect(layerDef("bursts")?.group).toBe("particles");
    expect(layerDef("fireflies")?.group).toBe("particles");
    expect(layerDef("ripples")?.group).toBe("accent");
    expect(layerDef("motif")?.group).toBe("motif");
  });

  it("no L3 layer is stateful (determinism without warm-up)", () => {
    for (const t of L3_TYPES) expect(layerDef(t)?.stateful).toBeFalsy();
  });

  it("motif offers the 12 motifs and natural colours for each", () => {
    const spec = layerDef("motif")?.params.motif;
    expect(spec?.kind === "enum" ? [...spec.options] : []).toEqual([...MOTIFS]);
    for (const m of MOTIFS) expect(NATURAL[m]).toHaveLength(2);
  });
});

describe("hashing", () => {
  it("is deterministic and within [0, 1)", () => {
    for (let i = 0; i < 200; i++) {
      const v = ihash(i, i * 3, 7);
      expect(v).toBe(ihash(i, i * 3, 7));
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("differs across seed, slot, stream and cycle", () => {
    const base = rnd(1, 5, 2, 0);
    expect(rnd(2, 5, 2, 0)).not.toBe(base);
    expect(rnd(1, 6, 2, 0)).not.toBe(base);
    expect(rnd(1, 5, 3, 0)).not.toBe(base);
    expect(rnd(1, 5, 2, 1)).not.toBe(base);
  });

  it("is roughly uniform", () => {
    let sum = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) sum += rnd(9, i, 0);
    expect(sum / n).toBeGreaterThan(0.47);
    expect(sum / n).toBeLessThan(0.53);
  });
});

describe("closed-form helpers", () => {
  it("damped distance matches v0 (1 - d^age) / ln-rate form and saturates", () => {
    expect(dampedDistance(100, 2, 0)).toBe(0);
    expect(dampedDistance(100, 2, 100)).toBeCloseTo(50, 3);
    expect(dampedDistance(100, 0, 3)).toBe(300);
    expect(dampedDistance(100, 2, 1)).toBeGreaterThan(dampedDistance(100, 2, 0.5));
    // Same value as numerically integrating the velocity.
    let x = 0;
    const dt = 0.0005;
    for (let t = 0; t < 1.2; t += dt) x += 100 * Math.exp(-2 * t) * dt;
    expect(dampedDistance(100, 2, 1.2)).toBeCloseTo(x, 1);
  });

  it("smoothstep and lerp", () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5);
    expect(lerp(2, 4, 0.25)).toBe(2.5);
  });

  it("picks palette colours for every mode", () => {
    const pal = paletteById("fire");
    for (const mode of COLOR_OPTIONS) {
      const c = pickColor(pal, mode, 1.5);
      expect(c).toHaveLength(3);
      expect(c.every((x) => Number.isFinite(x))).toBe(true);
    }
    expect(pickColor(pal, "c2")).toEqual(pal.colors[2]);
    const near = (a: number[], b: number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i] ?? 0, 4));
    near(pickColor(pal, "cycle", 0), pal.colors[0]);
    near(pickColor(pal, "cycle", 4), pal.colors[0]);
    near(pickColor(pal, "cycle", -4), pal.colors[0]);
  });

  it("sprite kinds are distinct", () => {
    const vals = Object.values(Sprite);
    expect(new Set(vals).size).toBe(vals.length);
  });
});

describe("trigger sources", () => {
  const a = buildFixture({ durationMs: 30_000 });

  it("lists are sorted and cached", () => {
    for (const src of ["kick", "snare", "beat", "downbeat", "word", "section", "drop", "drop+downbeat"]) {
      const list = triggerList(a, src);
      for (let i = 1; i < list.length; i++) expect((list[i] as [number, number])[0]).toBeGreaterThanOrEqual((list[i - 1] as [number, number])[0]);
      expect(triggerList(a, src)).toBe(list);
    }
    expect(triggerList(a, "downbeat")).toHaveLength(a.audio.downbeats.length);
    expect(triggerList(a, "section")).toHaveLength(a.audio.sections.length);
  });

  it("every keeps each n-th event", () => {
    const all = triggerList(a, "beat");
    const four = triggerList(a, "beat", 4);
    expect(four.length).toBe(Math.ceil(all.length / 4));
    expect(four[1]).toEqual(all[4]);
  });

  it("merged drop+downbeat has drops at full strength and downbeats weaker", () => {
    const list = triggerList(a, "drop+downbeat");
    expect(list.some((e) => e[1] === 255)).toBe(true);
    expect(list.some((e) => e[1] < 255)).toBe(true);
  });

  it("eventsIn is (t0, t1]", () => {
    const list = triggerList(a, "downbeat");
    const hit = eventsIn(list, 1999, 6000);
    expect(hit.map((e) => e[0])).toEqual([2000, 4000, 6000]);
    expect(eventsIn(list, 2000, 2000)).toEqual([]);
    expect(eventsIn(list, 1_000_000, 2_000_000)).toEqual([]);
  });

  it("channel fallbacks pick the first present channel", () => {
    expect(channelId(a, "bass.level", "mix.bass")).toBe("bass.level");
    const noStems = buildFixture({ durationMs: 5000, stems: false });
    expect(channelId(noStems, "bass.level", "mix.bass")).toBe("mix.bass");
  });
});
