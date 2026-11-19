/**
 * Motion grammar lint (Phase 21 SPEC C1, C3): every preset, in every scene, follows the grammar.
 *  - Breath: whole-frame things change on phrases and sections only.
 *  - Groove: rates barely follow the music (|amount| <= 0.15 of the range).
 *  - Accent: hits drive small local elements, never the camera, the palette or a whole-frame layer or post.
 */
import { describe, expect, it } from "vitest";
import "../layers";
import { layerDef } from "../layers/registry";
import "../post";
import { signalClass } from "../signals";
import type { Param, PostConfig, PostType, Show } from "../types";
import { validateShow } from "../validate";
import { PRESETS } from "./index";

/** Hits: single events that spike and fall. Drops, lifts and bars are song form, not accents. */
function isAccent(signal: string): boolean {
  return signal === "kick" || signal === "snare" || signal === "hats" || signal === "beat.pulse" || signal.endsWith(".onset") || signal === "word.pulse" || signal === "word.emphasis" || signal === "chord.change";
}

/** Parameters that are a rate (distance per second): their mods are small, because the picture integrates them. */
const RATE_PARAM = /^(speed|gridSpeed|spin|drift|rotation|rotate|phaseDrift|rise|wind|chase|travel|flow)$/;

/** Posts that move or warp the whole picture. */
const CAMERA_POSTS = new Set<PostType>(["shake", "zoompulse", "punch", "swing", "zoomblur", "dirblur", "blurpulse", "twirl", "bulge", "wave", "shockwave", "kaleido", "slice", "speedlines"]);

/** Trigger choices that fire on a hit (or more than once per bar). */
const HIT_TRIGGERS = new Set(["kick", "snare", "hats", "beat"]);

interface Mod1 {
  where: string;
  param: string;
  signal: string;
  amount: number;
  attackMs?: number;
  releaseMs?: number;
}

function modsOf(where: string, params: Record<string, Param | string | boolean>): Mod1[] {
  const out: Mod1[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "object" && v !== null) for (const m of v.mods) out.push({ where, param: k, signal: m.signal, amount: m.amount, attackMs: m.attackMs, releaseMs: m.releaseMs });
  }
  return out;
}

function lintShow(show: Show): string[] {
  const problems: string[] = [];
  const post = (where: string, list: PostConfig[]) => {
    for (const pc of list) {
      const w = `${where}/post ${pc.id}`;
      for (const m of modsOf(w, pc.params)) {
        if (isAccent(m.signal)) problems.push(`${m.where}.${m.param}: a whole-frame post follows the hit signal ${m.signal}`);
        if (RATE_PARAM.test(m.param) && Math.abs(m.amount) > 0.15) problems.push(`${m.where}.${m.param}: rate mod ${m.amount} is over 0.15`);
      }
      for (const key of ["trigger", "source"]) {
        const v = pc.params[key];
        if (typeof v === "string" && HIT_TRIGGERS.has(v)) problems.push(`${w}: triggered by ${v} (whole-frame posts fire at most once per bar, or on drops)`);
      }
      if (CAMERA_POSTS.has(pc.type)) {
        for (const m of modsOf(w, pc.params)) if (isAccent(m.signal)) problems.push(`${w}: camera post follows ${m.signal}`);
        if (pc.type === "shake" && pc.params.trigger !== "amount") problems.push(`${w}: shake without trigger "amount" follows the kick`);
      }
    }
  };
  for (const sc of show.scenes) {
    for (const l of sc.layers) {
      const def = layerDef(l.type);
      const w = `${sc.id}/${l.id}`;
      const all = [...modsOf(w, l.params), ...modsOf(w, { opacity: l.opacity })];
      for (const m of all) {
        if (RATE_PARAM.test(m.param) && Math.abs(m.amount) > 0.15) problems.push(`${m.where}.${m.param}: rate mod ${m.amount} is over 0.15`);
        if (def?.group === "background" && isAccent(m.signal)) problems.push(`${m.where}.${m.param}: a whole-frame layer follows the hit signal ${m.signal}`);
        if (isAccent(m.signal) && m.param === "opacity" && def?.group !== "particles" && def?.group !== "accent") problems.push(`${m.where}: opacity follows ${m.signal}`);
        // a groove (beat or level signal) uses smooth envelopes
        if (signalClass(m.signal as never) === "pulse" && m.signal === "beat.pulse" && Math.abs(m.amount) > 0.15 && !(def?.group === "particles")) {
          problems.push(`${m.where}.${m.param}: beat.pulse amount ${m.amount} is over 0.15`);
        }
      }
    }
    post(sc.id, sc.post);
  }
  post("global", show.post);
  return problems;
}

describe("motion grammar", () => {
  it.each(PRESETS.map((p) => [p.id, p] as const))("%s follows the grammar in every scene", (_id, p) => {
    expect(lintShow(p.show)).toEqual([]);
  });

  it.each(PRESETS.map((p) => [p.id, p] as const))("%s validates and keeps at least three controls", (_id, p) => {
    const r = validateShow(JSON.stringify(p.show));
    expect(r.ok ? "ok" : r.problem).toBe("ok");
    expect(p.show.controls.length).toBeGreaterThanOrEqual(3);
  });

  it("the lint catches a break of each rule", () => {
    const base = structuredClone(PRESETS[0]?.show as Show);
    const sc = base.scenes[0];
    if (!sc) throw new Error("no scene");
    sc.post.push({ id: "z", type: "shake", enabled: true, params: { amount: { base: 0.2, mods: [{ signal: "kick", amount: 0.3, shape: "exp" }] } } });
    expect(lintShow(base).some((p) => p.includes("shake"))).toBe(true);
    const base2 = structuredClone(PRESETS[0]?.show as Show);
    base2.post.push({ id: "z", type: "zoompulse", enabled: true, params: { amount: 0.2, trigger: "beat" } });
    expect(lintShow(base2).some((p) => p.includes("beat"))).toBe(true);
    const base3 = structuredClone(PRESETS[0]?.show as Show);
    const l = base3.scenes[0]?.layers.find((x) => layerDef(x.type)?.group === "background");
    if (!l) throw new Error("no background layer");
    l.params.speed = { base: 0.5, mods: [{ signal: "drums.level", amount: 0.6, shape: "linear" }] };
    expect(lintShow(base3).some((p) => p.includes("rate mod"))).toBe(true);
  });
});
