import { describe, expect, it } from "vitest";
import { toAppError } from "./errors";

describe("toAppError", () => {
  it("reads a structured cause", () => {
    const e = Object.assign(new Error("x"), {
      cause: { code: "validation", message: "Bad input", fields: { "inputs.0": "Not a link" } },
    });
    expect(toAppError(e)).toEqual({ code: "validation", message: "Bad input", fields: { "inputs.0": "Not a link" } });
  });

  it("parses a JSON string cause", () => {
    const e = { message: "x", cause: JSON.stringify({ code: "conflict", message: "Busy", hint: "Wait" }) };
    expect(toAppError(e)).toEqual({ code: "conflict", message: "Busy", hint: "Wait" });
  });

  it("falls back to internal", () => {
    expect(toAppError(new Error("boom"))).toEqual({ code: "internal", message: "boom" });
    expect(toAppError("weird")).toEqual({ code: "internal", message: "weird" });
  });
});
