import { describe, expect, it } from "vitest";
import type { ParamSpec } from "@/viz/layers/registry";
import type { EditPost } from "@/viz/edit/types";
import { mainParam, readHit, writeHit } from "./hits";

const specs: Record<string, ParamSpec> = {
  trigger: { kind: "enum", label: "Trigger", options: ["beat", "amount"], default: "beat" },
  amount: { kind: "number", label: "Amount", min: 0, max: 2, default: 0 },
  speed: { kind: "number", label: "Speed", min: 0, max: 1, default: 0.5 },
};
const post = (params: EditPost["params"]): EditPost => ({ id: "a", type: "shake", enabled: true, params });

describe("hits", () => {
  it("drives amount, else the first number", () => {
    expect(mainParam(specs)?.name).toBe("amount");
    expect(mainParam({ x: { kind: "bool", label: "X", default: false }, k: { kind: "number", label: "K", min: 0, max: 1, default: 0 } })?.name).toBe("k");
  });

  it("reads off / on / lane states", () => {
    expect(readHit(post({}), specs)?.mode).toBe("off");
    expect(readHit(post({ amount: 1 }), specs)).toMatchObject({ mode: "on", strength: 0.5 });
    expect(readHit(post({ amount: { base: 0, mods: [{ signal: "marker.snare", amount: 0.6, shape: "exp", attackMs: 5, releaseMs: 90, every: 2 }] } }), specs)).toMatchObject({ mode: "snare", strength: 0.6, every: 2, decayMs: 90 });
  });

  it("writes a marker pulse and switches trigger params to the amount", () => {
    const out = writeHit(post({ trigger: "beat" }), specs, { mode: "kick", strength: 0.7, every: 4, decayMs: 180 });
    expect(out.params.trigger).toBe("amount");
    expect(out.params.amount).toEqual({ base: 0, mods: [{ signal: "marker.kick", amount: 0.7, shape: "exp", attackMs: 5, releaseMs: 180, every: 4 }] });
    expect(writeHit(out, specs, { mode: "on", strength: 0.5, every: 1, decayMs: 180 }).params.amount).toBe(1);
    expect(writeHit(out, specs, { mode: "off", strength: 0.5, every: 1, decayMs: 180 }).params.amount).toBe(0);
    expect(readHit(out, specs)).toMatchObject({ mode: "kick", every: 4 });
  });
});
