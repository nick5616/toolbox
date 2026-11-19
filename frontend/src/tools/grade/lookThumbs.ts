/**
 * Live gallery thumbnails (Phase 21 SPEC §E1): the user's own picture in every
 * look, 160 px wide, rendered one after another on ONE shared offscreen GL
 * engine (one WebGL context for the whole gallery), only for cards that are
 * visible, and cached per (input, look, Wildness, maps).
 */
import { useEffect, useRef, useState } from "react";
import { compileEdit } from "@/viz/edit/compile";
import { EditEngine } from "@/viz/edit/engine";
import { EditFrameProvider } from "@/viz/frames/provider";
import type { EditInputs } from "@/viz/edit/types";

export const THUMB_WIDTH = 160;
const CACHE_MAX = 400;
const PREPARE_TIMEOUT_MS = 4000;

/** Draws one edit at time 0 into a JPEG data URL; null when it can't (no GL, no frame). */
export type ThumbDrawer = (inputs: EditInputs, width: number, height: number) => Promise<string | null>;

interface Shared {
  key: string;
  engine: EditEngine;
  provider: EditFrameProvider;
  canvas: HTMLCanvasElement;
  out: HTMLCanvasElement;
}

let shared: Shared | null = null;

function release(): void {
  if (!shared) return;
  shared.engine.dispose();
  shared.provider.dispose();
  shared = null;
}

function acquire(inputs: EditInputs, width: number, height: number): Shared {
  const fps = inputs.project.fps;
  const key = `${width}x${height}@${fps}`;
  if (shared?.key === key) return shared;
  release();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const engine = new EditEngine(canvas, { width, height, fps, seed: inputs.project.seed, quality: "draft", inWorker: false });
  const provider = new EditFrameProvider({ files: inputs.files, mode: "preview" });
  shared = { key, engine, provider, canvas, out };
  return shared;
}

const defaultDrawer: ThumbDrawer = async (inputs, width, height) => {
  let s: Shared;
  try {
    s = acquire(inputs, width, height);
  } catch {
    return null; // no WebGL here
  }
  s.provider.setFiles(inputs.files);
  const compiled = compileEdit(inputs, { width, height, fps: inputs.project.fps });
  s.engine.setEdit(compiled);
  const keys = s.engine.needs(0);
  await Promise.race([s.provider.prepare(keys, true).catch(() => undefined), new Promise<void>((r) => setTimeout(r, PREPARE_TIMEOUT_MS))]);
  if (!s.provider.isReady(keys)) return null;
  s.engine.render(0, s.provider);
  const ctx = s.out.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(s.canvas, 0, 0); // straight after the draw, while the buffer still holds it
  return s.out.toDataURL("image/jpeg", 0.82);
};

let drawer: ThumbDrawer = defaultDrawer;
/** Tests replace the drawer (null restores the GL one). */
export function setThumbDrawerForTest(d: ThumbDrawer | null): void {
  drawer = d ?? defaultDrawer;
}

const cache = new Map<string, string>();

interface Queued {
  key: string;
  build: () => EditInputs | null;
  width: number;
  height: number;
  resolve: (url: string) => void;
}

const queue: Queued[] = [];
let running = false;

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (let q = queue.shift(); q; q = queue.shift()) {
      if (cache.has(q.key)) {
        q.resolve(cache.get(q.key) as string);
        continue;
      }
      const inputs = q.build();
      let url: string | null = null;
      if (inputs) {
        try {
          url = await drawer(inputs, q.width, q.height);
        } catch {
          url = null;
        }
      }
      if (url) {
        cache.set(q.key, url);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
        q.resolve(url);
      } else q.resolve("");
      // Yield so the UI (and the preview's own render) stays smooth.
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  } finally {
    running = false;
  }
}

export interface ThumbRequest {
  key: string;
  width: number;
  height: number;
  build: () => EditInputs | null;
}

/** Asks for a thumbnail; the returned cancel drops it if it hasn't started. The promise gives "" when none could be made. */
export function requestThumb(req: ThumbRequest): { promise: Promise<string>; cancel: () => void } {
  const hit = cache.get(req.key);
  if (hit) return { promise: Promise.resolve(hit), cancel: () => undefined };
  let item: Queued | null = null;
  const promise = new Promise<string>((resolve) => {
    item = { ...req, resolve };
    queue.push(item);
    void pump();
  });
  return {
    promise,
    cancel: () => {
      const i = item ? queue.indexOf(item) : -1;
      if (i >= 0) {
        const [q] = queue.splice(i, 1);
        q?.resolve("");
      }
    },
  };
}

/** The cached thumbnail for a key, if any. */
export function cachedThumb(key: string): string {
  return cache.get(key) ?? "";
}

/** Drops the shared engine and the cache (closing the tool, tests). */
export function disposeThumbs(): void {
  queue.length = 0;
  release();
  cache.clear();
}

/**
 * A card's thumbnail: requested only while `visible`, cancelled when it
 * scrolls away or its key changes. "" until it's drawn (or when it can't be).
 */
export function useLookThumb(req: ThumbRequest | null, visible: boolean): { url: string; pending: boolean } {
  const key = req?.key ?? "";
  const [state, setState] = useState<{ key: string; url: string; done: boolean }>({ key: "", url: "", done: false });
  const buildRef = useRef(req?.build);
  buildRef.current = req?.build;
  const has = !!req;
  const width = req?.width ?? 0;
  const height = req?.height ?? 0;
  useEffect(() => {
    if (!key || !has || !visible) return;
    const hit = cachedThumb(key);
    if (hit) {
      setState({ key, url: hit, done: true });
      return;
    }
    let live = true;
    const r = requestThumb({ key, width, height, build: () => buildRef.current?.() ?? null });
    void r.promise.then((url) => {
      if (live) setState({ key, url, done: true });
    });
    return () => {
      live = false;
      r.cancel();
    };
  }, [key, visible, has, width, height]);
  const mine = state.key === key;
  return { url: mine ? state.url : "", pending: !!key && visible && !(mine && state.done) };
}
