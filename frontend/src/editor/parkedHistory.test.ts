import { beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => new Map<string, string>());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    SettingsService: {
      ModuleState: async (k: string) => saved.get(k) ?? "",
      SetModuleState: async (k: string, v: string) => {
        saved.set(k, v);
      },
    },
  };
});

import { useEditStudio } from "@/editor/store";
import { withClip } from "@/editor/doc";
import { parkForPopOut, resetParkedHistoryForTest } from "@/lib/parkedHistory";
import { normalizeProject } from "@/viz/edit/defaults";
import { fixtureProject } from "@/viz/edit/fixture";

beforeEach(() => {
  saved.clear();
  resetParkedHistoryForTest();
  useEditStudio.getState().close();
});

describe("editor undo history across a pop-out", () => {
  it("round-trips through park and take (either family tool)", async () => {
    const doc = normalizeProject(fixtureProject());
    useEditStudio.getState().open("p1", "Edit", doc);
    const a = withClip(doc, "c1", { volume: 1 });
    const b = withClip(a, "c1", { volume: 2 });
    useEditStudio.getState().edit(a);
    useEditStudio.getState().edit(b);
    useEditStudio.getState().undo();
    await parkForPopOut("edit-studio");
    // The new window loads the saved document (the present) and starts fresh.
    useEditStudio.getState().close();
    useEditStudio.getState().open("p1", "Edit", a);
    await vi.waitFor(() => expect(useEditStudio.getState().history?.past.length).toBe(1));
    const h = useEditStudio.getState().history!;
    expect(h.future).toHaveLength(1);
    expect(h.present).toBe(a);
    useEditStudio.getState().undo();
    expect(useEditStudio.getState().history?.past).toHaveLength(0);
  });

  it("ignores a park for another project", async () => {
    const doc = normalizeProject(fixtureProject());
    useEditStudio.getState().open("p1", "Edit", doc);
    useEditStudio.getState().edit(withClip(doc, "c1", { volume: 1 }));
    await parkForPopOut("video-studio");
    useEditStudio.getState().close();
    useEditStudio.getState().open("p2", "Other", doc);
    await new Promise((r) => setTimeout(r, 20));
    expect(useEditStudio.getState().history?.past).toHaveLength(0);
  });
});
