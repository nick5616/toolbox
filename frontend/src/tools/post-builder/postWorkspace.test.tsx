import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";

const h = vi.hoisted(() => ({ width: 0, stat: vi.fn() }));

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: h.width, height: 0 }) }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    FilesService: { PickWith: async () => [], PickFolder: async () => "", ImageThumb: async () => "data:image/png;base64,AAAA", Stat: (...a: unknown[]) => h.stat(...a) },
    PostsService: {
      Sources: async () => [],
      Save: async (id: string, name: string) => ({ id, kind: "post" as never, name, thumb: "", items: 0, missing: 0, updatedAt: 1 }),
      Check: async () => [],
    },
    ComposerService: { LoadImage: async () => "", List: async () => [] },
    MediaService: { Frame: async () => "" },
  };
});

import { ClickInHost } from "@/components";
import { useToastStore } from "@/components/toast";
import { ModuleStatus, type Descriptor } from "@/lib/api";
import { newHistory } from "@/lib/history";
import { useEmbed } from "@/lib/embed";
import { registerToolViews } from "@/lib/toolActions";
import { parseWindow, setCurrentWindowForTest } from "@/lib/windows";
import { getPart } from "@/parts/registry";
import { hostBridge, resetBridgeStatusesForTest, type BridgeTransport } from "@/state/bridge";
import { useModules } from "@/state/modules";
import { setWorkspaceTransportForTest } from "@/workspace/defineWorkspace";
import { blankSlide, type PostDoc } from "./logic";
import { SelectionBar } from "./SelectionBar";
import { postInitializer, usePostBuilder, type PostState } from "./postStore";
import { applyPostValues, BRIDGED_ACTIONS, pickPostValues, postWorkspace as ws } from "./workspace";

const slide = (id: string, extra: Partial<PostDoc["slides"][number]> = {}) => ({ ...blankSlide("photo", { path: `C:/p/${id}.jpg`, zoom: 1.5, panX: 0.1 }), id, ...extra });

function doc(): PostDoc {
  return { version: 1, format: "carousel", aspect: "4:5", slides: [slide("a"), slide("b")], caption: "", keepLocation: false, folder: "", subfolders: false, extra: [], hidden: [] } as unknown as PostDoc;
}

function openPost(store: { setState: (p: Partial<PostState>) => void } = usePostBuilder, d: PostDoc = doc()) {
  store.setState({ ready: true, postId: "p1", loadedId: "p1", name: "Trip", history: newHistory(d), selectedId: "b", saveState: "saved", dirty: false });
}

beforeEach(() => {
  h.width = 0;
  h.stat.mockReset().mockResolvedValue([{ exists: true }]);
  usePostBuilder.getState().reset();
});

afterEach(() => {
  setWorkspaceTransportForTest(null);
  setCurrentWindowForTest(null);
  resetBridgeStatusesForTest();
  usePostBuilder.getState().reset();
});

describe("store", () => {
  it("undoes and redoes, merging same-field edits into one step", () => {
    openPost();
    const s = () => usePostBuilder.getState();
    s().setCaption("Hel");
    s().setCaption("Hello");
    expect(s().history?.past).toHaveLength(1);
    s().deleteSlide("a");
    expect(s().history?.present.slides).toHaveLength(1);
    expect(s().selectedId).toBe("b");
    s().undo();
    expect(s().history?.present.slides).toHaveLength(2);
    s().undo();
    expect(s().history?.present.caption).toBe("");
    s().redo();
    expect(s().history?.present.caption).toBe("Hello");
    expect(s().saveState).toBe("dirty");
  });
});

describe("panels", () => {
  it("render with no props from the store", () => {
    openPost();
    usePostBuilder.setState({ posts: [{ id: "p1", kind: "post" as never, name: "Trip", thumb: "", items: 2, missing: 0, updatedAt: 1, flags: [] }] });
    for (const p of ws.panels) {
      const Panel = p.component;
      const { unmount } = render(
        <ClickInHost>
          <Panel />
        </ClickInHost>,
      );
      unmount();
    }
    expect(ws.panels.map((p) => p.id)).toEqual(["posts", "sources", "format", "caption", "framing", "trim", "alt", "checks"]);
    expect(ws.previewPart).toBe("post-builder.preview");
  });
});

/** An in-memory relay (see workspace/workspace.test.tsx). */
class Hub {
  subs = new Map<string, Set<(p: unknown, from: string) => void>>();
  endpoint(key: string): BridgeTransport {
    return {
      send: (payload, to = "") => {
        const wire = JSON.parse(JSON.stringify(payload)) as unknown;
        for (const [k, set] of this.subs) {
          if (k === key || (to && to !== k)) continue;
          for (const cb of [...set]) cb(wire, key);
        }
      },
      on: (cb) => {
        const set = this.subs.get(key) ?? new Set();
        set.add(cb);
        this.subs.set(key, set);
        return () => set.delete(cb);
      },
    };
  }
}

describe("bridge", () => {
  it("shows the host's caption in a panel window and runs its edits on the host", async () => {
    const hub = new Hub();
    setWorkspaceTransportForTest(() => hub.endpoint("replica"));
    setCurrentWindowForTest(parseWindow("?window=part&part=post-builder.panel&panel=caption&key=part:post-builder.panel@caption"));
    const host = createStore<PostState>(postInitializer);
    openPost(host);
    const stop = hostBridge(host, { name: ws.bridgeName, pick: pickPostValues, apply: applyPostValues, actions: BRIDGED_ACTIONS }, hub.endpoint("host"));
    const part = getPart("post-builder.panel")!;
    const disconnect = await part.connect!(new URLSearchParams("panel=caption"));
    const Part = part.component;
    render(<Part placement="window" />);
    const box = await screen.findByRole("textbox", { name: "Caption" });
    await userEvent.click(box);
    await userEvent.paste("Hi #one");
    await waitFor(() => expect(host.getState().history?.present.caption).toBe("Hi #one"));
    host.getState().undo();
    await waitFor(() => expect(host.getState().history?.present.caption).toBe(""));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Caption" }) as HTMLTextAreaElement).value).toBe(""));
    disconnect();
    stop();
  });

  it("round-trips the document through pick and apply", () => {
    openPost();
    const replica = createStore<PostState>(() => ({}) as PostState);
    applyPostValues(replica, pickPostValues(usePostBuilder.getState()));
    expect(replica.getState().history?.present.slides).toHaveLength(2);
    expect(replica.getState().selectedId).toBe("b");
    expect(replica.getState().postId).toBe("p1");
  });
});

function desc(id: string, name: string): Descriptor {
  return { id, name, icon: "box", status: ModuleStatus.StatusReady, accepts: { extensions: [], urls: false, any: false } } as unknown as Descriptor;
}

function FakeTool() {
  const e = useEmbed();
  return (
    <div>
      <p>tool sees: {e?.handoff.inputs.join(",")}</p>
      <button type="button" onClick={() => e?.onUse?.(["C:/out/result.png"])}>
        {e?.useLabel}
      </button>
    </div>
  );
}

describe("selection bar", () => {
  beforeEach(() => {
    registerToolViews({ "bg-remover": FakeTool, upscaler: FakeTool });
    useModules.getState().setAll([desc("bg-remover", "Background Remover"), desc("upscaler", "Upscaler"), desc("post-builder", "Post Builder")]);
    openPost();
  });

  const renderBar = () =>
    render(
      <ClickInHost>
        <SelectionBar />
      </ClickInHost>,
    );

  it("Use from Remove background replaces the slide's photo, keeping its framing, as one undo step", async () => {
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: "Remove background" }));
    expect(await screen.findByText("tool sees: C:/p/b.jpg")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Use for this slide" }));
    const b = () => usePostBuilder.getState().history?.present.slides.find((s) => s.id === "b");
    await waitFor(() => expect(b()?.path).toBe("C:/out/result.png"));
    expect([b()?.zoom, b()?.panX]).toEqual([1.5, 0.1]);
    usePostBuilder.getState().undo();
    expect(b()?.path).toBe("C:/p/b.jpg");
  });

  it("toasts and changes nothing when the returned file is gone", async () => {
    h.stat.mockResolvedValue([{ exists: false }]);
    useToastStore.setState({ toasts: [] });
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: "Upscale" }));
    await userEvent.click(await screen.findByRole("button", { name: "Use for this slide" }));
    await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.title === "That file is gone")).toBe(true));
    expect(usePostBuilder.getState().history?.present.slides.find((s) => s.id === "b")?.path).toBe("C:/p/b.jpg");
  });

  it("offers Framing and Alt text, and no Remove background for a clip slide", () => {
    usePostBuilder.getState().patchSlide("b", { kind: "clip" });
    renderBar();
    expect(screen.getByRole("button", { name: "Framing" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Alt text" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Trim" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove background" })).toBeNull();
  });

  it("stays one line: what doesn't fit goes into a More menu that opens the hidden click-ins", async () => {
    h.width = 330;
    renderBar();
    const bar = screen.getByRole("toolbar", { name: "Selection" });
    expect(within(bar).getByRole("button", { name: "More" })).toBeTruthy();
    expect(within(bar).queryByRole("button", { name: "Upscale" })).toBeNull();
    await userEvent.click(within(bar).getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Upscale" }));
    expect(await screen.findByText("tool sees: C:/p/b.jpg")).toBeTruthy();
  });
});
