import { describe, expect, it } from "vitest";
import { CLIP_POST_TYPES, MAX_EFFECTS, parseEffects, serializeEffects } from "@/viz/edit/schema";
import type { EditMod, EditParam, EditPost } from "@/viz/edit/types";
import "@/viz/post";
import { postDef } from "@/viz/post/registry";
import { FX_STACKS, fxStack } from "./FxStacks";

const modsOf = (p: EditParam | string | boolean | undefined): EditMod[] => (typeof p === "object" ? (p.mods ?? []) : []);
const stack = (id: string): EditPost[] => (fxStack(id) as NonNullable<ReturnType<typeof fxStack>>).make();

describe("FX stacks", () => {
  it("ships the twelve stacks of §23.8 and Phase 21's Green screen", () => {
    expect(FX_STACKS.map((s) => s.id)).toEqual([
      "anime-hit", "drop-impact", "velocity-punch", "glow-pump", "strobe-build", "manga",
      "vhs-intro", "speed-lines-drop", "swing-downbeats", "slice-hats", "duotone-pulse", "light-leak",
      "green-screen",
    ]);
  });

  it("Green screen is a chroma key with choke 0.1 and spill 0.6", () => {
    const [key, ...rest] = stack("green-screen");
    expect(rest).toEqual([]);
    expect(key?.type).toBe("chromakey");
    expect(key?.params).toMatchObject({ color: "#00b140", spill: 0.6, choke: 0.1, view: "composite", amount: 1 });
  });

  it.each(FX_STACKS.map((s) => [s.id, s] as const))("%s is valid and uses clip effects only", (_id, s) => {
    const posts = s.make();
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.length).toBeLessThanOrEqual(MAX_EFFECTS);
    for (const p of posts) {
      expect(CLIP_POST_TYPES).toContain(p.type);
      expect(p.enabled).toBe(true);
      // param names exist when the pass is registered in this build
      const def = postDef(p.type);
      if (def) for (const k of Object.keys(p.params)) expect(def.params, `${p.type}.${k}`).toHaveProperty(k);
    }
    const parsed = parseEffects(serializeEffects(posts));
    if (posts.every((p) => postDef(p.type))) expect(parsed.problems).toEqual([]);
    expect(parsed.value.map((p) => p.type)).toEqual(posts.map((p) => p.type));
  });

  it("makes fresh unique IDs on every call", () => {
    const a = FX_STACKS.flatMap((s) => s.make());
    const b = FX_STACKS.flatMap((s) => s.make());
    expect(new Set([...a, ...b].map((p) => p.id)).size).toBe(a.length * 2);
  });

  it("fills in marker reactions", () => {
    const hit = stack("anime-hit");
    expect(hit.map((p) => p.type)).toEqual(["shake", "punch", "chromatic", "flash"]);
    for (const p of hit) expect(modsOf(p.params.amount)[0]).toMatchObject({ signal: "marker.kick", shape: "exp" });
    expect(hit[0]?.params.trigger).toBe("amount");
    expect(hit[2]?.params.source).toBe("amount");
    expect(stack("drop-impact").map((p) => modsOf(p.params.amount)[0]?.signal)).toEqual(["marker.drop", "marker.drop", "marker.drop"]);
    expect(modsOf(stack("slice-hats")[0]?.params.amount)[0]?.signal).toBe("marker.hats");
    expect(modsOf(stack("swing-downbeats")[0]?.params.rotY)[0]?.signal).toBe("marker.downbeat");
    const strobe = modsOf(stack("strobe-build")[0]?.params.amount)[0];
    expect(strobe).toMatchObject({ signal: "marker.beat", sections: ["break", "bridge"] });
  });

  it("keeps mod amounts within -2..2 and times positive", () => {
    for (const p of FX_STACKS.flatMap((s) => s.make()))
      for (const v of Object.values(p.params))
        for (const m of modsOf(v)) {
          expect(Math.abs(m.amount)).toBeLessThanOrEqual(2);
          expect(m.attackMs ?? 0).toBeGreaterThan(0);
          expect(m.releaseMs ?? 0).toBeGreaterThan(0);
        }
  });
});
