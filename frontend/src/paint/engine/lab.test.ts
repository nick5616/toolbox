import { describe, expect, it } from "vitest";
import { ALGORITHMIC_TOOLS } from "../lab/index";
import type { LabContext, LabTool } from "../lab/types";
import type { LabContextExt } from "../lab/ext";
import { getLabTool, listLabTools, registerLabTool } from "./lab-registry";
import { RED, line, pt, testBrush, testEngine } from "./testing";
import { makeImageData } from "./pixels";
import type { ToolState } from "./types";

const labTool = (id: string, params = {}): ToolState => ({ kind: "lab", toolId: id, brush: testBrush({ size: 8 }), color: RED, params, seed: 42 });

function fake(id: string, hooks: Partial<LabTool> & { onFlush?: () => Promise<void> } = {}): LabTool & { flush(): Promise<void>; calls: string[] } {
  const calls: string[] = [];
  const t = {
    id,
    label: id,
    description: "",
    kind: "algorithmic" as const,
    predictability: "exact" as const,
    origin: { kind: "algorithm" as const, text: "" },
    params: [],
    icon: "",
    calls,
    onStrokeBegin(ctx: LabContext, p: ReturnType<typeof pt>) {
      calls.push("begin");
      ctx.dab([p]);
    },
    onStrokeExtend(ctx: LabContext, pts: ReturnType<typeof pt>[]) {
      calls.push("extend");
      ctx.dab(pts);
    },
    onStrokeEnd() {
      calls.push("end");
    },
    async flush() {
      await hooks.onFlush?.();
      calls.push("flush");
    },
    ...hooks,
  };
  registerLabTool(t as LabTool);
  return t as LabTool & { flush(): Promise<void>; calls: string[] };
}

describe("Lab routing", () => {
  it("the algorithmic tools are registered with the engine", () => {
    for (const t of ALGORITHMIC_TOOLS) expect(getLabTool(t.id)).toBe(t);
    expect(listLabTools().length).toBeGreaterThanOrEqual(ALGORITHMIC_TOOLS.length);
  });

  it("dab draws with the current brush and the stroke commits after flush", async () => {
    const t = fake("t-dab");
    const e = await testEngine(64, 64);
    e.beginStroke(labTool("t-dab"), pt(10, 32));
    e.extendStroke(line(10, 32, 50, 32).slice(1), []);
    const res = await e.endStrokeAsync();
    expect(t.calls).toEqual(["begin", "extend", "end", "flush"]);
    expect(res.history).not.toBeNull();
    expect(e.readPixels({ x: 30, y: 32, w: 1, h: 1 }, "layer").data[3]).toBeGreaterThan(200);
    expect(e.undo()).toBe(true);
    expect(e.readPixels({ x: 30, y: 32, w: 1, h: 1 }, "layer").data[3]).toBe(0);
  });

  it("sync endStroke defers a Lab commit until the tool has flushed", async () => {
    let release: () => void = () => undefined;
    fake("t-slow", { onFlush: () => new Promise<void>((r) => (release = r)) });
    const e = await testEngine(64, 64);
    e.beginStroke(labTool("t-slow"), pt(10, 32));
    const sync = e.endStroke();
    expect(sync.history).toBeNull();
    expect(e.history()).toHaveLength(0);
    // Meanwhile the preview shows the pending paint.
    expect(e.readComposite()[(32 * 64 + 10) * 4 + 3]).toBeGreaterThan(0);
    release();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(e.history()).toHaveLength(1);
  });

  it("ticks `step` until it returns false", async () => {
    const seen: number[] = [];
    fake("t-step", { step: (_c, tick) => (seen.push(tick), tick < 4) });
    const e = await testEngine(32, 32);
    e.beginStroke(labTool("t-step"), pt(8, 8));
    await e.endStrokeAsync();
    expect(seen).toEqual([0, 1, 2, 3, 4]);
  });

  it("gives tools the context extras: rng, snapshot (off-canvas), composite with a mask weight, clearScratch, brush info", async () => {
    let ctxSeen: (LabContext & LabContextExt) | null = null;
    fake("t-ctx", {
      onStrokeBegin(ctx) {
        ctxSeen = ctx as LabContext & LabContextExt;
      },
    });
    const e = await testEngine(32, 32);
    e.beginStroke(labTool("t-ctx", { a: 1 }), pt(8, 8));
    const c = ctxSeen as unknown as LabContext & LabContextExt;
    expect(c.rng("k")()).toBe(c.rng("k")());
    expect(c.params).toEqual({ a: 1 });
    expect(c.seed).toBe(42);
    expect(c.gl).toBeNull();
    expect(c.brushSize).toBe(8);
    expect(c.brushHardness).toBe(1);
    expect(c.color).toEqual(RED);
    const snap = await c.snapshot({ x: -4, y: -4, w: 8, h: 8 });
    expect(snap.width).toBe(8);
    expect(snap.data[3]).toBe(0);
    const img = makeImageData(4, 4, new Uint8ClampedArray(64).fill(255));
    const mask = makeImageData(4, 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) mask.data[(y * 4 + x) * 4 + 3] = 255;
    c.composite(img, { x: 10, y: 10, w: 4, h: 4 }, mask);
    await e.endStrokeAsync();
    expect(e.readPixels({ x: 10, y: 10, w: 1, h: 1 }, "layer").data[3]).toBe(255);
    expect(e.readPixels({ x: 13, y: 10, w: 1, h: 1 }, "layer").data[3]).toBe(0);
    c.composite(img, { x: -2, y: -2, w: 4, h: 4 }); // partly off-canvas: no throw
    c.clearScratch?.({ x: 0, y: 0, w: 32, h: 32 });
  });

  it("dabAs draws with a style override", async () => {
    const e = await testEngine(64, 64);
    fake("t-as", {
      onStrokeBegin(ctx, p) {
        (ctx as LabContext & LabContextExt).dabAs?.([p, { ...p, x: p.x + 30 }], { color: { r: 0, g: 0, b: 1, a: 1 }, sizeScale: 2 });
      },
    });
    e.beginStroke(labTool("t-as"), pt(10, 32));
    await e.endStrokeAsync();
    const d = e.readPixels({ x: 10, y: 32, w: 1, h: 1 }, "layer").data;
    expect(d[2]).toBe(255);
    expect(d[0]).toBe(0);
    expect(e.readPixels({ x: 10, y: 25, w: 1, h: 1 }, "layer").data[3]).toBeGreaterThan(200); // twice the size
  });

  it("an unknown tool paints nothing", async () => {
    const e = await testEngine(16, 16);
    e.beginStroke(labTool("nope"), pt(8, 8));
    const r = await e.endStrokeAsync();
    expect(r.history).toBeNull();
  });

  it("every bundled algorithmic tool runs a stroke on the CPU backend and replays identically", async () => {
    const run = async (id: string) => {
      const e = await testEngine(96, 96, {}, "#ffffff");
      e.beginStroke(labTool(id), pt(20, 48));
      e.extendStroke(line(20, 48, 76, 48, 3).slice(1), []);
      await e.endStrokeAsync();
      return Array.from(e.readPixels({ x: 0, y: 0, w: 96, h: 96 }, "layer").data);
    };
    for (const t of ALGORITHMIC_TOOLS) {
      const a = await run(t.id);
      const b = await run(t.id);
      expect(a, t.id).toEqual(b);
    }
  }, 120000);
});
