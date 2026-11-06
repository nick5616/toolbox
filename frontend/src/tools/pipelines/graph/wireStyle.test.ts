import { describe, expect, it } from "vitest";
import { isAnimated, lookFor, readPalette, svgWireStyle, typeStyle, wireLook } from "./wireStyle";

describe("wire style (Phase 16)", () => {
  it("value wires are thinner than file wires, and never flow or shimmer", () => {
    for (const state of ["idle", "flow", "done", "selected", "drag"] as const) {
      const file = lookFor(state, false, false);
      const value = lookFor(state, false, true);
      expect(value.core).toBeLessThan(file.core);
      expect(value.flow).toBe(false);
      expect(value.shimmer).toBe(0);
    }
    expect(lookFor("idle", false, true).core).toBe(1.6);
    expect(isAnimated([lookFor("flow", false, true)])).toBe(false);
    expect(lookFor("flow", false, false)).toEqual(wireLook("flow", false));
  });

  it("styles the SVG fallback from the type token, thin and dashed when asked", () => {
    expect(svgWireStyle("files", false, false, false)).toEqual({ stroke: "var(--type-files)" });
    expect(svgWireStyle("number", true, false, false)).toEqual({ stroke: "var(--type-number)", strokeWidth: 1.6 });
    expect(svgWireStyle("text", true, true, false)).toEqual({ stroke: "var(--type-text)", strokeWidth: 1.6, strokeDasharray: "5 4" });
    // a failed wire keeps the danger colour from its class
    expect(svgWireStyle("number", true, false, true).stroke).toBeUndefined();
  });

  it("sets --c for a port or swatch", () => {
    expect((typeStyle("choice") as Record<string, string>)["--c"]).toBe("var(--type-choice)");
  });

  it("reads a colour for every type (with a fallback when a token is missing)", () => {
    const p = readPalette(document.createElement("div"));
    for (const t of ["files", "file", "text", "number", "toggle", "choice", "color", "any"] as const) expect(p.types[t]).toHaveLength(3);
  });
});
