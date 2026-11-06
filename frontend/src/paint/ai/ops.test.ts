import { describe, expect, it } from "vitest";
import { createObjectSelector, createStampTips, extendCanvasWithFill, maskFromResult, runFillTool, selectSubject } from "./ops";
import { createPerceptionQueue } from "./queue";
import { createFakeAI, createFakeEngine, type FakeAI } from "./testing";
import { createImage } from "./pixels";

function setup(w = 300, h = 300) {
  const engine = createFakeEngine(w, h);
  const ai = createFakeAI();
  const q = createPerceptionQueue(engine, () => "p", ai.deps);
  return { engine, ai, q };
}

/** A responder whose result is a half-transparent-left, opaque-right RGBA. */
function halfCutout(ai: FakeAI): void {
  ai.respond = (_req, src) => {
    const img = createImage(src.width, src.height);
    for (let y = 0; y < src.height; y++) for (let x = src.width / 2; x < src.width; x++) img.data.set([255, 255, 255, 255], (y * src.width + x) * 4);
    return [img];
  };
}

describe("maskFromResult", () => {
  it("reads the gray value of an opaque mask and the alpha of a cut-out", () => {
    const gray = createImage(2, 1);
    gray.data.set([255, 255, 255, 255, 0, 0, 0, 255]);
    expect([...maskFromResult(gray).data].filter((_, i) => i % 4 === 3)).toEqual([255, 0]);
    const rgba = createImage(2, 1);
    rgba.data.set([9, 9, 9, 0, 9, 9, 9, 128]);
    expect([...maskFromResult(rgba).data].filter((_, i) => i % 4 === 3)).toEqual([0, 128]);
  });
});

describe("runFillTool", () => {
  it("skips strokes without a mask and sends fill fields for Dissolve", async () => {
    const { engine, ai, q } = setup();
    expect(await runFillTool(q, engine, "dissolve", {}, { history: 1, bounds: { x: 0, y: 0, w: 1, h: 1 } }, 1)).toBeNull();
    const mask = createImage(20, 20);
    mask.data.fill(255);
    const g = await runFillTool(q, engine, "dissolve", { passes: 2, ghost: 0.3, drift: 0.5, quality: "fast" }, { history: 1, bounds: { x: 100, y: 100, w: 20, h: 20 }, mask }, 9);
    expect(g?.generations.map((x) => x.label)).toEqual(["Original", "Pass 1", "Pass 2", "Final"]);
    expect(ai.requests[0]).toMatchObject({ op: "fill", passes: 2, ghost: 0.3, drift: 0.5, model: "fast", seed: 9 });
  });
});

describe("selectSubject", () => {
  it("turns the cut-out into the selection", async () => {
    const { engine, ai, q } = setup();
    halfCutout(ai);
    await selectSubject(q, engine, {});
    expect(ai.requests[0]!.op).toBe("cutout");
    expect(engine.selected).toHaveLength(1);
    const m = engine.selected[0]!.mask;
    expect(m.data[3]).toBe(0);
    expect(m.data[(m.width - 1) * 4 + 3]).toBe(255);
  });
});

describe("stamp tips", () => {
  it("cuts a layer once and caches the trimmed tip until the layer changes", async () => {
    const { engine, ai, q } = setup();
    halfCutout(ai);
    const tips = createStampTips(q, engine);
    expect(tips.tip("L1")).toBeNull();
    const a = await tips.cut("L1", {});
    expect(a.origin.x).toBe(150);
    expect(a.image.width).toBe(150);
    expect(tips.tip("L1")).toBe(a);
    await tips.cut("L1", {});
    expect(ai.requests).toHaveLength(1);
    engine.paint({ x: 0, y: 0, w: 5, h: 5 }, [1, 1, 1, 255]);
    await tips.cut("L1", {});
    expect(ai.requests).toHaveLength(2);
  });
});

describe("select object", () => {
  it("debounces previews to the latest points and commits the selection", async () => {
    const { engine, ai, q } = setup();
    ai.respond = (_r, src) => {
      const img = createImage(src.width, src.height);
      img.data.fill(255);
      return [img];
    };
    const pending: Array<() => void> = [];
    let cancelled = 0;
    const sel = createObjectSelector(
      q,
      engine,
      {},
      (fn) => {
        pending.push(fn);
        return pending.length - 1;
      },
      () => {
        cancelled++;
        pending.length = 0;
      },
    );
    sel.add({ x: 10, y: 10, positive: true });
    sel.add({ x: 50, y: 50, positive: false });
    expect(cancelled).toBe(1); // the first timer was replaced
    expect(pending).toHaveLength(1);
    expect(ai.requests).toHaveLength(0);
    pending[0]!();
    const done = await sel.commit();
    expect(done).toBe(true);
    expect(ai.requests).toHaveLength(1);
    expect(ai.requests[0]!.points).toEqual([
      { x: 10, y: 10, positive: true },
      { x: 50, y: 50, positive: false },
    ]);
    expect(sel.preview()?.width).toBe(300);
    expect(engine.selected).toHaveLength(1);
  });
  it("commit runs a pending preview straight away", async () => {
    const { engine, ai, q } = setup();
    const sel = createObjectSelector(q, engine, {}, () => 1, () => undefined);
    sel.add({ x: 1, y: 2, positive: true });
    expect(await sel.commit()).toBe(true);
    expect(ai.requests).toHaveLength(1);
  });
});

describe("extendCanvasWithFill", () => {
  it("resizes first and fills the margins band by band", async () => {
    const { engine, ai, q } = setup(300, 200);
    const groups = await extendCanvasWithFill(q, engine, { top: 0, right: 600, bottom: 0, left: 0 }, {}, 3);
    expect(engine.doc.width).toBe(900);
    expect(groups).toHaveLength(2);
    expect(ai.requests).toHaveLength(2);
    expect(engine.writes.map((w) => [w.r.x, w.r.w])).toEqual([
      [300, 512],
      [812, 88],
    ]);
    expect(engine.pixels.data[(100 * 900 + 400) * 4]).toBe(200);
  });
  it("does nothing when no side grows", async () => {
    const { engine, q } = setup();
    expect(await extendCanvasWithFill(q, engine, { top: 0, right: 0, bottom: 0, left: 0 }, {}, 1)).toEqual([]);
  });
});
