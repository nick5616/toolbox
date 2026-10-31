import { describe, expect, it } from "vitest";
import type { Pipeline, PipelineStep } from "@/lib/api";
import { fillVisualizerDesigns, presetShowJson } from "./visualizerDesigns";

const step = (type: string, options: object): PipelineStep =>
  ({ id: "s1", type, label: "", optionsJson: JSON.stringify(options), from: "input", filter: { roles: [], kinds: [], exts: [], name: "" }, manual: false, autoContinue: false, keep: true, note: "" });

describe("visualizer designs", () => {
  it("fills a preset's show once", () => {
    const p = { steps: [step("visualizer", { presetId: "golden-hour", showJson: "" }), step("converter", { preset: "mp3-320" })] } as unknown as Pipeline;
    const out = fillVisualizerDesigns(p);
    const o = JSON.parse(out.steps?.[0]?.optionsJson ?? "{}") as { showJson: string; designName: string };
    expect(o.showJson).toBe(presetShowJson("golden-hour"));
    expect(o.designName).toBe("Golden Hour");
    expect(out.steps?.[1]).toBe(p.steps?.[1]);
    const again = fillVisualizerDesigns(out);
    expect(again.steps?.[0]?.optionsJson).toBe(out.steps?.[0]?.optionsJson);
  });

  it("ignores unknown presets", () => {
    expect(presetShowJson("nope")).toBeNull();
  });
});
