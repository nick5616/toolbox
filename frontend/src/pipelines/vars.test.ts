import { describe, expect, it } from "vitest";
import vectors from "../../../core/testdata/vars.json";
import { BUILTIN_VARS, escapeTemplate, expandVars, templateVars } from "./vars";

describe("pipeline variables", () => {
  it("matches the Go vectors", () => {
    for (const c of vectors.cases) {
      const { out, missing } = expandVars(c.tpl, vectors.vars);
      expect(out, c.tpl).toBe(c.out);
      expect(missing, c.tpl).toEqual(c.missing);
      expect(templateVars(c.tpl), c.tpl).toEqual(c.used);
    }
  });

  it("lets later maps win", () => {
    expect(expandVars("{name}-{bpm}", { name: "item", bpm: "1" }, { name: "file" }).out).toBe("file-1");
  });

  it("escapes braces", () => {
    const tpl = escapeTemplate("{x}");
    expect(expandVars(tpl).out).toBe("{x}");
  });
});

describe("built-in variables", () => {
  it("include the run weekday (Go: Mon … Sun)", () => {
    expect(BUILTIN_VARS.map((v) => v.name)).toEqual(["item", "name", "ext", "role", "n", "date", "time", "weekday", "pipeline"]);
  });
});
