import { describe, expect, it } from "vitest";
import { defaultParams, MODEL_CUTOUT, MODEL_ESRGAN, MODEL_LAMA, MODEL_SAM, PERCEPTION_TOOLS } from "./tools";

const MODELS = new Set([MODEL_LAMA, MODEL_CUTOUT, MODEL_SAM, MODEL_ESRGAN]);

describe("PERCEPTION_TOOLS", () => {
  it("lists every perception tool of SPEC 1.4.2 except History brush", () => {
    expect(PERCEPTION_TOOLS.map((t) => t.id)).toEqual([
      "fill-eraser",
      "dissolve",
      "melt",
      "echo-fill",
      "edge-erode",
      "subject-stamp",
      "select-subject",
      "select-object",
      "enhance-brush",
      "extend-canvas",
      "upscale-canvas",
    ]);
  });
  it("is complete: label, description, icon, model origin, op, tooltips", () => {
    const ids = new Set<string>();
    for (const t of PERCEPTION_TOOLS) {
      expect(ids.has(t.id)).toBe(false);
      ids.add(t.id);
      expect(t.kind).toBe("perception");
      expect(t.label).not.toBe("");
      expect(t.description).not.toBe("");
      expect(t.icon).not.toBe("");
      expect(["exact", "seeded", "wild"]).toContain(t.predictability);
      expect(t.origin.kind).toBe("model");
      if (t.origin.kind === "model") expect(MODELS.has(t.origin.model)).toBe(true);
      const pids = new Set<string>();
      for (const p of t.params) {
        expect(pids.has(p.id)).toBe(false);
        pids.add(p.id);
        expect(p.tip).not.toBe("");
        if (p.type === "number") {
          expect(p.default).toBeGreaterThanOrEqual(p.min);
          expect(p.default).toBeLessThanOrEqual(p.max);
        }
        if (p.type === "choice") expect(p.choices.map((c) => c.value)).toContain(p.default);
      }
    }
  });
  it("marks Dissolve and Melt seeded and the rest exact", () => {
    const seeded = PERCEPTION_TOOLS.filter((t) => t.predictability === "seeded").map((t) => t.id);
    expect(seeded).toEqual(["dissolve", "melt"]);
  });
  it("matches the Dissolve settings of the spec", () => {
    const d = PERCEPTION_TOOLS.find((t) => t.id === "dissolve")!;
    const passes = d.params.find((p) => p.id === "passes");
    expect(passes).toMatchObject({ min: 1, max: 12 });
    expect(d.params.find((p) => p.id === "ghost")).toMatchObject({ min: 0, max: 1 });
    expect(d.params.find((p) => p.id === "drift")).toMatchObject({ min: 0, max: 1 });
    expect(d.params.find((p) => p.id === "quality")).toBeTruthy();
    expect(defaultParams(d)["passes"]).toBe(4);
  });
  it("uses the engine op for each tool", () => {
    const op = Object.fromEntries(PERCEPTION_TOOLS.map((t) => [t.id, t.op]));
    expect(op["select-object"]).toBe("segment");
    expect(op["subject-stamp"]).toBe("cutout");
    expect(op["upscale-canvas"]).toBe("enhance");
    expect(op["extend-canvas"]).toBe("fill");
  });
});
