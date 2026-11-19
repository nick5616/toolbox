import { afterEach, describe, expect, it } from "vitest";
import { toAppError } from "./errors";
import { setCurrentPresenter } from "./pathRewrite";

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

describe("toAppError with Hide personal details", () => {
  afterEach(() => setCurrentPresenter(null));

  it("rewrites the workspace root and home in message, hint and fields", () => {
    setCurrentPresenter({ on: true, root: "C:\\Users\\nick\\ws\\demo", name: "Demo", home: "C:\\Users\\nick" });
    const e = {
      cause: {
        code: "internal",
        message: "Can't write C:\\Users\\nick\\ws\\demo\\Library\\a.png",
        hint: "Free space under C:\\Users\\nick\\Documents",
        fields: { path: "C:\\Users\\nick\\x.txt" },
      },
    };
    expect(toAppError(e)).toEqual({
      code: "internal",
      message: "Can't write Demo/Library/a.png",
      hint: "Free space under ~/Documents",
      fields: { path: "~/x.txt" },
    });
  });

  it("leaves everything alone when it is off", () => {
    setCurrentPresenter({ on: false, root: "C:\\Users\\nick\\ws\\demo", name: "Demo", home: "C:\\Users\\nick" });
    expect(toAppError({ cause: { code: "internal", message: "C:\\Users\\nick\\a" } }).message).toBe("C:\\Users\\nick\\a");
  });
});
