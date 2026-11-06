/**
 * The render host's headless requests (Phase 14 A2): compositions and recipes
 * answered with the render protocol, and the host's presence announcement.
 */
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Composition } from "@/lib/api";
import { buildEditFixture, fixtureProject } from "@/viz/edit/fixture";
import { normalizeProject } from "@/viz/edit/defaults";

const invoked: string[] = [];
const handlers = new Map<string, (d: unknown) => void>();

vi.mock("@wailsio/runtime", () => ({ System: { invoke: (m: string) => invoked.push(m) } }));
vi.mock("@/lib/events", () => ({
  on: (name: string, cb: (d: unknown) => void) => {
    handlers.set(name, cb);
    return () => handlers.delete(name);
  },
}));

import RenderHost, { cancelRender, routeRender, type Singles } from "./RenderHost";
import type { SingleDeps, SinglePlan } from "./edit/headless";

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: unknown[] = [];
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m: unknown) {
    this.posted.push(m);
  }
  terminate() {}
}

beforeEach(() => {
  invoked.length = 0;
  handlers.clear();
  FakeWorker.all = [];
  vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => vi.unstubAllGlobals());

const parts = (m: string) => m.split("|");
const flush = () => new Promise((r) => setTimeout(r, 0));

function decodeData(messages: string[]): Uint8Array {
  const chunks = messages
    .filter((m) => parts(m)[2] === "data")
    .map((m) => Uint8Array.from(atob(parts(m)[4] as string), (c) => c.charCodeAt(0)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const compPlan = (over: Partial<SinglePlan> = {}): SinglePlan => ({
  kind: "composition",
  width: 540,
  height: 675,
  analysis: { audioJsonUrl: "", featuresUrl: "", textJsonUrl: "" },
  composition: { documentJson: JSON.stringify({ version: 1, width: 1080, height: 1350, layers: [] }), format: "png", scale: 0.5 },
  ...over,
});

function deps(over: Partial<SingleDeps> = {}): SingleDeps {
  return {
    fetchPlan: async () => compPlan(),
    renderComposition: async (_doc, _scale, opts) => {
      opts.onProgress(0.5);
      return { format: "png", bytes: new Uint8Array([1, 2, 3, 4]), width: 540, height: 675 };
    },
    loadAnalysis: async () => buildEditFixture(),
    ...over,
  };
}

describe("composition requests", () => {
  it("renders the document and sends start, progress, data and done under the token", async () => {
    const sent: string[] = [];
    let seen: { doc: Composition; scale: number; format: string } | null = null;
    const singles: Singles = new Map();
    routeRender({ token: "tok1", planUrl: "/media/x/plan.json", kind: "composition" }, (m) => sent.push(m), new Map(), singles, false, deps({
      renderComposition: async (doc, scale, opts) => {
        seen = { doc, scale, format: opts.format };
        opts.onProgress(1);
        return { format: "png", bytes: new Uint8Array([9, 8, 7]), width: 540, height: 675 };
      },
    }));
    expect(singles.has("tok1")).toBe(true);
    await flush();
    expect(sent.map((m) => parts(m).slice(0, 3).join("|"))).toEqual(["vz1|tok1|start", "vz1|tok1|progress", "vz1|tok1|data", "vz1|tok1|done"]);
    expect(JSON.parse(parts(sent[0] as string)[3] as string)).toEqual({ encoder: "png", width: 540, height: 675, fps: 1, frames: 1 });
    expect(sent[1]).toBe("vz1|tok1|progress|100|100");
    expect(Array.from(decodeData(sent))).toEqual([9, 8, 7]);
    expect(sent[3]).toBe('vz1|tok1|done|{"frames":1,"bytes":3}');
    expect(seen).toMatchObject({ scale: 0.5, format: "png" });
    expect((seen as unknown as { doc: Composition }).doc.width).toBe(1080);
    expect(singles.size).toBe(0);
  });

  it("splits a big picture into several data messages in order", async () => {
    const sent: string[] = [];
    const big = new Uint8Array(2.5 * 1024 * 1024).fill(5);
    routeRender({ token: "t", planUrl: "p", kind: "composition" }, (m) => sent.push(m), new Map(), new Map(), false, deps({
      renderComposition: async () => ({ format: "png", bytes: big, width: 540, height: 675 }),
    }));
    await flush();
    const data = sent.filter((m) => parts(m)[2] === "data");
    expect(data.map((m) => parts(m)[3])).toEqual(["0", "1", "2"]);
    expect(decodeData(sent).length).toBe(big.length);
    expect(sent[sent.length - 1]).toBe(`vz1|t|done|{"frames":1,"bytes":${big.length}}`);
  });

  it("reports a failure (a missing photo) as an error message", async () => {
    const sent: string[] = [];
    routeRender({ token: "e", planUrl: "p", kind: "composition" }, (m) => sent.push(m), new Map(), new Map(), false, deps({
      renderComposition: async () => {
        throw new Error("photo.jpg doesn't exist");
      },
    }));
    await flush();
    expect(sent[sent.length - 1]).toContain("vz1|e|error|");
    expect(sent[sent.length - 1]).toContain("photo.jpg doesn't exist");
    expect(sent.some((m) => parts(m)[2] === "done")).toBe(false);
  });

  it("refuses a picture of another size than the plan", async () => {
    const sent: string[] = [];
    routeRender({ token: "s", planUrl: "p", kind: "composition" }, (m) => sent.push(m), new Map(), new Map(), false, deps({
      renderComposition: async () => ({ format: "png", bytes: new Uint8Array(1), width: 10, height: 10 }),
    }));
    await flush();
    expect(sent[sent.length - 1]).toContain("wrong size");
  });

  it("answers a cancel with a cancelled message and sends no picture", async () => {
    const sent: string[] = [];
    const singles: Singles = new Map();
    let release: () => void = () => {};
    routeRender({ token: "c", planUrl: "p", kind: "composition" }, (m) => sent.push(m), new Map(), singles, false, deps({
      renderComposition: (_d, _s, opts) =>
        new Promise((_, reject) => {
          release = () => reject(new DOMException("Export cancelled", "AbortError"));
          opts.signal.addEventListener("abort", release);
        }),
    }));
    await flush();
    cancelRender("c", new Map(), singles);
    await flush();
    expect(sent[sent.length - 1]).toBe("vz1|c|cancelled");
    expect(sent.some((m) => parts(m)[2] === "data")).toBe(false);
  });
});

describe("recipe requests", () => {
  it("fills the edit and sends its JSON", async () => {
    const p = normalizeProject(fixtureProject());
    const base = { ...p, tracks: [{ ...p.tracks[0]!, clips: [] }, ...p.tracks.slice(1)] };
    const plan: SinglePlan = {
      kind: "recipe",
      width: 0,
      height: 0,
      analysis: { audioJsonUrl: "/a.json", featuresUrl: "/f.bin", textJsonUrl: "" },
      recipe: {
        projectJson: JSON.stringify(base),
        recipeId: "downbeat",
        seed: 3,
        order: "recipe",
        sources: [{ path: "/a.mp4", kind: "video", durationMs: 9000, tags: [], shots: null }],
      },
    };
    const sent: string[] = [];
    const loaded: unknown[] = [];
    routeRender({ token: "r", planUrl: "p", kind: "recipe" }, (m) => sent.push(m), new Map(), new Map(), false, deps({
      fetchPlan: async () => plan,
      loadAnalysis: async (urls) => {
        loaded.push(urls);
        return buildEditFixture();
      },
    }));
    await flush();
    expect(loaded).toEqual([{ audioJsonUrl: "/a.json", featuresUrl: "/f.bin", textJsonUrl: undefined }]);
    expect(JSON.parse(parts(sent[0] as string)[3] as string)).toMatchObject({ encoder: "json", frames: 1 });
    const project = JSON.parse(new TextDecoder().decode(decodeData(sent))) as { tracks: Array<{ clips: unknown[] }>; recipe: { recipeId: string; seed: number } };
    expect(project.tracks[0]?.clips.length).toBeGreaterThan(5);
    expect(project.recipe).toMatchObject({ recipeId: "downbeat", seed: 3 });
    expect(sent[sent.length - 1]).toMatch(/^vz1\|r\|done\|\{"frames":1,"bytes":\d+\}$/);
  });

  it("reports an unknown recipe", async () => {
    const plan: SinglePlan = {
      kind: "recipe",
      width: 0,
      height: 0,
      analysis: { audioJsonUrl: "/a.json", featuresUrl: "/f.bin", textJsonUrl: "" },
      recipe: { projectJson: JSON.stringify(fixtureProject()), recipeId: "nope", seed: 1, order: "recipe", sources: [] },
    };
    const sent: string[] = [];
    routeRender({ token: "u", planUrl: "p", kind: "recipe" }, (m) => sent.push(m), new Map(), new Map(), false, deps({ fetchPlan: async () => plan }));
    await flush();
    expect(sent[sent.length - 1]).toContain("vz1|u|error|");
    expect(sent[sent.length - 1]).toContain("Unknown cutting style");
  });

  it("reports an analysis that is missing from the plan", async () => {
    const plan: SinglePlan = {
      kind: "recipe",
      width: 0,
      height: 0,
      analysis: { audioJsonUrl: "", featuresUrl: "", textJsonUrl: "" },
      recipe: { projectJson: "{}", recipeId: "kick", seed: 1, order: "recipe", sources: [] },
    };
    const sent: string[] = [];
    routeRender({ token: "m", planUrl: "p", kind: "recipe" }, (m) => sent.push(m), new Map(), new Map(), false, deps({ fetchPlan: async () => plan }));
    await flush();
    expect(sent[sent.length - 1]).toContain("analysis is missing");
  });
});

describe("routing and presence", () => {
  it("starts a worker for video renders and none for headless kinds", async () => {
    const active = new Map();
    routeRender({ token: "v", planUrl: "/p.json" }, () => {}, active, new Map(), false, deps());
    expect(FakeWorker.all).toHaveLength(1);
    expect(active.has("v")).toBe(true);
    routeRender({ token: "k", planUrl: "/p.json", kind: "composition" }, () => {}, active, new Map(), false, deps());
    expect(FakeWorker.all).toHaveLength(1);
    await flush();
  });

  it("cancel reaches a video worker too", () => {
    const active = new Map();
    routeRender({ token: "v", planUrl: "/p.json", kind: "" }, () => {}, active, new Map());
    cancelRender("v", active, new Map());
    expect((FakeWorker.all[0] as FakeWorker).posted).toContainEqual({ type: "cancel" });
  });

  it("announces itself to Go when mounted and withdraws when unmounted", () => {
    const { unmount } = render(<RenderHost />);
    expect(invoked).toEqual(["vz1|host|up"]);
    expect([...handlers.keys()].sort()).toEqual(["viz:render", "viz:render-ack", "viz:render-cancel"]);
    unmount();
    expect(invoked).toEqual(["vz1|host|up", "vz1|host|down"]);
    expect(handlers.size).toBe(0);
  });
});
