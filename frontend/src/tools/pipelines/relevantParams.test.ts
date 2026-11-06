import { describe, expect, it } from "vitest";
import "@/pipelines/steps";
import { DEFAULT_FOCUS_STEP } from "@/pipelines/steps/focus";
import { DEFAULT_WAIT_STEP } from "@/pipelines/steps/wait";
import { stepParams } from "./wiring";
import { step, stepType } from "./testFixtures";

const focusType = stepType("focus", "Focus Lock", { defaultsJson: JSON.stringify(DEFAULT_FOCUS_STEP) });
const waitType = stepType("pipelines.wait", "Wait", { defaultsJson: JSON.stringify(DEFAULT_WAIT_STEP) });
const ptrs = (s: ReturnType<typeof step>, t: typeof focusType) => stepParams(s, t).map((p) => p.pointer);

describe("only relevant parameters show", () => {
  it("a focus start for a while shows minutes, not the time", () => {
    const p = ptrs(step("a", "focus", { optionsJson: JSON.stringify({ ...DEFAULT_FOCUS_STEP, action: "start", mode: "for" }) }), focusType);
    expect(p).toContain("/minutes");
    expect(p).not.toContain("/at");
  });
  it("a focus start until a time shows the time, not minutes", () => {
    const p = ptrs(step("a", "focus", { optionsJson: JSON.stringify({ ...DEFAULT_FOCUS_STEP, action: "start", mode: "until" }) }), focusType);
    expect(p).toContain("/at");
    expect(p).not.toContain("/minutes");
  });
  it("a focus wait or end has no settings, unless one is wired", () => {
    expect(ptrs(step("a", "focus", { optionsJson: JSON.stringify({ ...DEFAULT_FOCUS_STEP, action: "wait" }) }), focusType)).toEqual([]);
    const wired = step("a", "focus", { optionsJson: JSON.stringify({ ...DEFAULT_FOCUS_STEP, action: "end" }), binds: [{ option: "/minutes", var: "m" }] });
    expect(ptrs(wired, focusType)).toEqual(["/minutes"]);
  });
  it("a wait until a time shows the time", () => {
    const p = ptrs(step("a", "pipelines.wait", { optionsJson: JSON.stringify({ ...DEFAULT_WAIT_STEP, mode: "until" }) }), waitType);
    expect(p).toEqual(expect.arrayContaining(["/mode", "/at", "/note"]));
    expect(p).not.toContain("/minutes");
  });
});
