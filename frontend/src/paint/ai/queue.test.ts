import { describe, expect, it } from "vitest";
import { PaintAIOp } from "@/lib/api";
import { CancelledError, createPerceptionQueue, MAX_GROUPS, type SubmitRequest } from "./queue";
import { createFakeAI, createFakeEngine, type FakeAI, type FakeEngine } from "./testing";
import { createImage, cropImage } from "./pixels";
import type { Rect } from "../engine/types";

const BOUNDS: Rect = { x: 150, y: 150, w: 20, h: 20 };

function solid(w: number, h: number): ImageData {
  const img = createImage(w, h);
  img.data.fill(255);
  return img;
}

function fillReq(engine: FakeEngine, bounds: Rect, over: Partial<SubmitRequest> = {}): SubmitRequest {
  return {
    op: PaintAIOp.OpFill,
    source: cropImage(engine.pixels, bounds),
    mask: solid(bounds.w, bounds.h),
    points: null,
    model: "best",
    passes: 1,
    ghost: 0,
    drift: 0,
    driftDir: "",
    offset: [0, 0],
    seed: 7,
    scale: 0,
    ...over,
  };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  expect(cond()).toBe(true);
}

function setup(w = 400, h = 400): { engine: FakeEngine; ai: FakeAI; q: ReturnType<typeof createPerceptionQueue> } {
  const engine = createFakeEngine(w, h);
  const ai = createFakeAI();
  return { engine, ai, q: createPerceptionQueue(engine, () => "proj", ai.deps) };
}

const px = (e: FakeEngine, x: number, y: number) => e.pixels.data[(y * e.pixels.width + x) * 4]!;

describe("perception queue: a fill", () => {
  it("sends a margin crop, composites under the mask with a 4px feather as one write", async () => {
    const { engine, ai, q } = setup();
    const group = await q.submit("fill-eraser", BOUNDS, fillReq(engine, BOUNDS), { label: "Fill eraser" });
    // crop: margin max(64, 10)=64 -> side 148
    const sent = await ai.codec.decode(ai.requests[0]!.source);
    expect([sent.width, sent.height]).toEqual([148, 148]);
    expect(ai.requests[0]!.mask).not.toBe("");
    const mask = await ai.codec.decode(ai.requests[0]!.mask);
    expect(mask.data[3]).toBe(255); // opaque grayscale mask
    expect(engine.writes).toHaveLength(1);
    const w = engine.writes[0]!;
    expect(w.feather).toBe(4);
    expect(w.r).toEqual(BOUNDS);
    expect(w.mask?.width).toBe(20);
    expect(px(engine, 160, 160)).toBe(200);
    expect(px(engine, 100, 100)).toBe(10);
    expect(group.generations.map((g) => g.label)).toEqual(["Original", "Final"]);
    expect(q.groups()).toHaveLength(1);
    expect(q.pending()).toHaveLength(0);
  });

  it("builds Original, Pass 1..3, Final for a 3-pass fill", async () => {
    const { engine, q } = setup();
    const g = await q.submit("dissolve", BOUNDS, fillReq(engine, BOUNDS, { passes: 3 }));
    expect(g.generations.map((x) => x.label)).toEqual(["Original", "Pass 1", "Pass 2", "Pass 3", "Final"]);
    expect(g.current).toBe(4);
    expect(g.generations[4]!.history).toBe(engine.writes[0]!.id);
    expect(g.generations[0]!.history).toBeNull();
    expect(g.generations.every((x) => x.thumb.startsWith("thumb:"))).toBe(true);
    expect(g.seed).toBe(7);
  });

  it("choose swaps the region to a generation as an undoable write", async () => {
    const { engine, q } = setup();
    const g = await q.submit("dissolve", BOUNDS, fillReq(engine, BOUNDS, { passes: 3 }), { label: "Dissolve" });
    q.choose(g.id, 2); // pass 2 = 80
    expect(engine.writes).toHaveLength(2);
    expect(engine.writes[1]!.label).toBe("Dissolve: Pass 2");
    expect(px(engine, 160, 160)).toBe(80);
    expect(q.groups()[0]!.current).toBe(2);
    expect(q.groups()[0]!.generations[2]!.history).toBe(engine.writes[1]!.id);
    q.choose(g.id, 0); // original
    expect(px(engine, 160, 160)).toBe(10);
    q.choose("missing", 0); // ignored
    expect(engine.writes).toHaveLength(3);
  });

  it("re-roll runs again with a new seed from the original context and adds a generation", async () => {
    const { engine, ai, q } = setup();
    const g = await q.submit("dissolve", BOUNDS, fillReq(engine, BOUNDS));
    const again = await q.reroll(g.id);
    expect(ai.requests).toHaveLength(2);
    expect(ai.requests[1]!.seed).not.toBe(ai.requests[0]!.seed);
    expect(again.generations.map((x) => x.label)).toEqual(["Original", "Final", "Re-roll 1"]);
    expect(again.current).toBe(2);
    expect(again.seed).toBe(ai.requests[1]!.seed);
    // the second request saw the original pixels, not the first result
    const src = await ai.codec.decode(ai.requests[1]!.source);
    expect(src.data[(74 * 148 + 74) * 4]).toBe(10);
    await expect(q.reroll("gone")).rejects.toThrow();
  });

  it("keeps at most 8 groups, newest first", async () => {
    const { engine, q } = setup();
    for (let i = 0; i < MAX_GROUPS + 2; i++) await q.submit("fill-eraser", BOUNDS, fillReq(engine, BOUNDS, { seed: i }));
    const gs = q.groups();
    expect(gs).toHaveLength(MAX_GROUPS);
    expect(gs[0]!.seed).toBe(MAX_GROUPS + 1);
  });

  it("splits enhance into overlapping tiles and blends them", async () => {
    const { engine, ai, q } = setup(1600, 1600);
    const b: Rect = { x: 450, y: 450, w: 700, h: 700 };
    const req = fillReq(engine, b, { op: PaintAIOp.OpEnhance, model: "photo", scale: 2, passes: 0 });
    const g = await q.submit("enhance-brush", b, req);
    expect(ai.requests.length).toBe(4);
    expect(g.generations.map((x) => x.label)).toEqual(["Original", "Final"]);
    expect(px(engine, 800, 800)).toBe(200);
  });
});

describe("perception queue: ordering, cancel, failure", () => {
  it("runs one engine call at a time, in submit order", async () => {
    const { engine, ai, q } = setup();
    ai.mode = "manual";
    const a = q.submit("fill-eraser", BOUNDS, fillReq(engine, BOUNDS, { seed: 1 }));
    const b = q.submit("fill-eraser", { x: 50, y: 50, w: 20, h: 20 }, fillReq(engine, { x: 50, y: 50, w: 20, h: 20 }, { seed: 2 }));
    await until(() => ai.requests.length === 1);
    expect(q.pending().map((p) => p.state)).toEqual(["running", "queued"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(ai.requests).toHaveLength(1);
    ai.progress(ai.jobIds[0]!, 0.5);
    expect(q.pending()[0]!.progress).toBe(0.5);
    ai.finish(ai.jobIds[0]!);
    await a;
    await until(() => ai.requests.length === 2);
    expect(ai.requests.map((r) => r.seed)).toEqual([1, 2]);
    ai.finish(ai.jobIds[1]!);
    await b;
    expect(engine.writes.map((w) => w.r.x)).toEqual([150, 50]);
    expect(q.pending()).toHaveLength(0);
  });

  it("cancelling a running request cancels its job and marks it cancelled", async () => {
    const { engine, ai, q } = setup();
    ai.mode = "manual";
    const p = q.submit("fill-eraser", BOUNDS, fillReq(engine, BOUNDS));
    const caught = p.catch((e: unknown) => e);
    await until(() => ai.requests.length === 1);
    const id = q.pending()[0]!.id;
    q.cancel(id);
    expect(ai.cancelled).toEqual([ai.jobIds[0]]);
    expect(await caught).toBeInstanceOf(CancelledError);
    expect(q.pending()[0]!.state).toBe("cancelled");
    expect(engine.writes).toHaveLength(0);
    q.cancel(id); // dismiss
    expect(q.pending()).toHaveLength(0);
  });

  it("cancelling a queued request never submits it", async () => {
    const { engine, ai, q } = setup();
    ai.mode = "manual";
    const a = q.submit("fill-eraser", BOUNDS, fillReq(engine, BOUNDS));
    const b = q.submit("fill-eraser", BOUNDS, fillReq(engine, BOUNDS));
    const bErr = b.catch((e: unknown) => e);
    await until(() => ai.requests.length === 1);
    q.cancel(q.pending()[1]!.id);
    expect(await bErr).toBeInstanceOf(CancelledError);
    ai.finish(ai.jobIds[0]!);
    await a;
    await new Promise((r) => setTimeout(r, 10));
    expect(ai.requests).toHaveLength(1);
  });

  it("a failed job is red with the retry text, and the queue moves on", async () => {
    const { engine, ai, q } = setup();
    ai.failNext = true;
    await expect(q.submit("fill-eraser", BOUNDS, fillReq(engine, BOUNDS))).rejects.toThrow();
    const p = q.pending();
    expect(p).toHaveLength(1);
    expect(p[0]!.state).toBe("failed");
    expect(p[0]!.message).toBe("That fill failed — try again");
    await q.submit("fill-eraser", BOUNDS, fillReq(engine, BOUNDS));
    expect(engine.writes).toHaveLength(1);
    q.dismiss(p[0]!.id);
    expect(q.pending()).toHaveLength(0);
  });

  it("notifies subscribers", async () => {
    const { engine, q } = setup();
    let n = 0;
    const off = q.on(() => n++);
    await q.submit("fill-eraser", BOUNDS, fillReq(engine, BOUNDS));
    expect(n).toBeGreaterThan(2);
    off();
    const before = n;
    await q.submit("fill-eraser", BOUNDS, fillReq(engine, BOUNDS));
    expect(n).toBe(before);
  });
});

describe("perception queue: painting over a pending region", () => {
  it("the result lands and the later strokes stay on top", async () => {
    const { engine, ai, q } = setup();
    ai.mode = "manual";
    const p = q.submit("fill-eraser", BOUNDS, fillReq(engine, BOUNDS));
    await until(() => ai.requests.length === 1);
    // the user paints over the left half of the region while the job runs
    engine.paint({ x: 150, y: 150, w: 10, h: 20 }, [255, 0, 0, 255]);
    ai.finish(ai.jobIds[0]!);
    await p;
    expect(px(engine, 152, 160)).toBe(255); // later stroke kept
    expect(px(engine, 165, 160)).toBe(200); // result landed elsewhere
    expect(engine.writes).toHaveLength(1); // still a single undo step
  });

  it("without later edits the result is written untouched", async () => {
    const { engine, q } = setup();
    await q.submit("fill-eraser", BOUNDS, fillReq(engine, BOUNDS));
    expect(px(engine, 152, 160)).toBe(200);
  });
});
