/**
 * Phase 21 (SPEC section C2.1, C5): a layer's picture never teleports when a speed modulation steps from its
 * minimum up. Each layer renders into a recording fake GL twice at the same time: once with its rate parameters
 * at their minimum for the whole song, once with the rate stepping up one frame (1/60 s) earlier. The inputs the
 * layer hands the GPU (uniforms and vertex data) may only differ by what that one frame of motion explains.
 * Layers that multiply a rate by time (the old way) differ by the whole song's worth.
 */
import { describe, expect, it } from "vitest";
import type { Fullscreen } from "../gl/core";
import { buildFixture } from "../fixture";
import { Integrator, type RateEnv } from "../integral";
import { resolvePalette } from "../palette";
import { Signals } from "../signals";
import type { LayerType } from "../types";
import "./index";
import { layerDef, makeRng, type FrameInput, type LayerContext, type ParamValues } from "./registry";

const ANALYSIS = buildFixture({ durationMs: 40_000 });
const SIGNALS = new Signals(ANALYSIS);

interface Rec {
  uniforms: Map<string, number[]>;
  buffers: number[][];
}

function fakeGL(): { gl: WebGL2RenderingContext; rec: Rec } {
  const rec: Rec = { uniforms: new Map(), buffers: [] };
  const nums = (args: unknown[]): number[] => args.flatMap((a) => (typeof a === "number" ? [a] : ArrayBuffer.isView(a) ? Array.from(a as unknown as ArrayLike<number>) : []));
  const handler: ProxyHandler<object> = {
    get(_t, prop: string) {
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return 1;
      if (prop === "getUniformLocation") return (_p: unknown, name: string) => ({ name });
      if (prop.startsWith("uniform")) return (loc: { name: string } | null, ...args: unknown[]) => void rec.uniforms.set(loc?.name ?? "?", nums(args));
      if (prop === "bufferData") return (_t2: unknown, data: unknown) => void (ArrayBuffer.isView(data) && rec.buffers.push(nums([data])));
      if (prop === "bufferSubData") return (_t2: unknown, _o: unknown, data: unknown) => void (ArrayBuffer.isView(data) && rec.buffers.push(nums([data])));
      if (prop === "getExtension" || prop.startsWith("get") || prop.startsWith("is")) return () => true;
      if (prop.startsWith("create")) return () => ({});
      return () => undefined;
    },
  };
  return { gl: new Proxy({}, handler) as unknown as WebGL2RenderingContext, rec };
}

type RateStep = (tMs: number) => number;

interface Harness {
  render(tMs: number): Rec;
}

/** A layer instance and the frame inputs the engine would give it, with the named params following `rate`. */
function harness(type: LayerType, rateNames: string[], rate: RateStep, naive = false): Harness {
  const def = layerDef(type);
  if (!def) throw new Error(`no layer ${type}`);
  const { gl, rec } = fakeGL();
  const ctx: LayerContext = {
    gl,
    fullscreen: { draw() {}, dispose() {} } as unknown as Fullscreen,
    w: 1280,
    h: 720,
    seed: 1,
    rng: (key) => makeRng(1, key),
    textures: { cover: null, image: null, coverAspect: 1, imageAspect: 1 },
    previous: () => ({ tex: {}, fb: {}, w: 1280, h: 720 }) as never,
  };
  const inst = def.create(ctx);
  const integ = new Integrator();
  const valueOf = (name: string, tMs: number): number | undefined => {
    const spec = def.params[name];
    if (!spec || spec.kind !== "number") return undefined;
    return rateNames.includes(name) ? Math.max(spec.min, Math.min(spec.max, rate(tMs))) : spec.default;
  };
  const env: RateEnv = { analysis: ANALYSIS, signals: SIGNALS, intensity: 1, speed: 1, param: valueOf };
  return {
    render(tMs) {
      rec.uniforms.clear();
      rec.buffers.length = 0;
      const params: ParamValues = {};
      for (const [k, spec] of Object.entries(def.params)) params[k] = spec.kind === "number" ? (valueOf(k, tMs) as number) : spec.default;
      const f: FrameInput = {
        tMs,
        dtMs: 1000 / 60,
        motionSec: tMs / 1000,
        params,
        opacity: 1,
        palette: resolvePalette({ mode: "fixed", ids: ["cyber"] }, ANALYSIS, tMs),
        analysis: ANALYSIS,
        signals: SIGNALS,
        w: 1280,
        h: 720,
        seed: 1,
        quality: "full",
        mode: "opaque",
        intensity: 1,
        // `naive` is the old behaviour (the rate right now times the time so far), as a control for this test
        integral: (e) => (naive ? e.split("*").reduce((a, n) => a * (typeof params[n] === "number" ? (params[n] as number) : Number.isFinite(Number(n)) ? Number(n) : 0), 1) * (tMs / 1000) : integ.value("k", e, false, "s", env, tMs)),
        beatIntegral: (e) => (naive ? e.split("*").reduce((a, n) => a * (typeof params[n] === "number" ? (params[n] as number) : 0), 1) * (tMs / 1000) * 2 : integ.value("k", e, true, "s", env, tMs)),
      };
      inst.render(f);
      return { uniforms: new Map([...rec.uniforms].map(([k, v]) => [k, [...v]])), buffers: rec.buffers.map((b) => [...b]) };
    },
  };
}

function diff(a: Rec, b: Rec, buffers: boolean, ignore: string[] = []): { uniform: number; buffer: number; name: string } {
  let uniform = 0;
  let name = "";
  for (const [k, av] of a.uniforms) {
    if (ignore.includes(k)) continue;
    const bv = b.uniforms.get(k);
    if (!bv) continue;
    for (let i = 0; i < Math.min(av.length, bv.length); i++) {
      const d = Math.abs((av[i] as number) - (bv[i] as number));
      if (d > uniform) {
        uniform = d;
        name = k;
      }
    }
  }
  let buffer = 0;
  if (buffers) {
    for (let i = 0; i < Math.min(a.buffers.length, b.buffers.length); i++) {
      const x = a.buffers[i] as number[];
      const y = b.buffers[i] as number[];
      if (x.length !== y.length) return { uniform, buffer: Infinity, name: `buffer ${i} length` };
      for (let j = 0; j < x.length; j++) buffer = Math.max(buffer, Math.abs((x[j] as number) - (y[j] as number)));
    }
  }
  return { uniform, buffer, name };
}

interface Case {
  type: LayerType;
  rates: string[];
  /** Compare vertex data too (not for layers that cull stars by position). */
  buffers?: boolean;
  /** Uniforms that legitimately follow the current speed (a brightness or a streak length, not a position). */
  ignore?: string[];
  /** Vertex tolerance in pixels where the current speed spaces things (ribbon trails lag by speed x 55 ms). */
  bufferTol?: number;
}

const CASES: Case[] = [
  { type: "tunnel", rates: ["speed"] },
  { type: "starfield", rates: ["speed"], buffers: false, ignore: ["u_speed"] },
  { type: "synthgrid", rates: ["speed", "gridSpeed"] },
  { type: "kaleido", rates: ["speed", "spin"] },
  { type: "ribbons", rates: ["speed"], bufferTol: 60 },
  { type: "lissajous", rates: ["phaseDrift"] },
  { type: "vortex", rates: ["spin"] },
  { type: "ink", rates: ["speed"] },
  { type: "gradient", rates: ["speed"] },
  { type: "nebula", rates: ["speed", "drift"] },
  { type: "terrain", rates: ["speed"], buffers: false, ignore: ["u_nrows"] },
  { type: "geometry", rates: ["spin"] },
  { type: "radial", rates: ["spin"] },
  { type: "wavering", rates: ["speed"] },
  { type: "helix", rates: ["speed"] },
  { type: "aurora", rates: ["speed"] },
  { type: "image", rates: ["speed"] },
];

const T0 = 20_000;
const FRAME = 1000 / 60;
const LO = 0;
const HI = 1;

function stepDiff(c: Case, naive: boolean): { uniform: number; buffer: number; name: string } {
  // a speed mod that is at its minimum, and steps to 1 at T0 (one frame before the second render)
  const flat = harness(c.type, c.rates, () => LO, naive);
  const stepped = harness(c.type, c.rates, (t) => (t >= T0 ? HI : LO), naive);
  flat.render(T0);
  stepped.render(T0);
  return diff(flat.render(T0 + FRAME), stepped.render(T0 + FRAME), c.buffers !== false, c.ignore);
}

describe("layers don't teleport when a speed modulation steps", () => {
  for (const c of CASES) {
    it(`${c.type}: one frame of a stepped speed moves it by one frame's worth`, () => {
      const d = stepDiff(c, false);
      expect(d.uniform, `${c.type} uniform ${d.name}`).toBeLessThan(0.15);
      expect(d.buffer, `${c.type} vertex data`).toBeLessThan(c.bufferTol ?? 12);
    });
  }

  it("the check itself sees the old multiply-by-time behaviour", () => {
    const tunnel = stepDiff({ type: "tunnel", rates: ["speed"] }, true);
    expect(tunnel.uniform).toBeGreaterThan(1);
    const lissajous = stepDiff({ type: "lissajous", rates: ["phaseDrift"] }, true);
    expect(lissajous.buffer).toBeGreaterThan(50);
  });
});

describe("bursts keep the speed they were born with", () => {
  it("a speed mod doesn't drag particles that are already flying", () => {
    const def = layerDef("bursts");
    expect(def).toBeDefined();
    const render = (speedNow: number, birthSpeed: number): number[][] => {
      const { gl, rec } = fakeGL();
      const inst = (def as NonNullable<typeof def>).create({
        gl,
        fullscreen: { draw() {}, dispose() {} } as unknown as Fullscreen,
        w: 1280,
        h: 720,
        seed: 1,
        rng: (key) => makeRng(1, key),
        textures: { cover: null, image: null, coverAspect: 1, imageAspect: 1 },
        previous: () => null,
      });
      const params: ParamValues = {};
      for (const [k, spec] of Object.entries((def as NonNullable<typeof def>).params)) params[k] = spec.default;
      params.speed = speedNow;
      const tMs = ANALYSIS.events("kick")[8]?.[0] ?? 5000;
      inst.render({
        tMs: tMs + 300,
        dtMs: 1000 / 60,
        motionSec: tMs / 1000,
        params,
        opacity: 1,
        palette: resolvePalette({ mode: "fixed", ids: ["cyber"] }, ANALYSIS, tMs),
        analysis: ANALYSIS,
        signals: SIGNALS,
        w: 1280,
        h: 720,
        seed: 1,
        quality: "full",
        mode: "opaque",
        intensity: 1,
        integral: () => 0,
        beatIntegral: () => 0,
        paramAt: () => birthSpeed,
      });
      return rec.buffers.map((b) => [...b]);
    };
    const slow = render(0.2, 1);
    const fast = render(2, 1);
    expect(fast).toEqual(slow); // the current speed is irrelevant; only the speed at birth counts
    const other = render(1, 2);
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(slow));
  });
});
