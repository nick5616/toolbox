import { describe, expect, it } from "vitest";
import { GO_STEP_TYPES } from "../catalogFixture";
import { deriveParams, humanize, resolvePointer } from "../params";
import { registeredStepTypes, stepUI } from "./index";

// Phase 16 §3.5: every step type's parameter metadata, checked against the
// catalogue fixture's defaults (the Go StepDefaults).

describe("step parameter metadata", () => {
  it("every catalogue type has an editor", () => {
    for (const t of GO_STEP_TYPES) expect(registeredStepTypes()).toContain(t.id);
  });

  describe.each(GO_STEP_TYPES.map((t) => [t.id, t.defaultsJson] as const))("%s", (type, defaultsJson) => {
    const overrides = stepUI(type)?.params ?? {};
    const defaults: unknown = JSON.parse(defaultsJson);
    const params = deriveParams(defaultsJson, overrides);

    it("every override pointer resolves in the defaults", () => {
      for (const ptr of Object.keys(overrides)) {
        expect(resolvePointer(defaults, ptr), `${type}: ${ptr} is not in the defaults`).not.toBeUndefined();
      }
    });

    it("has at most 4 primaries", () => {
      expect(params.filter((p) => p.primary).length).toBeLessThanOrEqual(4);
    });

    it("choice parameters have at least 2 choices", () => {
      for (const p of params) {
        if (p.type === "choice") expect(p.choices?.length ?? 0, `${type}: ${p.pointer}`).toBeGreaterThanOrEqual(2);
      }
    });

    it("every visible parameter has a deliberate label and a scalar value", () => {
      for (const p of params) {
        const key = p.pointer.split("/").pop() ?? "";
        const derived = /[A-Z_]/.test(key) && p.label === humanize(key);
        const explicit = overrides[p.pointer]?.label !== undefined;
        expect(derived && !explicit, `${type}: ${p.pointer} only has the derived label "${p.label}"`).toBe(false);
        expect(explicit, `${type}: ${p.pointer} has no explicit label`).toBe(true);
        const v = resolvePointer(defaults, p.pointer);
        expect(v !== null && typeof v !== "object", `${type}: ${p.pointer} is not a scalar`).toBe(true);
      }
    });
  });
});
