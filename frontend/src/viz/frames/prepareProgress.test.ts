import { describe, expect, it } from "vitest";
import { prepareProgressOf } from "./prepareProgress";

describe("prepareProgressOf", () => {
  it("is null for a ready source or without a job", () => {
    expect(prepareProgressOf(true, { status: "running", progress: 0.5 })).toBeNull();
    expect(prepareProgressOf(false, undefined)).toBeNull();
  });
  it("follows a running job, -1 while queued, null once finished", () => {
    expect(prepareProgressOf(false, { status: "running", progress: 0.4 })).toBe(0.4);
    expect(prepareProgressOf(false, { status: "running", progress: -1 })).toBe(-1);
    expect(prepareProgressOf(false, { status: "queued", progress: 0 })).toBe(-1);
    expect(prepareProgressOf(false, { status: "done", progress: 1 })).toBeNull();
  });
});
