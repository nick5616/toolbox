import { beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => new Map<string, string>());
const h = vi.hoisted(() => ({ remote: null as unknown }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    FilesService: { PickWith: async () => [], PickFolder: async () => "", Stat: async () => [{ exists: true }] },
    PostsService: {
      Get: async () => JSON.parse(JSON.stringify(h.remote)) as unknown,
      List: async () => [{ id: "p1", kind: "post", name: "Trip", thumb: "", items: 2, missing: 0, updatedAt: 1 }],
      Limits: async () => null,
      Save: async (id: string, name: string) => ({ id, kind: "post" as never, name, thumb: "", items: 0, missing: 0, updatedAt: 1 }),
      Check: async () => [],
    },
    SettingsService: {
      ModuleState: async (k: string) => saved.get(k) ?? "",
      SetModuleState: async (k: string, v: string) => {
        saved.set(k, v);
      },
    },
    ComposerService: { List: async () => [], LoadImage: async () => "" },
    VideoEditorService: { List: async () => [] },
  };
});

import { newHistory } from "@/lib/history";
import { parkForPopOut, resetParkedHistoryForTest } from "@/lib/parkedHistory";
import { blankSlide, type PostDoc } from "./logic";
import { usePostBuilder } from "./postStore";

const slide = (id: string) => ({ ...blankSlide("photo", { path: `C:/p/${id}.jpg` }), id });
const doc = (): PostDoc => ({ version: 1, format: "carousel", aspect: "4:5", slides: [slide("a"), slide("b")], caption: "", keepLocation: false, folder: "", subfolders: false, extra: [], hidden: [] }) as unknown as PostDoc;
const s = () => usePostBuilder.getState();

beforeEach(() => {
  saved.clear();
  resetParkedHistoryForTest();
  s().reset();
});

describe("Post Builder undo history across a pop-out", () => {
  it("round-trips through park and take", async () => {
    usePostBuilder.setState({ ready: true, postId: "p1", loadedId: "p1", name: "Trip", history: newHistory(doc()), selectedId: "a", saveState: "saved", dirty: false });
    s().setCaption("Hello");
    s().deleteSlide("b");
    const steps = s().history!.past.length;
    expect(steps).toBeGreaterThanOrEqual(2);
    const present = s().history!.present;
    await parkForPopOut("post-builder");
    // The new window reloads the saved post; its history starts empty.
    h.remote = JSON.parse(JSON.stringify(present));
    s().reset();
    await s().openPost("p1");
    await vi.waitFor(() => expect(s().history?.past.length).toBe(steps));
    s().undo();
    expect(s().history?.present.slides).toHaveLength(2);
  });

  it("ignores a park for another post", async () => {
    usePostBuilder.setState({ ready: true, postId: "p1", loadedId: "p1", name: "Trip", history: newHistory(doc()), selectedId: "a", saveState: "saved", dirty: false });
    s().setCaption("Hello");
    await parkForPopOut("post-builder");
    h.remote = doc();
    s().reset();
    await s().openPost("p2");
    await new Promise((r) => setTimeout(r, 20));
    expect(s().history?.past ?? []).toHaveLength(0);
  });
});
