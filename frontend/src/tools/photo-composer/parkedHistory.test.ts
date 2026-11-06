import { beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => new Map<string, string>());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    FilesService: { PickWith: async () => [], Stat: async () => [{ exists: true }] },
    SettingsService: {
      ModuleState: async (k: string) => saved.get(k) ?? "",
      SetModuleState: async (k: string, v: string) => {
        saved.set(k, v);
      },
    },
  };
});

import { addLayer, newComposition, newImageLayer } from "@/composer/model";
import { parkForPopOut, resetParkedHistoryForTest } from "@/lib/parkedHistory";
import { useComposer } from "./store";

const doc0 = () => {
  const d = newComposition("4:5");
  return addLayer(d, { ...newImageLayer("C:/photos/b.jpg", 400, 300, d), id: "B", name: "b" });
};

beforeEach(() => {
  saved.clear();
  resetParkedHistoryForTest();
  useComposer.getState().close();
});

describe("Photo Composer undo history across a pop-out", () => {
  it("round-trips through park and take", async () => {
    const d = doc0();
    useComposer.getState().open({ id: "p1", name: "M", doc: d, postSlide: null });
    useComposer.getState().edit((x) => ({ ...x, background: { ...x.background, color: "#111111" } }));
    useComposer.getState().edit((x) => ({ ...x, background: { ...x.background, color: "#222222" } }));
    expect(useComposer.getState().history!.past).toHaveLength(2);
    useComposer.getState().undo();
    const undone = useComposer.getState().history!.present;
    await parkForPopOut("photo-composer");
    useComposer.getState().close();
    useComposer.getState().open({ id: "p1", name: "M", doc: undone, postSlide: null });
    await vi.waitFor(() => expect(useComposer.getState().history?.past.length).toBe(1));
    expect(useComposer.getState().history?.future).toHaveLength(1);
    useComposer.getState().redo();
    expect(useComposer.getState().history?.present.background.color).toBe("#222222");
  });

  it("ignores a park for another composition", async () => {
    useComposer.getState().open({ id: "p1", name: "M", doc: doc0(), postSlide: null });
    useComposer.getState().edit((x) => ({ ...x, background: { ...x.background, color: "#111111" } }));
    await parkForPopOut("photo-composer");
    useComposer.getState().open({ id: "p2", name: "N", doc: doc0(), postSlide: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(useComposer.getState().history?.past).toHaveLength(0);
  });
});
