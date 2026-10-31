import { describe, expect, it } from "vitest";
import type { Accepts, PipelineCheck, PipelineStep, StepProduct } from "@/lib/api";
import { OutputKind } from "@/lib/api";
import { canRead, defaultFrom, describeAccepts, filterProducts } from "./compat";

const acc = (extensions: string[], o: Partial<Accepts> = {}): Accepts => ({ extensions, urls: false, any: false, ...o });
const prod = (role: string, exts: string[], kind: OutputKind = OutputKind.KindAudio): StepProduct => ({ role, label: role, kind, exts, many: false });

describe("compat", () => {
  it("reads by extension or any", () => {
    expect(canRead(acc([".mp3"]), [prod("", [".mp3"])])).toBe(true);
    expect(canRead(acc([".png"]), [prod("", [".mp3"])])).toBe(false);
    expect(canRead(acc([], { any: true }), [prod("", [".x"])])).toBe(true);
    expect(canRead(acc([], { any: true }), [])).toBe(false);
  });

  it("filters by role, kind and extension", () => {
    const ps = [prod("bass", [".flac"]), prod("vocals", [".flac"]), prod("video", [".mp4"], OutputKind.KindVideo)];
    expect(filterProducts(ps, { roles: ["bass"], kinds: [], exts: [], name: "" }).map((p) => p.role)).toEqual(["bass"]);
    expect(filterProducts(ps, { roles: [], kinds: [OutputKind.KindVideo], exts: [], name: "" }).map((p) => p.role)).toEqual(["video"]);
    expect(filterProducts(ps, { roles: [], kinds: [], exts: ["mp4"], name: "" }).map((p) => p.role)).toEqual(["video"]);
  });

  it("picks the nearest readable step as the default source", () => {
    const steps = [{ id: "a" }, { id: "b" }] as PipelineStep[];
    const check = {
      steps: [
        { stepId: "a", info: { produces: [prod("", [".mp3"])] } },
        { stepId: "b", info: { produces: [prod("", [".png"], OutputKind.KindImage)] } },
      ],
    } as unknown as PipelineCheck;
    expect(defaultFrom(steps, check, 2, acc([".mp3"]), false)).toBe("a");
    expect(defaultFrom(steps, check, 2, acc([".png"]), false)).toBe("b");
    expect(defaultFrom(steps, check, 2, acc([".pdf"]), false)).toBe("input");
    expect(defaultFrom(steps, check, 2, acc([]), true)).toBe("none");
  });

  it("describes what a run takes", () => {
    expect(describeAccepts(acc([".mp3", ".mp4"]))).toBe("audio & video files");
    expect(describeAccepts(acc([], { urls: true }))).toBe("links");
    expect(describeAccepts(acc([".pdf", ".png"]))).toBe("PDF & image files");
  });
});
