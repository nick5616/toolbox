import { describe, expect, it } from "vitest";
import { CLIP_POST_TYPES, parseEffects, parseLook, serializeEffects, serializeLook } from "@/viz/edit/schema";
import type { EditMod, EditParam, EditPost } from "@/viz/edit/types";
import { applyLook, currentLook, EFFECT_TEMPLATES, LOOK_GRADE_ID, LOOK_IDS, LOOKS } from "./templates";

const modsOf = (p: EditParam | string | boolean | undefined): EditMod[] => (typeof p === "object" ? (p.mods ?? []) : []);

describe("effect templates", () => {
  it("make fresh IDs every time and offer only clip effects", () => {
    const a = EFFECT_TEMPLATES.map((t) => t.make());
    const b = EFFECT_TEMPLATES.map((t) => t.make());
    expect(new Set([...a, ...b].map((p) => p.id)).size).toBe(a.length * 2);
    for (const p of a) {
      expect(CLIP_POST_TYPES).toContain(p.type);
      expect(p.enabled).toBe(true);
    }
  });

  it("match §9.1", () => {
    const by = (id: string): EditPost => (EFFECT_TEMPLATES.find((t) => t.id === id) as (typeof EFFECT_TEMPLATES)[number]).make();
    const punch = by("zoom-punch-kicks");
    expect(punch.type).toBe("punch");
    expect(modsOf(punch.params.amount)).toEqual([{ signal: "marker.kick", amount: 1, shape: "exp", attackMs: 5, releaseMs: 160 }]);
    expect(modsOf(by("flash-drops").params.amount)[0]).toMatchObject({ signal: "marker.drop", amount: 1, releaseMs: 250 });
    const shake = by("shake-snares");
    expect(shake.params.trigger).toBe("amount");
    expect(modsOf(shake.params.amount)[0]?.signal).toBe("marker.snare");
    const rgb = by("rgb-split-hats");
    expect(rgb.type).toBe("chromatic");
    expect(rgb.params.source).toBe("amount");
    expect(modsOf(rgb.params.amount)[0]?.signal).toBe("marker.hats");
    const glitch = by("glitch-drop");
    expect(glitch.params.trigger).toBe("amount");
    expect(modsOf(glitch.params.amount)[0]?.signal).toBe("marker.drop");
    expect(modsOf(by("blur-pulse-beats").params.amount)[0]?.signal).toBe("marker.beat");
    expect(modsOf(by("exposure-downbeats").params.amount)[0]?.signal).toBe("marker.downbeat");
    const inv = modsOf(by("invert-stops").params.amount)[0];
    expect(inv).toMatchObject({ signal: "marker.stop", shape: "gate" });
  });

  it("survive a save and load", () => {
    const posts = EFFECT_TEMPLATES.map((t) => t.make());
    const back = parseEffects(serializeEffects(posts));
    expect(back.value).toHaveLength(posts.length);
    // The passes ES5 adds aren't registered until it lands; whatever is registered round-trips its reactions.
    for (const [i, p] of posts.entries()) expect(modsOf(back.value[i]?.params.amount)).toEqual(modsOf(p.params.amount));
  });
});

describe("looks", () => {
  it("has the seven §9.1 presets", () => {
    expect(LOOKS.map((l) => l.id)).toEqual([...LOOK_IDS]);
    const g = (id: string) => LOOKS.find((l) => l.id === id)?.grade;
    expect(g("none")).toBeNull();
    expect(g("vivid")).toMatchObject({ saturation: 1.35, gain: 1.05 });
    expect(g("warm")?.warmth).toBe(0.5);
    expect(g("cool")?.warmth).toBe(-0.5);
    expect(g("mono")?.saturation).toBe(0);
    expect(g("fade")).toMatchObject({ lift: 0.06, gain: 0.9, saturation: 0.8 });
    expect(g("noir")).toMatchObject({ saturation: 0, gamma: 1.2, gain: 1.15 });
  });

  it("apply, replace and remove the preset grade, keeping other effects", () => {
    const bloom: EditPost = { id: "b1", type: "bloom", enabled: true, params: {} };
    let stack = applyLook([bloom], "warm");
    expect(stack.map((p) => p.id)).toEqual([LOOK_GRADE_ID, "b1"]);
    expect(currentLook(stack)).toBe("warm");
    stack = applyLook(stack, "noir");
    expect(stack).toHaveLength(2);
    expect(currentLook(stack)).toBe("noir");
    stack = applyLook(stack, "none");
    expect(stack).toEqual([bloom]);
    expect(currentLook(stack)).toBe("none");
  });

  it("reports custom after the grade is edited, and the stack parses as a Look", () => {
    const stack = applyLook([], "vivid");
    const edited = stack.map((p) => ({ ...p, params: { ...p.params, saturation: 1.5 } }));
    expect(currentLook(edited)).toBe("custom");
    const back = parseLook(serializeLook(stack));
    expect(back.ok).toBe(true);
    expect(currentLook(back.value)).toBe("vivid");
  });
});
