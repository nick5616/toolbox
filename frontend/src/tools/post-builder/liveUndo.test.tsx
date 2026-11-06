import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

const h = vi.hoisted(() => ({ remote: null as unknown, posts: [] as unknown[] }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    FilesService: { PickWith: async () => [], PickFolder: async () => "", Stat: async () => [{ exists: true }] },
    PostsService: {
      Get: async () => JSON.parse(JSON.stringify(h.remote)) as unknown,
      List: async () => h.posts,
      Limits: async () => null,
      Save: async (id: string, name: string) => ({ id, kind: "post" as never, name, thumb: "", items: 0, missing: 0, updatedAt: 1 }),
      Check: async () => [],
    },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
    ComposerService: { List: async () => [], LoadImage: async () => "" },
    VideoEditorService: { List: async () => [] },
  };
});

import { newHistory } from "@/lib/history";
import { blankSlide, normalizePost, type PostDoc } from "./logic";
import { LIVE_INTERVAL_MS, reloadedHistory, usePostBuilder, useDoc, withLiveFraming } from "./postStore";
import { applyPostValues, pickPostValues } from "./workspace";

const slide = (id: string, extra: Partial<PostDoc["slides"][number]> = {}) => ({ ...blankSlide("photo", { path: `C:/p/${id}.jpg` }), id, ...extra });

function doc(): PostDoc {
  return { version: 1, format: "carousel", aspect: "4:5", slides: [slide("a"), slide("b")], caption: "", keepLocation: false, folder: "", subfolders: false, extra: [], hidden: [] } as unknown as PostDoc;
}

const s = () => usePostBuilder.getState();

function openPost(d: PostDoc = doc()) {
  usePostBuilder.setState({ ready: true, postId: "p1", loadedId: "p1", name: "Trip", history: newHistory(d), selectedId: "a", saveState: "saved", dirty: false });
}

beforeEach(() => {
  vi.useFakeTimers();
  s().reset();
  h.posts = [{ id: "p1", kind: "post", name: "Trip", thumb: "", items: 2, missing: 0, updatedAt: 1 }];
});

afterEach(() => {
  s().reset();
  vi.useRealTimers();
});

describe("undo survives reloads", () => {
  it("keeps the steps when the loaded post equals the one in memory", () => {
    openPost();
    s().setCaption("Hi");
    s().deleteSlide("b");
    const before = s().history!;
    const same = reloadedHistory(before, true, before.present);
    expect(same).toBe(before);
  });

  it("adds the loaded post as one more step when an editing window changed it, and undo goes back through it", async () => {
    openPost();
    s().setCaption("Hi");
    const remote = { ...s().history!.present, slides: s().history!.present.slides.map((x) => (x.id === "a" ? { ...x, projectId: "c9" } : x)) };
    h.remote = remote;
    await s().reload();
    const hist = s().history!;
    expect(hist.past).toHaveLength(2);
    expect(hist.present.slides[0]?.projectId).toBe("c9");
    expect(s().dirty).toBe(false);
    s().undo();
    expect(s().history?.present.slides[0]?.projectId).not.toBe("c9");
    expect(s().history?.present.caption).toBe("Hi");
    s().undo();
    expect(s().history?.present.caption).toBe("");
  });

  it("keeps the steps after a save round-trip (silent reload of identical data)", async () => {
    openPost();
    s().setCaption("Hi");
    h.remote = s().history!.present;
    const pastBefore = s().history!.past.length;
    await s().reload();
    expect(s().history!.past).toHaveLength(pastBefore);
    s().undo();
    expect(s().history?.present.caption).toBe("");
  });

  it("keeps the steps when the tool comes back (init on the same open post)", async () => {
    openPost();
    s().setCaption("Hi");
    h.remote = s().history!.present;
    await s().init();
    expect(s().history!.past).toHaveLength(1);
    expect(s().postId).toBe("p1");
  });

  it("starts fresh only for a different post", async () => {
    openPost();
    s().setCaption("Hi");
    h.posts = [
      { id: "p1", kind: "post", name: "Trip", thumb: "", items: 2, missing: 0, updatedAt: 1 },
      { id: "p2", kind: "post", name: "Other", thumb: "", items: 2, missing: 0, updatedAt: 1 },
    ];
    h.remote = doc();
    await s().openPost("p2");
    expect(s().postId).toBe("p2");
    expect(s().history?.past).toHaveLength(0);
  });

  it("normalizes loaded data the same way as in memory", () => {
    const d = normalizePost(JSON.parse(JSON.stringify(doc())) as never);
    expect(reloadedHistory(newHistory(d), true, normalizePost(JSON.parse(JSON.stringify(d)) as never)).past).toHaveLength(0);
  });
});

describe("live framing drags", () => {
  it("shows the drag without an undo step or an autosave, then records one step on release", () => {
    openPost();
    s().setLiveFraming({ id: "a", patch: { panX: 0.3 } });
    s().setLiveFraming({ id: "a", patch: { panX: 0.4 } });
    expect(s().history?.past).toHaveLength(0);
    expect(s().dirty).toBe(false);
    s().commitFraming("a", { panX: 0.5 });
    expect(s().liveFraming).toBeNull();
    expect(s().history?.past).toHaveLength(1);
    expect(s().history?.present.slides[0]?.panX).toBe(0.5);
    s().undo();
    expect(s().history?.present.slides[0]?.panX).toBe(0);
  });

  it("the document on screen has the drag applied", () => {
    openPost();
    const out = withLiveFraming(s().history!.present, { id: "b", patch: { zoom: 2 } });
    expect(out?.slides[1]?.zoom).toBe(2);
    expect(out?.slides[0]).toBe(s().history!.present.slides[0]);
    let seen: PostDoc | null = null;
    function Probe() {
      seen = useDoc();
      return null;
    }
    render(<Probe />);
    act(() => s().setLiveFraming({ id: "a", patch: { zoom: 3 } }));
    expect((seen as PostDoc | null)?.slides[0]?.zoom).toBe(3);
  });

  it("mirrors the drag to the bridge at about 30 fps and clears it on release", () => {
    openPost();
    vi.setSystemTime(new Date(2026, 0, 1));
    const out = () => pickPostValues(s()).liveFraming;
    s().setLiveFraming({ id: "a", patch: { panX: 0.1 } });
    expect(out()?.patch.panX).toBe(0.1); // the first move goes out at once
    s().setLiveFraming({ id: "a", patch: { panX: 0.2 } });
    s().setLiveFraming({ id: "a", patch: { panX: 0.3 } });
    expect(out()?.patch.panX).toBe(0.1); // throttled
    vi.advanceTimersByTime(LIVE_INTERVAL_MS);
    expect(out()?.patch.panX).toBe(0.3);
    s().commitFraming("a", { panX: 0.4 });
    expect(out()).toBeNull();
  });

  it("a replica shows the host's drag and drops it when the host records it", () => {
    openPost();
    const replica = usePostBuilder;
    const values = { ...pickPostValues(s()), liveFraming: { id: "a", patch: { zoom: 2 } } };
    applyPostValues(replica, { liveFraming: values.liveFraming });
    expect(s().liveFraming?.patch.zoom).toBe(2);
    applyPostValues(replica, { liveFraming: null });
    expect(s().liveFraming).toBeNull();
  });
});
