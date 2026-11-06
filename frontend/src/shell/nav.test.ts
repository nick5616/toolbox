import { describe, expect, it } from "vitest";
import { Category, ModuleStatus, type Descriptor } from "@/lib/api";
import { normalizeModule } from "@/state/modules";
import { withRecent } from "@/state/ui";
import { buildNavGroups } from "./nav";

function mod(id: string, category: Category, order: number, extra: Partial<Descriptor> = {}) {
  return normalizeModule({
    id, name: id.toUpperCase(), tagline: `${id} tagline`, description: "", icon: "box", category, status: ModuleStatus.StatusReady,
    accepts: { extensions: null, urls: false, any: false }, requires: null, recommends: null, outputSubdir: "", order, hidden: false, jobLess: false, maxInputs: 0, base: "", parts: null,
    ...extra,
  });
}

const modules = [
  mod("a", Category.CategoryAudio, 1),
  mod("b", Category.CategoryMedia, 2),
  mod("c", Category.CategoryAudio, 3),
  mod("d", Category.CategoryImage, 4),
  mod("v", Category.CategoryMedia, 5, { base: "a" }),
];

describe("buildNavGroups", () => {
  it("groups by category in the Pipelines palette order, variants after their base", () => {
    const g = buildNavGroups(modules, [], []);
    expect(g.groups.map((x) => x.label)).toEqual(["Video & media", "Audio", "Images"]);
    expect(g.groups[1]!.items.map((i) => i.id)).toEqual(["a", "v", "c"]);
    expect(g.groups[1]!.items[1]!.variantOf).toBe("a");
  });

  it("puts tools of an unknown category in one group", () => {
    const g = buildNavGroups([mod("x", Category.$zero, 1)], [], []);
    expect(g.groups.map((x) => x.label)).toEqual(["Tools"]);
  });

  it("digits go to pinned tools first, then the first shown", () => {
    const g = buildNavGroups(modules, ["d", "gone", "c"], []);
    expect(g.pinned.map((p) => p.id)).toEqual(["d", "c"]);
    expect(g.ordered.map((o) => o.id)).toEqual(["d", "c", "b", "a", "v"]);
    expect(g.digits).toMatchObject({ d: 1, c: 2, b: 3 });
  });

  it("without pins the first nine shown get the digits", () => {
    const many = Array.from({ length: 12 }, (_, i) => mod(`t${i}`, Category.CategoryUtility, i));
    const g = buildNavGroups(many, [], []);
    expect(g.ordered).toHaveLength(9);
    expect(g.digits["t0"]).toBe(1);
    expect(g.digits["t9"]).toBeUndefined();
  });

  it("recent tools leave out the pinned ones and unknown ids", () => {
    const g = buildNavGroups(modules, ["b"], ["b", "zzz", "a"]);
    expect(g.recent.map((r) => r.id)).toEqual(["a"]);
  });
});

describe("withRecent", () => {
  it("moves a tool to the front and keeps five", () => {
    expect(withRecent(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
    expect(withRecent(["1", "2", "3", "4", "5"], "6")).toEqual(["6", "1", "2", "3", "4"]);
  });

  it("ignores views that are not tools", () => {
    expect(withRecent(["a"], "library")).toEqual(["a"]);
    expect(withRecent(["a"], "settings")).toEqual(["a"]);
    expect(withRecent(["a"], "pipelines")).toEqual(["a"]);
  });
});
