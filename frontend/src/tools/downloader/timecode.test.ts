import { describe, expect, it } from "vitest";
import { parseTimecode, validateTrim } from "./timecode";

describe("parseTimecode (mirrors Go)", () => {
  const cases: Array<[string, number | null]> = [
    ["0", 0], ["5", 5], ["59.5", 59.5], ["125", 125], ["0:59.5", 59.5], ["1:05", 65], ["12:34", 754],
    ["1:02:03.5", 3723.5], ["01:02:03", 3723],
    ["1:60", null], ["1:5", null], ["1:02:60", null], ["1:60:00", null], ["", null], ["abc", null],
    ["-5", null], ["1:2:3:4", null], ["5.", null], [".5", null], ["1.5:30", null], ["1::30", null],
  ];
  it.each(cases)("%j", (input, want) => {
    expect(parseTimecode(input)).toBe(want);
  });
  it("trims whitespace", () => expect(parseTimecode(" 1:05 ")).toBe(65));
});

describe("validateTrim", () => {
  const cases: Array<[string, string, string, "trimStart" | "trimEnd" | null]> = [
    ["neither", "", "", "trimStart"],
    ["start only", "0:05", "", null],
    ["end only", "", "0:12", null],
    ["both", "0:05", "0:12", null],
    ["fractional", "0:59.5", "1:02:03.5", null],
    ["end equals start", "0:05", "0:05", "trimEnd"],
    ["end before start", "1:00", "0:30", "trimEnd"],
    ["end zero no start", "", "0", "trimEnd"],
    ["bad start", "1:60", "", "trimStart"],
    ["bad end", "0:05", "x", "trimEnd"],
  ];
  it.each(cases)("%s", (_n, start, end, field) => {
    const r = validateTrim(true, start, end);
    expect(Object.keys(r)).toEqual(field ? [field] : []);
  });
  it("is empty when disabled", () => expect(validateTrim(false, "x", "y")).toEqual({}));
});
