import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startRender } from "./RenderHost";

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m: unknown) {
    this.posted.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  emit(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

beforeEach(() => {
  FakeWorker.all = [];
  vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => vi.unstubAllGlobals());

describe("startRender", () => {
  it("starts one worker with the plan and relays messages as raw messages", () => {
    const sent: string[] = [];
    const active = new Map();
    startRender("t1", "/media/x/plan.json", (m) => sent.push(m), active, true);
    expect(FakeWorker.all).toHaveLength(1);
    const w = FakeWorker.all[0] as FakeWorker;
    expect(w.posted[0]).toEqual({ type: "render", token: "t1", planUrl: "/media/x/plan.json", forceJpeg: true });
    w.emit({ type: "start", info: { encoder: "h264-hw", width: 2, height: 2, fps: 30, frames: 2 } });
    w.emit({ type: "data", buf: new Uint8Array([1, 2, 3]).buffer });
    w.emit({ type: "progress", frame: 1, frames: 2 });
    w.emit({ type: "done", frames: 2, bytes: 3 });
    expect(sent.map((s) => s.split("|").slice(0, 3).join("|"))).toEqual(["vz1|t1|start", "vz1|t1|data", "vz1|t1|progress", "vz1|t1|done"]);
    expect(w.terminated).toBe(true);
    expect(active.size).toBe(0);
    w.emit({ type: "data", buf: new ArrayBuffer(1) }); // a late message is ignored
    expect(sent).toHaveLength(4);
  });
  it("relays errors and cancellation, then terminates the worker", () => {
    const sent: string[] = [];
    const active = new Map();
    startRender("a", "p", (m) => sent.push(m), active);
    startRender("b", "p", (m) => sent.push(m), active);
    (FakeWorker.all[0] as FakeWorker).emit({ type: "error", message: "m", detail: "d" });
    (FakeWorker.all[1] as FakeWorker).emit({ type: "cancelled" });
    expect(sent).toEqual(['vz1|a|error|{"message":"m","detail":"d"}', "vz1|b|cancelled"]);
    expect(FakeWorker.all.every((w) => w.terminated)).toBe(true);
  });
  it("reports a crashed worker as an error", () => {
    const sent: string[] = [];
    const active = new Map();
    startRender("c", "p", (m) => sent.push(m), active);
    (FakeWorker.all[0] as FakeWorker).onerror?.({ message: "boom" } as ErrorEvent);
    expect(sent[0]).toContain("vz1|c|error|");
    expect(sent[0]).toContain("boom");
    expect(FakeWorker.all[0]?.terminated).toBe(true);
  });
});
