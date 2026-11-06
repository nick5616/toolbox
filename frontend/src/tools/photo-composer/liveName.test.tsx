import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, FilesService: { PickWith: async () => [], Stat: async () => [{ exists: true }] } };
});

import { addLayer, newComposition, newImageLayer } from "@/composer/model";
import type { Composition } from "@/lib/api";
import { layerNameFromPath, nameAfterSourceChange } from "./logic";
import { composerInitializer, LIVE_INTERVAL_MS, type ComposerState } from "./store";
import { applyComposerValues, pickComposerValues } from "./workspace";

function docWith(name: string, path = "C:/photos/b.jpg"): Composition {
  const d0 = newComposition("4:5");
  return addLayer(d0, { ...newImageLayer(path, 400, 300, d0), id: "B", name });
}

const layer = (st: { getState: () => ComposerState }) => st.getState().history?.present.layers?.find((l) => l.id === "B");

describe("layer names follow Use", () => {
  it("derives names like a new layer", () => {
    expect(layerNameFromPath("C:\\x\\Sunset.final.png")).toBe("Sunset.final");
    expect(nameAfterSourceChange("b", "C:/photos/b.jpg", "", "C:/out/erased.png")).toBe("erased");
    expect(nameAfterSourceChange("My hero shot", "C:/photos/b.jpg", "", "C:/out/erased.png")).toBe("My hero shot");
    // A cut-out keeps the name of the original it came from.
    expect(nameAfterSourceChange("b", "C:/cache/b-cutout.png", "C:/photos/b.jpg", "C:/out/up.png")).toBe("up");
  });

  it("renames the layer with its image in one undo step", async () => {
    const st = createStore<ComposerState>(composerInitializer);
    st.getState().open({ id: "p1", name: "M", doc: docWith("b"), postSlide: null });
    await st.getState().replaceSource("B", "C:/out/erased.png");
    expect(layer(st)?.image?.ref.path).toBe("C:/out/erased.png");
    expect(layer(st)?.name).toBe("erased");
    expect(st.getState().history?.past).toHaveLength(1);
    st.getState().undo();
    expect(layer(st)?.image?.ref.path).toBe("C:/photos/b.jpg");
    expect(layer(st)?.name).toBe("b");
  });

  it("keeps a name the user chose", async () => {
    const st = createStore<ComposerState>(composerInitializer);
    st.getState().open({ id: "p1", name: "M", doc: docWith("Cover photo"), postSlide: null });
    await st.getState().replaceSource("B", "C:/out/erased.png");
    expect(layer(st)?.name).toBe("Cover photo");
  });
});

describe("live drags reach pop-outs", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("mirrors the drag at about 30 fps, adds no undo step, and clears on commit", () => {
    vi.setSystemTime(new Date(2026, 0, 1));
    const st = createStore<ComposerState>(composerInitializer);
    st.getState().open({ id: "p1", name: "M", doc: docWith("b"), postSlide: null });
    const moved = (x: number): Composition => ({ ...st.getState().history!.present, layers: st.getState().history!.present.layers!.map((l) => ({ ...l, x })) });
    const out = () => pickComposerValues(st.getState()).live;
    st.getState().setLive(moved(0.2));
    expect(out()?.layers?.[0]?.x).toBe(0.2);
    st.getState().setLive(moved(0.3));
    st.getState().setLive(moved(0.4));
    expect(out()?.layers?.[0]?.x).toBe(0.2);
    vi.advanceTimersByTime(LIVE_INTERVAL_MS);
    expect(out()?.layers?.[0]?.x).toBe(0.4);
    expect(st.getState().history?.past).toHaveLength(0);
    expect(st.getState().saveState).toBe("idle");
    st.getState().commit(moved(0.5), "drag");
    expect(out()).toBeNull();
    expect(st.getState().history?.past).toHaveLength(1);
  });

  it("a replica applies the live drag and drops it again", () => {
    const rep = createStore<ComposerState>(composerInitializer);
    rep.getState().open({ id: "p1", name: "M", doc: docWith("b"), postSlide: null });
    const d = docWith("b");
    applyComposerValues(rep, { live: d });
    expect(rep.getState().live).toBe(d);
    applyComposerValues(rep, { live: null });
    expect(rep.getState().live).toBeNull();
  });
});
