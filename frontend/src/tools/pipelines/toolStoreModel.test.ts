import { describe, expect, it } from "vitest";
import { Category, ModuleStatus, type Descriptor } from "@/lib/api";
import { normalizeModule } from "@/state/modules";
import { parseColor, readPalette, wireLook, isAnimated } from "./graph/wireStyle";
import { storeContents, unavailableReason } from "./toolStoreModel";
import { acc, CATALOG, stepType } from "./testFixtures";

const mod = (id: string, o: Partial<Descriptor> = {}) =>
  normalizeModule({
    id,
    name: id.toUpperCase(),
    tagline: `${id} tagline`,
    description: "",
    icon: "box",
    category: Category.CategoryUtility,
    status: ModuleStatus.StatusReady,
    accepts: acc([".png"]),
    requires: null,
    recommends: null,
    outputSubdir: "",
    order: 1,
    hidden: false,
    jobLess: false,
    maxInputs: 0,
    ...o,
  } as Descriptor);

describe("storeContents", () => {
  it("lists the glue first, then tools by category", () => {
    const { groups } = storeContents(CATALOG, [], "");
    expect(groups[0]?.id).toBe("glue");
    expect(groups[0]?.tools.map((t) => t.id)).toEqual(["pipelines.check", "llm-chat"]);
    expect(groups.map((g) => g.id)).toEqual(["glue", Category.CategoryMedia, Category.CategoryAudio, Category.CategoryImage, Category.CategoryDocument]);
  });

  it("searches names and descriptions", () => {
    const { groups } = storeContents(CATALOG, [], "stem");
    expect(groups.flatMap((g) => g.tools.map((t) => t.id))).toEqual(["stems"]);
  });

  it("lists modules that aren't steps with the reason, hiding system ones and catalogue tools", () => {
    const mods = [
      mod("stems", { accepts: acc([".mp3"]) }),
      mod("clipboard", { jobLess: true, accepts: acc([]) }),
      mod("composer", { accepts: acc([]) }),
      mod("soon", { status: ModuleStatus.StatusComingSoon }),
      mod("sys", { hidden: true }),
      mod("pipelines"),
      mod("project-tool", { accepts: acc([".png"]) }),
    ];
    const { unavailable } = storeContents([...CATALOG, stepType("stems", "Stem Splitter")], mods, "");
    expect(unavailable.map((u) => u.id)).toEqual(["clipboard", "composer", "soon", "project-tool"]);
    expect(unavailableReason(mods[1] as never)).toMatch(/doesn't run jobs/);
    expect(unavailable.find((u) => u.id === "composer")?.reason).toMatch(/doesn't take files/);
    expect(unavailable.find((u) => u.id === "soon")?.reason).toBe("Not built yet");
    expect(unavailable.find((u) => u.id === "project-tool")?.reason).toMatch(/by hand/);
  });
});

describe("wire style", () => {
  it("parses token colours", () => {
    expect(parseColor("#ff8000")).toEqual([1, 128 / 255, 0]);
    expect(parseColor("#f00")).toEqual([1, 0, 0]);
    expect(parseColor("rgb(0, 255, 0)")).toEqual([0, 1, 0]);
    expect(parseColor("var(--x)")).toBeNull();
  });

  it("animates idle shimmer and run flow, never with reduced motion", () => {
    expect(wireLook("idle", false).shimmer).toBeGreaterThan(0);
    expect(wireLook("flow", false).flow).toBe(true);
    expect(wireLook("done", false).flow).toBe(false);
    expect(wireLook("failed", false).danger).toBe(true);
    expect(wireLook("selected", false).bright).toBeGreaterThan(wireLook("idle", false).bright);
    const calm = [wireLook("idle", true), wireLook("flow", true)];
    expect(isAnimated(calm)).toBe(false);
    expect(isAnimated([wireLook("idle", false)])).toBe(true);
  });

  it("reads a palette with fallbacks", () => {
    const el = document.createElement("div");
    const p = readPalette(el);
    expect(p.types.files).toHaveLength(3);
  });
});
