import { describe, expect, it } from "vitest";
import "../layers";
import type { ParamSpec } from "../layers/registry";
import { layerDef, layerDefs } from "../layers/registry";
import { generatorFor } from "./generated";
import type { ParamContext } from "./params";
import type { EditParam } from "./types";
import { mergeVisualParams, resolveVisualParams } from "./visualClip";

const specs: Record<string, ParamSpec> = {
  n: { kind: "number", label: "N", min: 0, max: 10, default: 4 },
  m: { kind: "number", label: "M", min: 0, max: 1, default: 0.5 },
  c: { kind: "color", label: "C", default: "accent" },
  e: { kind: "enum", label: "E", options: ["a", "b"], default: "a" },
  b: { kind: "bool", label: "B", default: true },
};

// A marker signal that is always at full strength.
const fakeCtx = { signals: { analysis: { sectionAt: () => null } }, markers: { value: () => 1 } } as unknown as ParamContext;

describe("mergeVisualParams", () => {
  it("fills defaults", () => {
    expect(mergeVisualParams(specs, {})).toEqual({ n: 4, m: 0.5, c: "accent", e: "a", b: true });
  });

  it("applies overrides and drops wrong types, unknown enum values and unknown names", () => {
    const raw = { n: 7, m: "x", c: "#ff0000", e: "zzz", b: false, extra: 3 } as Record<string, EditParam | string | boolean>;
    expect(mergeVisualParams(specs, raw)).toEqual({ n: 7, m: 0.5, c: "#ff0000", e: "a", b: false });
  });

  it("keeps EditParams", () => {
    const p: EditParam = { base: 2, mods: [{ signal: "marker.kick", amount: 0.5, shape: "linear" }] };
    expect(mergeVisualParams(specs, { n: p }).n).toBe(p);
  });
});

describe("resolveVisualParams", () => {
  it("evaluates numbers with clamping and passes the rest through", () => {
    expect(resolveVisualParams(specs, { n: 99, e: "b" }, 0, 0, null)).toEqual({ n: 10, m: 0.5, c: "accent", e: "b", b: true });
  });

  it("evaluates keys at clip time", () => {
    const p: EditParam = { base: 0, keys: [{ t: 0, v: 0, ease: "linear" }, { t: 1000, v: 10, ease: "linear" }] };
    expect(resolveVisualParams(specs, { n: p }, 500, 123, null).n).toBeCloseTo(5);
  });

  it("evaluates a marker mod as a fraction of the range", () => {
    const p: EditParam = { base: 2, mods: [{ signal: "marker.kick", amount: 0.3, shape: "linear" }] };
    expect(resolveVisualParams(specs, { n: p }, 0, 0, fakeCtx).n).toBeCloseTo(2 + 0.3 * 10);
    expect(resolveVisualParams(specs, { n: p }, 0, 0, null).n).toBe(2);
  });
});

describe("registration", () => {
  it("registers the visual generator", () => {
    expect(generatorFor("visual")).toBeTypeOf("function");
  });

  it("has layers to offer, and every param of every layer has a valid default", () => {
    const defs = layerDefs().filter((d) => !d.stateful);
    expect(defs.length).toBeGreaterThan(10);
    expect(layerDef("lightrays")?.stateful).toBeFalsy();
    for (const d of defs) {
      const merged = resolveVisualParams(d.params, {}, 0, 0, null);
      for (const [name, spec] of Object.entries(d.params)) {
        expect(merged[name], `${d.type}.${name}`).toBeDefined();
        if (spec.kind === "enum") expect(spec.options).toContain(merged[name]);
      }
    }
  });
});
