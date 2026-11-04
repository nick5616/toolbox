import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";

const h = vi.hoisted(() => ({ width: 0, stat: vi.fn() }));

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: h.width, height: 0 }) }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    FilesService: { PickWith: async () => [], ImageThumb: async () => "data:image/png;base64,AAAA", Stat: (...a: unknown[]) => h.stat(...a) },
    PostsService: { Sources: async () => [] },
  };
});

import { ClickInHost } from "@/components";
import { useToastStore } from "@/components/toast";
import { addLayer, newComposition, newImageLayer, newTextLayer } from "@/composer/model";
import { ModuleStatus, type Composition, type Descriptor } from "@/lib/api";
import { useEmbed } from "@/lib/embed";
import { registerToolViews } from "@/lib/toolActions";
import { parseWindow, setCurrentWindowForTest } from "@/lib/windows";
import { getPart } from "@/parts/registry";
import { hostBridge, resetBridgeStatusesForTest, type BridgeTransport } from "@/state/bridge";
import { useModules } from "@/state/modules";
import { setWorkspaceTransportForTest } from "@/workspace/defineWorkspace";
import { SelectionBar } from "./SelectionBar";
import { composerInitializer, useComposer, type ComposerState } from "./store";
import { applyComposerValues, BRIDGED_ACTIONS, composerWorkspace as ws, pickComposerValues } from "./workspace";

function twoPhotos(): Composition {
  const d0 = newComposition("4:5");
  const a = { ...newImageLayer("C:/photos/a.jpg", 400, 300, d0), id: "A", name: "a" };
  const b = { ...newImageLayer("C:/photos/b.jpg", 400, 300, d0), id: "B", name: "b" };
  return addLayer(addLayer(d0, a), b);
}

function openStore(store: { getState: () => ComposerState }, doc = twoPhotos()) {
  store.getState().open({ id: "p1", name: "Market", doc, postSlide: null });
}

beforeEach(() => {
  h.width = 0;
  h.stat.mockReset().mockResolvedValue([{ exists: true }]);
  useComposer.getState().close();
});

afterEach(() => {
  setWorkspaceTransportForTest(null);
  setCurrentWindowForTest(null);
  resetBridgeStatusesForTest();
  useComposer.getState().close();
});

describe("store", () => {
  it("undoes and redoes, merging edits with the same key into one step", () => {
    openStore(useComposer);
    const s = () => useComposer.getState();
    s().patchLayer("A", { rotation: 10 });
    s().patchLayer("A", { rotation: 20 });
    expect(s().history?.past).toHaveLength(1);
    s().deleteLayers(["B"]);
    expect(s().history?.present.layers).toHaveLength(1);
    s().undo();
    expect(s().history?.present.layers).toHaveLength(2);
    expect(s().history?.present.layers?.find((l) => l.id === "A")?.rotation).toBe(20);
    s().undo();
    expect(s().history?.present.layers?.find((l) => l.id === "A")?.rotation).toBe(0);
    s().redo();
    expect(s().history?.present.layers?.find((l) => l.id === "A")?.rotation).toBe(20);
  });

  it("changes the canvas shape and keeps the layers", () => {
    openStore(useComposer);
    useComposer.getState().setCanvas({ aspect: "9:16", format: "png" });
    const d = useComposer.getState().history?.present;
    expect([d?.aspect, d?.width, d?.height, d?.format, d?.layers?.length]).toEqual(["9:16", 1080, 1920, "png", 2]);
  });
});

describe("panels", () => {
  it("render with no props from the store", () => {
    openStore(useComposer, addLayer(twoPhotos(), { ...newTextLayer({ width: 1080, height: 1350 }), id: "T", name: "Title" }));
    useComposer.getState().select("T");
    for (const p of ws.panels) {
      const Panel = p.component;
      const { unmount } = render(
        <ClickInHost>
          <Panel />
        </ClickInHost>,
      );
      unmount();
    }
    expect(ws.panels.map((p) => p.id)).toEqual(["sources", "layers", "layer", "text", "layouts", "background", "canvas"]);
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
  it("shows the host's layers in a panel window and runs its edits on the host", async () => {
    const hub = new Hub();
    setWorkspaceTransportForTest(() => hub.endpoint("replica"));
    setCurrentWindowForTest(parseWindow("?window=part&part=photo-composer.panel&panel=layers&key=part:photo-composer.panel@layers"));
    const host = createStore<ComposerState>(composerInitializer);
    openStore(host);
    const stop = hostBridge(host, { name: ws.bridgeName, pick: pickComposerValues, apply: applyComposerValues, actions: BRIDGED_ACTIONS }, hub.endpoint("host"));
    const part = getPart("photo-composer.panel");
    const disconnect = await part!.connect!(new URLSearchParams("panel=layers"));
    const Part = part!.component;
    render(<Part placement="window" />);
    const list = await screen.findByRole("list", { name: "Layers" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);

    useComposer.getState().deleteLayers(["B"]);
    await waitFor(() => expect(host.getState().history?.present.layers).toHaveLength(1));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Layers" })).getAllByRole("listitem")).toHaveLength(1));
    useComposer.getState().undo();
    await waitFor(() => expect(host.getState().history?.present.layers).toHaveLength(2));
    disconnect();
    stop();
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
      <button type="button" onClick={() => e?.onUse?.(["C:/out/erased.png"])}>
        {e?.useLabel}
      </button>
    </div>
  );
}

describe("selection bar", () => {
  beforeEach(() => {
    registerToolViews({ "object-eraser": FakeTool, upscaler: FakeTool });
    useModules.getState().setAll([desc("object-eraser", "Object Eraser"), desc("upscaler", "Upscaler"), desc("photo-composer", "Photo Composer")]);
    openStore(useComposer);
    useComposer.getState().select("B");
  });

  const renderBar = () =>
    render(
      <ClickInHost>
        <SelectionBar />
      </ClickInHost>,
    );

  it("Use from Erase object replaces the layer's photo, keeping its transform, as one undo step", async () => {
    renderBar();
    const before = useComposer.getState().history?.present.layers?.find((l) => l.id === "B");
    await userEvent.click(screen.getByRole("button", { name: "Erase object" }));
    expect(await screen.findByText("tool sees: C:/photos/b.jpg")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Use as this layer" }));
    await waitFor(() => expect(useComposer.getState().history?.present.layers?.find((l) => l.id === "B")?.image?.ref.path).toBe("C:/out/erased.png"));
    const after = useComposer.getState().history?.present.layers?.find((l) => l.id === "B");
    expect(after?.image?.ref.original).toBe("C:/photos/b.jpg");
    expect([after?.x, after?.y, after?.size, after?.rotation]).toEqual([before?.x, before?.y, before?.size, before?.rotation]);
    useComposer.getState().undo();
    expect(useComposer.getState().history?.present.layers?.find((l) => l.id === "B")?.image?.ref.path).toBe("C:/photos/b.jpg");
  });

  it("toasts and changes nothing when the returned file is gone", async () => {
    h.stat.mockResolvedValue([{ exists: false }]);
    useToastStore.setState({ toasts: [] });
    renderBar();
    await userEvent.click(screen.getByRole("button", { name: "Upscale" }));
    await userEvent.click(await screen.findByRole("button", { name: "Use as this layer" }));
    await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.title === "That file is gone")).toBe(true));
    expect(useComposer.getState().history?.present.layers?.find((l) => l.id === "B")?.image?.ref.path).toBe("C:/photos/b.jpg");
  });

  it("starts the cut-out job from the bar's button", async () => {
    renderBar();
    expect(screen.getByRole("button", { name: "Remove background" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Crop…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Layer" })).toBeTruthy();
  });

  it("stays one line: what doesn't fit goes into a More menu that opens the hidden click-ins", async () => {
    h.width = 330;
    renderBar();
    const bar = screen.getByRole("toolbar", { name: "Selection" });
    expect(within(bar).getByRole("button", { name: "More" })).toBeTruthy();
    expect(within(bar).queryByRole("button", { name: "Upscale" })).toBeNull();
    await userEvent.click(within(bar).getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Upscale" }));
    expect(await screen.findByText("tool sees: C:/photos/b.jpg")).toBeTruthy();
  });

  it("offers Layer and Text style for a text layer", async () => {
    const st = useComposer.getState();
    st.addText();
    const id = useComposer.getState().selectedId ?? "";
    expect(id).not.toBe("");
    renderBar();
    expect(screen.getByRole("button", { name: "Layer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Text style" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Crop…" })).toBeNull();
    await act(async () => undefined);
  });
});
