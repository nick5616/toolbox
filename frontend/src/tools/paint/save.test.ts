import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaintDoc } from "@/lib/api";
import { Saver, type SaverApi } from "./save";
import { EMPTY_TILES, FakeEngine } from "./testing/fakeEngine";
import { sampleDoc } from "./testing/env";
import type { ToolState } from "@/paint/engine/types";
import { FAKE_BRUSHES } from "./testing/fakes";

async function loaded(): Promise<FakeEngine> {
  const e = new FakeEngine();
  await e.load(sampleDoc(2) as PaintDoc, EMPTY_TILES);
  return e;
}

const tool = (): ToolState => ({ kind: "brush", brush: FAKE_BRUSHES[0]!, color: { r: 0, g: 0, b: 0, a: 1 }, secondary: { r: 1, g: 1, b: 1, a: 1 }, seed: 1 });
const pt = (x: number, y: number) => ({ x, y, pressure: 1, tiltX: 0, tiltY: 0, twist: 0, t: 0, pointer: "mouse" as const });

function api() {
  const calls: string[] = [];
  const a: SaverApi & { calls: string[]; docs: PaintDoc[]; tileBatches: Array<{ layer: string; keys: string[]; removed: string[] }> } = {
    calls,
    docs: [],
    tileBatches: [],
    SaveTiles: vi.fn(async (_id, layer, tiles, removed) => {
      calls.push("tiles");
      a.tileBatches.push({ layer, keys: Object.keys(tiles), removed });
    }),
    SaveDoc: vi.fn(async (_id, _name, doc) => {
      calls.push("doc");
      a.docs.push(doc);
    }),
    SaveThumb: vi.fn(async () => {
      calls.push("thumb");
    }),
  };
  return a;
}

afterEach(() => vi.useRealTimers());

describe("Saver", () => {
  it("sends dirty tiles, then the document, then the thumbnail, in that order", async () => {
    const engine = await loaded();
    const a = api();
    const states: string[] = [];
    const saver = new Saver({ engine, projectId: "p1", getName: () => "Sunset", getGuides: () => "", onState: (s) => states.push(s), api: a, thumbs: async () => ({ jpeg: "data:image/jpeg;base64,AA", png: "data:image/png;base64,AA" }), toDataURL: async () => "data:image/png;base64,AA" });
    saver.start();
    engine.beginStroke(tool(), pt(600, 100));
    engine.extendStroke([pt(700, 120)], []);
    engine.endStroke();
    expect(engine.dirtyTiles().get("L2")?.size).toBeGreaterThan(0);
    await saver.flush();
    expect(a.calls).toEqual(["tiles", "doc", "thumb"]);
    expect(a.tileBatches[0]?.layer).toBe("L2");
    expect(a.tileBatches[0]?.keys).toContain("1_0");
    // The document lists the tiles that now exist and bumps the layer's rev.
    const l2 = a.docs[0]?.layers?.find((l) => l.id === "L2");
    expect(l2?.tiles).toContain("1_0");
    expect(l2?.rev).toBe(1);
    expect(a.docs[0]?.layers?.find((l) => l.id === "L1")?.rev).toBe(0);
    // Saved tiles are no longer dirty, and the last state is "saved".
    expect(engine.dirtyTiles().size).toBe(0);
    expect(states[states.length - 1]).toBe("saved");
    saver.dispose();
  });

  it("autosaves 2 seconds after the last change, and each change restarts the wait", async () => {
    vi.useFakeTimers();
    const engine = await loaded();
    const a = api();
    const saver = new Saver({ engine, projectId: "p1", getName: () => "x", getGuides: () => "", onState: () => undefined, api: a, thumbs: async () => ({ jpeg: "", png: "" }), toDataURL: async () => "data:," });
    saver.start();
    engine.setLayer("L1", { opacity: 0.5 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(a.calls).toEqual([]);
    engine.setLayer("L1", { opacity: 0.4 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(a.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(600);
    expect(a.calls).toEqual(["doc"]); // a property change saves the document only (no pixels, no thumbnail)
    expect(a.docs[0]?.layers?.[0]?.opacity).toBe(0.4);
    saver.dispose();
  });

  it("splits tiles into batches of about 1 MiB", async () => {
    const engine = await loaded();
    const a = api();
    const big = "data:image/png;base64," + "A".repeat(600_000);
    const saver = new Saver({ engine, projectId: "p1", getName: () => "x", getGuides: () => "", onState: () => undefined, api: a, thumbs: async () => ({ jpeg: "", png: "" }), toDataURL: async () => big });
    saver.start();
    engine.beginStroke(tool(), pt(100, 100));
    engine.extendStroke([pt(1900, 1000)], []);
    engine.endStroke();
    const tiles = engine.dirtyTiles().get("L2")?.size ?? 0;
    expect(tiles).toBeGreaterThan(2);
    await saver.flush();
    expect(a.tileBatches.length).toBeGreaterThan(1);
    expect(a.tileBatches.reduce((n, b) => n + b.keys.length, 0)).toBe(tiles);
    expect(a.tileBatches.every((b) => b.keys.length <= 1)).toBe(true); // each ~600 KB tile fills a batch
    expect(a.calls[a.calls.length - 1]).toBe("doc");
    saver.dispose();
  });

  it("reports an error, keeps the tiles dirty, and a retry saves them", async () => {
    const engine = await loaded();
    const a = api();
    let fail = true;
    a.SaveTiles = vi.fn(async () => {
      if (fail) throw new Error("disk full");
      a.calls.push("tiles");
    });
    const states: Array<[string, string]> = [];
    const saver = new Saver({ engine, projectId: "p1", getName: () => "x", getGuides: () => "", onState: (s, e) => states.push([s, e]), api: a, thumbs: async () => ({ jpeg: "", png: "" }), toDataURL: async () => "data:," });
    saver.start();
    engine.beginStroke(tool(), pt(10, 10));
    engine.extendStroke([pt(40, 40)], []);
    engine.endStroke();
    await expect(saver.flush()).rejects.toThrow("disk full");
    expect(states[states.length - 1]).toEqual(["error", "disk full"]);
    expect(engine.dirtyTiles().size).toBeGreaterThan(0);
    expect(a.calls).not.toContain("doc"); // the document is never saved ahead of its tiles
    fail = false;
    await saver.flush();
    expect(a.calls).toEqual(["tiles", "doc"]);
    expect(engine.dirtyTiles().size).toBe(0);
    saver.dispose();
  });

  it("saves the guides JSON in the document", async () => {
    const engine = await loaded();
    const a = api();
    const saver = new Saver({ engine, projectId: "p1", getName: () => "x", getGuides: () => '{"symmetry":"vertical"}', onState: () => undefined, api: a, thumbs: async () => ({ jpeg: "", png: "" }), toDataURL: async () => "data:," });
    saver.start();
    await saver.flush();
    expect(a.docs[0]?.guides).toBe('{"symmetry":"vertical"}');
    saver.dispose();
  });
});
