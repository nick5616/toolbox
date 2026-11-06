import { describe, expect, it } from "vitest";
import { ValueType } from "@/lib/api";
import { runParamsText } from "./RunSheetModel";

const params = [
  { name: "voice", label: "Voice", type: ValueType.ValueChoice },
  { name: "speed", label: "Speed", type: ValueType.ValueNumber },
  { name: "loud", label: "Loud", type: ValueType.ValueToggle },
];

describe("runParamsText", () => {
  it("lists the values a run used, in the parameters' order", () => {
    expect(runParamsText(params, [{ vars: { speed: "1.1", voice: "am_adam", name: "x" } }])).toBe("Voice: am_adam · Speed: 1.1");
  });

  it("reads toggles as On / Off", () => {
    expect(runParamsText(params, [{ vars: { loud: "true" } }])).toBe("Loud: On");
    expect(runParamsText(params, [{ vars: { loud: "false" } }])).toBe("Loud: Off");
  });

  it("shows nothing when the run carries none of them (older runs, no parameters)", () => {
    expect(runParamsText(params, [{ vars: { name: "x" } }])).toBe("");
    expect(runParamsText(params, [])).toBe("");
    expect(runParamsText([], [{ vars: { voice: "a" } }])).toBe("");
  });

  it("takes the first item that has them", () => {
    expect(runParamsText(params, [{ vars: {} }, { vars: { speed: "2" } }])).toBe("Speed: 2");
  });
});
