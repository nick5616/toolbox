import { describe, expect, it } from "vitest";
import {
  autoContinueFor,
  blankPipeline,
  duplicateStep,
  insertStep,
  moveStep,
  newStep,
  newStepId,
  removeStep,
  uniqueName,
} from "./editorModel";
import { CATALOG, check, product, step, stepCheck, stepType } from "./testFixtures";

const type = (id: string) => CATALOG.find((t) => t.id === id)!;

describe("editorModel", () => {
  it("makes unique 8-character ids", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = newStepId(taken);
      expect(id).toMatch(/^[a-z0-9]{8}$/);
      expect(taken.has(id)).toBe(false);
      taken.add(id);
    }
  });

  it("sets AutoContinue by tool", () => {
    for (const t of ["subtitles", "lyric-video", "visualizer", "pdf"]) expect(autoContinueFor(t)).toBe(false);
    for (const t of ["trimmer", "stems", "object-eraser"]) expect(autoContinueFor(t)).toBe(true);
  });

  it("builds a new step with the type's defaults", () => {
    const first = newStep(type("downloader"), [], undefined, 0);
    expect(first).toMatchObject({ type: "downloader", from: "input", manual: false, optionsJson: '{"format":"video"}', keep: false });
    const eraser = newStep(type("object-eraser"), [], undefined, 0);
    expect(eraser).toMatchObject({ manual: true, optionsJson: "{}", autoContinue: true });
    const chat = newStep(type("pipelines.chat"), [first], undefined, 1);
    expect(chat.from).toBe("none");
  });

  it("reads from the nearest earlier step it can read", () => {
    const a = step("aaaaaaaa", "downloader");
    const b = step("bbbbbbbb", "stems", { from: "aaaaaaaa" });
    const c = check([stepCheck("aaaaaaaa", {}, [product("", [".mp3"])]), stepCheck("bbbbbbbb", {}, [product("bass", [".flac"])])]);
    expect(newStep(type("stems"), [a, b], c, 2).from).toBe("bbbbbbbb");
    expect(newStep(type("trimmer"), [a, b], c, 2).from).toBe("input");
  });

  it("keeps the new last step and un-keeps the previous one unless the user set it", () => {
    const a = step("aaaaaaaa", "downloader", { keep: true });
    const added = newStep(type("stems"), [a], undefined, 1);
    const out = insertStep([a], 1, added, new Set());
    expect(out.map((s) => s.keep)).toEqual([false, true]);

    const touched = insertStep([a], 1, added, new Set(["aaaaaaaa"]));
    expect(touched.map((s) => s.keep)).toEqual([true, true]);

    const mid = insertStep(out, 1, newStep(type("trimmer"), out, undefined, 1), new Set());
    expect(mid.map((s) => s.keep)).toEqual([false, false, true]);
  });

  it("rewires steps that read a removed step", () => {
    const steps = [step("aaaaaaaa", "downloader"), step("bbbbbbbb", "stems", { from: "aaaaaaaa" }), step("cccccccc", "stems", { from: "bbbbbbbb" })];
    const out = removeStep(steps, "bbbbbbbb");
    expect(out.map((s) => s.id)).toEqual(["aaaaaaaa", "cccccccc"]);
    expect(out[1]?.from).toBe("aaaaaaaa");
    expect(removeStep(removeStep(steps, "bbbbbbbb"), "aaaaaaaa")[0]?.from).toBe("input");
  });

  it("moves steps and fixes sources that would read a later step", () => {
    const steps = [step("aaaaaaaa", "downloader"), step("bbbbbbbb", "stems", { from: "aaaaaaaa" }), step("cccccccc", "stems", { from: "bbbbbbbb" })];
    const down = moveStep(steps, 0, 1);
    expect(down.map((s) => s.id)).toEqual(["bbbbbbbb", "aaaaaaaa", "cccccccc"]);
    expect(down[0]?.from).toBe("input");
    expect(down[2]?.from).toBe("bbbbbbbb");
    expect(moveStep(steps, 1, 1)).toEqual(steps);
    expect(moveStep(steps, 0, 9)).toEqual(steps);
  });

  it("duplicates a step with a new id", () => {
    const steps = [step("aaaaaaaa", "downloader", { label: "x", keep: true })];
    const { steps: out, id } = duplicateStep(steps, "aaaaaaaa");
    expect(out).toHaveLength(2);
    expect(out[1]?.id).toBe(id);
    expect(id).not.toBe("aaaaaaaa");
    expect(out[1]?.label).toBe("x");
  });

  it("names pipelines uniquely ignoring case", () => {
    expect(uniqueName("New pipeline", [])).toBe("New pipeline");
    expect(uniqueName("New pipeline", ["new PIPELINE", "New pipeline 2"])).toBe("New pipeline 3");
  });

  it("makes a blank pipeline with one Downloader step reading the input", () => {
    const p = blankPipeline(CATALOG, ["New pipeline"]);
    expect(p.name).toBe("New pipeline 2");
    expect(p.steps ?? []).toHaveLength(1);
    expect((p.steps ?? [])[0]).toMatchObject({ type: "downloader", from: "input", keep: true, optionsJson: '{"format":"video"}' });
    expect((blankPipeline([stepType("x", "X")], []).steps ?? [])[0]?.type).toBe("downloader");
  });
});
