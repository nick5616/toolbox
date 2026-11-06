import { describe, expect, it } from "vitest";
import { BLEND_MODES } from "./gl";
import { BLEND_FS, DAB_FS } from "./shaders";

// Source text of the engine's own folders (the Lab, AI and tools folders belong to other packages).
const files = import.meta.glob(["../{engine,brushes,input,guides,adjust,io}/**/*.ts", "!../**/*.test.ts", "!../**/testing.ts", "!../brushes/library/**"], { eager: true, query: "?raw", import: "default" }) as Record<string, string>;

describe("determinism rules", () => {
  it("has engine sources to check", () => {
    expect(Object.keys(files).length).toBeGreaterThan(20);
  });

  it("no Math.random, Date or performance.now in engine, brush, compositor or adjustment maths", () => {
    const bad: string[] = [];
    for (const [file, src] of Object.entries(files)) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      if (/Math\.random\s*\(/.test(code)) bad.push(`${file}: Math.random`);
      if (/\bDate\b\s*[.(]/.test(code) || /new\s+Date\b/.test(code)) bad.push(`${file}: Date`);
      if (/performance\.now\s*\(/.test(code)) bad.push(`${file}: performance.now`);
    }
    expect(bad).toEqual([]);
  });

  it("never imports a tool", () => {
    for (const [file, src] of Object.entries(files)) expect(src, file).not.toMatch(/from\s+["']@\/tools\//);
  });

  it("the GLSL covers every blend mode the CPU reference has", () => {
    // sep() handles 1..11 and blendRGB 12..15; if a mode is added to BLEND_MODES this fails until the shader follows.
    expect(BLEND_MODES).toHaveLength(16);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) expect(BLEND_FS).toContain(`if (m == ${n})`);
    for (const n of [12, 13, 14]) expect(BLEND_FS).toContain(`if (m == ${n})`);
    expect(DAB_FS).toContain("u_rendering == 2");
  });
});
