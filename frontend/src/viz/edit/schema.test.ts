import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEXT_STYLE,
  IDENTITY_TRANSFORM,
  isEditSignal,
  parseCaptionLines,
  parseEditParam,
  parseEffects,
  parseLook,
  parseMasks,
  parseSpeed,
  parseTextStyle,
  parseTransform,
  parseTransition,
  serializeEffects,
  serializeMasks,
  serializeSpeed,
  serializeTransform,
  serializeTransition,
} from "./schema";

describe("edit schema", () => {
  it("gives defaults for empty fields", () => {
    expect(parseTransform("")).toEqual({ ok: true, value: IDENTITY_TRANSFORM, problems: [] });
    expect(parseMasks("").value).toEqual([]);
    expect(parseEffects("").value).toEqual([]);
    expect(parseTransition("").value).toEqual({ kind: "cut", ms: 0 });
    expect(parseSpeed("").value).toBe(1);
    expect(parseTextStyle("").value).toEqual(DEFAULT_TEXT_STYLE);
    expect(parseCaptionLines("").value).toBeNull();
  });

  it("never throws on garbage", () => {
    for (const raw of ["{", "null", "42", '"x"', "[1,2]", '{"a":{}}']) {
      expect(() => parseTransform(raw)).not.toThrow();
      expect(() => parseMasks(raw)).not.toThrow();
      expect(() => parseEffects(raw)).not.toThrow();
      expect(() => parseLook(raw)).not.toThrow();
      expect(() => parseTransition(raw)).not.toThrow();
      expect(() => parseSpeed(raw)).not.toThrow();
      expect(() => parseTextStyle(raw)).not.toThrow();
      expect(() => parseCaptionLines(raw)).not.toThrow();
    }
    expect(parseTransform("{").ok).toBe(false);
  });

  it("round-trips a keyed, modulated transform", () => {
    const t = {
      ...IDENTITY_TRANSFORM,
      scale: { base: 1, keys: [{ t: 0, v: 1, ease: "linear" as const }, { t: 1000, v: 1.2, ease: "ease" as const }] },
      opacity: { base: 1, mods: [{ signal: "marker.kick" as const, amount: -0.5, shape: "exp" as const, every: 2, sections: ["chorus" as const] }] },
    };
    const raw = serializeTransform(t);
    const back = parseTransform(raw);
    expect(back.ok).toBe(true);
    expect(back.value).toEqual(t);
    expect(serializeTransform(IDENTITY_TRANSFORM)).toBe("");
  });

  it("clamps and sorts params", () => {
    const problems: string[] = [];
    expect(parseEditParam(9, 1, { min: 0, max: 4 }, "p", problems)).toBe(4);
    const p = parseEditParam({ base: 1, keys: [{ t: 500, v: 2, ease: "x" }, { t: 0, v: 9 }] }, 1, { min: 0, max: 4 }, "p", problems);
    expect(p).toEqual({ base: 1, keys: [{ t: 0, v: 4, ease: "linear" }, { t: 500, v: 2, ease: "linear" }] });
    expect(problems.length).toBe(1);
  });

  it("rejects mods on speed and every on viz signals", () => {
    expect(parseSpeed(JSON.stringify({ base: 1, mods: [{ signal: "kick", amount: 1, shape: "linear" }] })).ok).toBe(false);
    const problems: string[] = [];
    parseEditParam({ base: 0, mods: [{ signal: "kick", amount: 1, shape: "linear", every: 2 }] }, 0, { min: 0, max: 1 }, "p", problems);
    expect(problems.join()).toMatch(/every/);
    expect(isEditSignal("marker.drop")).toBe(true);
    expect(isEditSignal("marker.cowbell")).toBe(false);
    expect(isEditSignal("drop.pulse")).toBe(true);
  });

  it("drops unknown and stateful effects", () => {
    const raw = JSON.stringify([
      { id: "a", type: "shake", enabled: true, params: { amount: 0.4, bogus: 1 } },
      { id: "b", type: "feedback", enabled: true, params: {} },
      { id: "c", type: "bloom", enabled: true, params: {} },
      { id: "d", type: "nope", enabled: true, params: {} },
    ]);
    const fx = parseEffects(raw);
    expect(fx.value.map((p) => p.id)).toEqual(["a"]);
    expect(fx.value[0]?.params).toEqual({ amount: 0.4 });
    expect(fx.problems.length).toBe(4);
    expect(parseLook(raw).value.map((p) => p.id)).toEqual(["a", "c"]);
    expect(serializeEffects([])).toBe("");
  });

  it("parses masks", () => {
    const raw = JSON.stringify([
      { id: "m1", shape: "ellipse", x: 0.5, y: 0.5, w: 0.4, h: 0.6, rotation: 0, feather: 0.9, invert: true, op: "subtract" },
      { id: "m2", shape: "path", x: 0.5, y: 0.5, w: 1, h: 1, rotation: 0, points: [[0, 0], [1, 0]], feather: 0, invert: false, op: "add" },
    ]);
    const m = parseMasks(raw);
    expect(m.value).toHaveLength(1);
    expect(m.value[0]?.feather).toBe(0.5);
    expect(m.value[0]?.op).toBe("subtract");
    expect(parseMasks(serializeMasks(m.value)).value).toEqual(m.value);
  });

  it("parses transitions and speed", () => {
    expect(parseTransition('{"kind":"flash","ms":300}').value).toEqual({ kind: "flash", ms: 300 });
    expect(parseTransition('{"kind":"flash","ms":9000}').value.ms).toBe(2000);
    expect(parseTransition('{"kind":"cut","ms":300}').value.ms).toBe(0);
    expect(serializeTransition({ kind: "cut", ms: 0 })).toBe("");
    expect(parseSpeed("2.5").value).toBe(2.5);
    expect(serializeSpeed(1)).toBe("");
  });

  it("parses text styles and caption lines", () => {
    const s = parseTextStyle(JSON.stringify({ preset: "karaoke", size: 50, color: "red", position: "lower" }));
    expect(s.value.preset).toBe("karaoke");
    expect(s.value.size).toBe(12);
    expect(s.value.color).toBe("#ffffff");
    expect(s.value.position).toBe("lower");
    const lines = parseCaptionLines(JSON.stringify([{ startMs: 2000, endMs: 3000, text: "b", words: [] }, { startMs: 0, endMs: 1000, text: "a", words: [{ startMs: 0, endMs: 400, text: "a", emphasis: true }] }]));
    expect(lines.value?.map((l) => l.text)).toEqual(["a", "b"]);
    expect(parseCaptionLines('[{"startMs":5,"endMs":1,"text":"x"}]').value).toEqual([]);
  });
});
