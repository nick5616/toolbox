import { describe, expect, it } from "vitest";
import type { PipelineStep } from "@/lib/api";
import {
  bindOf,
  builtinVarType,
  canWire,
  deriveParams,
  displayValue,
  fromWireType,
  humanize,
  optionString,
  paramNameFromLabel,
  parseOptions,
  resolvePointer,
  scalarType,
  setBind,
  validParamValue,
  VALUE_TYPE_LABELS,
  VALUE_TYPES,
  valueTypeVar,
  VAR_NAME_RE,
  type ValueType,
} from "./params";

const step = (binds?: PipelineStep["binds"]): PipelineStep =>
  ({ id: "s", type: "x", label: "", optionsJson: "{}", from: "input", filter: { roles: [], kinds: [], exts: [], name: "" }, manual: false, autoContinue: true, keep: false, note: "", binds: binds ?? [] }) as PipelineStep;

describe("deriveParams", () => {
  it("makes a parameter of every scalar, with its type from the value", () => {
    const ps = deriveParams('{"speed":1.5,"title":"Hi","loud":false,"tint":"#AaBbCc","plain":"#abc"}');
    expect(ps.map((p) => [p.pointer, p.type])).toEqual([
      ["/speed", "number"],
      ["/title", "text"],
      ["/loud", "toggle"],
      ["/tint", "color"],
      ["/plain", "text"],
    ]);
  });

  it("humanises keys into labels", () => {
    expect(deriveParams('{"maxWidth":1,"bpm_exact":2}').map((p) => p.label)).toEqual(["Max width", "Bpm exact"]);
    expect(humanize("showJson")).toBe("Show json");
  });

  it("walks nested objects up to three levels deep and never into arrays, nulls or the root", () => {
    const json = '{"a":{"b":{"c":1,"d":{"e":2}},"list":[1,2],"n":null},"top":true}';
    expect(deriveParams(json).map((p) => p.pointer)).toEqual(["/a/b/c", "/top"]);
    expect(deriveParams("5")).toEqual([]);
    expect(deriveParams("not json")).toEqual([]);
    expect(deriveParams("[1]")).toEqual([]);
  });

  it("escapes pointers (~ and /) in keys", () => {
    const ps = deriveParams('{"a/b":1,"c~d":2}');
    expect(ps.map((p) => p.pointer)).toEqual(["/a~1b", "/c~0d"]);
    expect(resolvePointer({ "a/b": 7, "c~d": 8 }, "/a~1b")).toBe(7);
    expect(resolvePointer({ "a/b": 7, "c~d": 8 }, "/c~0d")).toBe(8);
  });

  it("marks the first three primary when no override says otherwise", () => {
    const ps = deriveParams('{"a":1,"b":2,"c":3,"d":4,"e":5}');
    expect(ps.map((p) => p.primary)).toEqual([true, true, true, false, false]);
  });

  it("puts primaries first, then the defaults' key order, and stops the fallback when any override is primary", () => {
    const ps = deriveParams('{"a":1,"b":2,"c":3,"d":4}', { "/c": { primary: true }, "/d": { primary: true } });
    expect(ps.map((p) => [p.pointer, p.primary])).toEqual([
      ["/c", true],
      ["/d", true],
      ["/a", false],
      ["/b", false],
    ]);
  });

  it("applies label, type, choices, bounds and tip overrides", () => {
    const ps = deriveParams('{"voice":"am_adam","size":3}', {
      "/voice": { label: "Voice", type: "choice", choices: [{ value: "am_adam", label: "Adam" }, { value: "af_bella", label: "Bella" }], tip: "Who speaks" },
      "/size": { min: 1, max: 9 },
    });
    expect(ps[0]).toMatchObject({ pointer: "/voice", label: "Voice", type: "choice", tip: "Who speaks" });
    expect(ps[0]?.choices).toHaveLength(2);
    expect(ps[1]).toMatchObject({ min: 1, max: 9 });
  });

  it("drops hidden options, and the fallback primaries come from the ones that remain", () => {
    const ps = deriveParams('{"id":"x","a":1,"b":2,"c":3,"d":4}', { "/id": { hidden: true } });
    expect(ps.map((p) => p.pointer)).toEqual(["/a", "/b", "/c", "/d"]);
    expect(ps.map((p) => p.primary)).toEqual([true, true, true, false]);
  });
});

describe("canWire", () => {
  const types: ValueType[] = ["text", "number", "toggle", "choice", "color", "file"];
  // from \ to: text number toggle choice color file ("ok", "loose" = ⚠, "no")
  const table: Record<string, string[]> = {
    text: ["ok", "loose", "loose", "loose", "loose", "loose"],
    number: ["ok", "ok", "no", "loose", "no", "no"],
    toggle: ["ok", "no", "ok", "no", "no", "no"],
    choice: ["ok", "no", "no", "ok", "no", "no"],
    color: ["ok", "no", "no", "no", "ok", "no"],
    file: ["ok", "no", "no", "no", "no", "ok"],
  };
  for (const from of types) {
    it(`from ${from}`, () => {
      types.forEach((to, i) => {
        const v = canWire(from, to);
        const want = table[from]?.[i];
        const got = v.ok ? (v.loose ? "loose" : "ok") : "no";
        expect(`${to}:${got}`).toBe(`${to}:${want}`);
        if (v.ok && v.loose) expect(v.reason).toMatch(/fails/);
        if (!v.ok) expect(v.reason).toBeTruthy();
      });
    });
  }

  it("a files stream only wires to a files input", () => {
    expect(canWire("files", "files")).toEqual({ ok: true });
    expect(canWire("files", "text").ok).toBe(false);
    expect(canWire("text", "files").ok).toBe(false);
  });
});

describe("binds", () => {
  it("setBind adds, replaces and removes without touching the original", () => {
    const s0 = step();
    const s1 = setBind(s0, "/speed", "bpm");
    expect(s1.binds).toEqual([{ option: "/speed", var: "bpm" }]);
    expect(s0.binds).toEqual([]);
    const s2 = setBind(setBind(s1, "/title", "name"), "/speed", "bpm_exact");
    expect(s2.binds).toEqual([
      { option: "/title", var: "name" },
      { option: "/speed", var: "bpm_exact" },
    ]);
    expect(setBind(s2, "/speed", null).binds).toEqual([{ option: "/title", var: "name" }]);
    expect(bindOf(s2, "/speed")).toBe("bpm_exact");
    expect(bindOf(s2, "/none")).toBeUndefined();
  });

  it("tolerates a step with no binds array", () => {
    const s = { ...step(), binds: undefined } as unknown as PipelineStep;
    expect(bindOf(s, "/x")).toBeUndefined();
    expect(setBind(s, "/x", "v").binds).toEqual([{ option: "/x", var: "v" }]);
  });
});

describe("value helpers", () => {
  it("colours and labels cover every type", () => {
    for (const t of VALUE_TYPES) {
      expect(valueTypeVar(t)).toBe(`var(--type-${t})`);
      expect(VALUE_TYPE_LABELS[t]).toBeTruthy();
    }
    expect(valueTypeVar("any")).toBe("var(--type-any)");
  });

  it("maps Go value types, with empty meaning text", () => {
    expect(fromWireType("")).toBe("text");
    expect(fromWireType(undefined)).toBe("text");
    expect(fromWireType("number" as never)).toBe("number");
    expect(fromWireType("file" as never)).toBe("file");
    expect(builtinVarType("n")).toBe("number");
    expect(builtinVarType("name")).toBe("text");
  });

  it("reads scalars out of options and names their types", () => {
    const o = parseOptions('{"a":{"b":2},"t":"x","f":true}');
    expect(optionString(o, "/a/b")).toBe("2");
    expect(optionString(o, "/t")).toBe("x");
    expect(optionString(o, "/f")).toBe("true");
    expect(optionString(o, "/missing")).toBe("");
    expect(parseOptions("nope")).toEqual({});
    expect([scalarType(1), scalarType(true), scalarType("#112233"), scalarType("hi"), scalarType(undefined)]).toEqual(["number", "toggle", "color", "text", "text"]);
  });

  it("shows values the way a node does", () => {
    expect(displayValue({ type: "toggle" }, "true")).toBe("On");
    expect(displayValue({ type: "toggle" }, "false")).toBe("Off");
    expect(displayValue({ type: "number" }, "")).toBe("(empty)");
    expect(displayValue({ type: "choice", choices: [{ value: "a", label: "Alpha" }] }, "a")).toBe("Alpha");
    expect(displayValue({ type: "choice", choices: [{ value: "a", label: "Alpha" }] }, "z")).toBe("z");
  });

  it("makes valid, unique run-parameter names from labels", () => {
    expect(paramNameFromLabel("Max width", [])).toBe("max_width");
    expect(paramNameFromLabel("Max width", ["max_width"])).toBe("max_width_2");
    expect(paramNameFromLabel("Max width", ["max_width", "max_width_2"])).toBe("max_width_3");
    expect(paramNameFromLabel("123 go", [])).toMatch(VAR_NAME_RE);
    expect(paramNameFromLabel("!!!", [])).toMatch(VAR_NAME_RE);
    expect(paramNameFromLabel("A".repeat(80), [])).toMatch(VAR_NAME_RE);
    expect(paramNameFromLabel("Über straße", [])).toMatch(VAR_NAME_RE);
  });

  it("validates run-parameter values like Go does", () => {
    expect(validParamValue("number", "1.5")).toBe(true);
    expect(validParamValue("number", "abc")).toBe(false);
    expect(validParamValue("number", "")).toBe(false);
    expect(validParamValue("toggle", "Yes")).toBe(true);
    expect(validParamValue("toggle", "maybe")).toBe(false);
    expect(validParamValue("choice", "b", ["a", "b"])).toBe(true);
    expect(validParamValue("choice", "c", ["a", "b"])).toBe(false);
    expect(validParamValue("color", "#aabbcc")).toBe(true);
    expect(validParamValue("color", "#abc")).toBe(false);
    expect(validParamValue("text", "x".repeat(1001))).toBe(false);
    expect(validParamValue("text", "")).toBe(true);
  });
});
