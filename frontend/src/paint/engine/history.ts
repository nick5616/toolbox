// Undo history (SPEC §2.3). A tile step stores the tiles a change replaced
// ("before"); undo swaps them with the live tiles, so the same data serves
// redo. Over the GPU budget the oldest steps demote to RAM (cropped to their
// non-empty box); over the total budget the oldest steps drop their pixels.

import type { GLBackend, Surface } from "./gl";
import type { Layer } from "./layers";
import { isEmpty, tileKey } from "./pixels";
import { TILE, type HistoryEntry, type HistoryId, type Rect } from "./types";

export type TileData =
  | { k: "gpu"; s: Surface }
  | { k: "ram"; x: number; y: number; w: number; h: number; px: Uint8ClampedArray }
  | { k: "empty" }
  | { k: "gone" };

/** What tile steps need from the engine. */
export interface TileHost {
  backend: GLBackend;
  layer(id: string): Layer | undefined;
  /** A tile's pixels changed (composite + save dirtiness). */
  touched(layerId: string, key: string): void;
}

export interface Step {
  id: HistoryId;
  label: string;
  bounds: Rect;
  available: boolean;
  bytes(): number;
  gpuBytes(): number;
  undo(): void;
  redo(): void;
  /** Move GPU tiles to RAM; returns GPU bytes freed. */
  demote(): number;
  /** Drop the pixels (budget). */
  drop(): void;
  release(): void;
  tileParts(): TileSwapStep[];
}

const TILE_BYTES = TILE * TILE * 4;

function pack(px: Uint8ClampedArray): TileData {
  let x0 = TILE;
  let y0 = TILE;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      if (px[(y * TILE + x) * 4 + 3] !== 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  if (x1 < 0) return { k: "empty" };
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(px.subarray(((y0 + y) * TILE + x0) * 4, ((y0 + y) * TILE + x0 + w) * 4), y * w * 4);
  return { k: "ram", x: x0, y: y0, w, h, px: out };
}

export function tileDataBytes(d: TileData): number {
  return d.k === "gpu" ? TILE_BYTES : d.k === "ram" ? d.px.byteLength : 0;
}

/** A surface for `d` (null = transparent/absent). */
export function materialise(be: GLBackend, d: TileData): Surface | null {
  if (d.k === "gpu") return d.s;
  if (d.k !== "ram") return null;
  const s = be.createSurface();
  be.clear(s);
  be.upload(s, d.px, d.x, d.y, d.w, d.h);
  return s;
}

export class TileSwapStep implements Step {
  available = true;
  constructor(
    public id: HistoryId,
    public label: string,
    public bounds: Rect,
    /** layerId → key → the state to restore on the next swap. */
    public data: Map<string, Map<string, TileData>>,
    private readonly host: TileHost,
  ) {}

  private swap(): void {
    const be = this.host.backend;
    for (const [lid, tiles] of this.data) {
      const layer = this.host.layer(lid);
      if (!layer) continue;
      for (const [key, stored] of tiles) {
        if (stored.k === "gone") continue;
        const cur = layer.tiles.get(key) ?? null;
        const next = materialise(be, stored);
        if (next) layer.tiles.set(key, next);
        else layer.tiles.delete(key);
        tiles.set(key, cur ? { k: "gpu", s: cur } : { k: "empty" });
        this.host.touched(lid, key);
      }
    }
  }

  undo(): void {
    this.swap();
  }
  redo(): void {
    this.swap();
  }

  peek(layerId: string, key: string): TileData | undefined {
    return this.data.get(layerId)?.get(key);
  }

  bytes(): number {
    let n = 0;
    for (const tiles of this.data.values()) for (const d of tiles.values()) n += tileDataBytes(d);
    return n;
  }
  gpuBytes(): number {
    let n = 0;
    for (const tiles of this.data.values()) for (const d of tiles.values()) if (d.k === "gpu") n += TILE_BYTES;
    return n;
  }
  demote(): number {
    const be = this.host.backend;
    let freed = 0;
    for (const tiles of this.data.values()) {
      for (const [key, d] of tiles) {
        if (d.k !== "gpu") continue;
        const px = be.download(d.s, 0, 0, TILE, TILE);
        be.destroySurface(d.s);
        tiles.set(key, isEmpty(px) ? { k: "empty" } : pack(px));
        freed += TILE_BYTES;
      }
    }
    return freed;
  }
  drop(): void {
    this.release();
    for (const tiles of this.data.values()) for (const key of [...tiles.keys()]) tiles.set(key, { k: "gone" });
    this.available = false;
  }
  release(): void {
    for (const tiles of this.data.values()) for (const d of tiles.values()) if (d.k === "gpu") this.host.backend.destroySurface(d.s);
  }
  tileParts(): TileSwapStep[] {
    return [this];
  }
}

export interface CompoundHooks {
  undo?: () => void;
  redo?: () => void;
  /** Pixels held by closures (a removed layer's tiles), counted against the budget. */
  extraBytes?: () => number;
  /** The step left the history for good (truncated or cleared). */
  release?: () => void;
  /** The budget dropped it. */
  drop?: () => void;
}

/** A step made of other steps plus structure changes (layers, canvas size). */
export class CompoundStep implements Step {
  available = true;
  constructor(
    public id: HistoryId,
    public label: string,
    public bounds: Rect,
    private readonly parts: Step[],
    private readonly hooks: CompoundHooks = {},
  ) {}
  undo(): void {
    this.hooks.undo?.();
    for (let i = this.parts.length - 1; i >= 0; i--) (this.parts[i] as Step).undo();
  }
  redo(): void {
    for (const p of this.parts) p.redo();
    this.hooks.redo?.();
  }
  bytes(): number {
    return this.parts.reduce((n, p) => n + p.bytes(), 0) + (this.hooks.extraBytes?.() ?? 0);
  }
  gpuBytes(): number {
    return this.parts.reduce((n, p) => n + p.gpuBytes(), 0);
  }
  demote(): number {
    return this.parts.reduce((n, p) => n + p.demote(), 0);
  }
  drop(): void {
    for (const p of this.parts) p.drop();
    this.hooks.drop?.();
    this.available = false;
  }
  release(): void {
    for (const p of this.parts) p.release();
    this.hooks.release?.();
  }
  tileParts(): TileSwapStep[] {
    return this.parts.flatMap((p) => p.tileParts());
  }
}

/** Collects the "before" state of tiles a change is about to touch. */
export class TileRecorder {
  readonly map = new Map<string, Map<string, TileData>>();
  bounds: Rect | null = null;
  constructor(private readonly host: TileHost) {}

  has(layerId: string, key: string): boolean {
    return this.map.get(layerId)?.has(key) ?? false;
  }

  touch(layer: Layer, key: string): void {
    let m = this.map.get(layer.id);
    if (!m) this.map.set(layer.id, (m = new Map()));
    if (m.has(key)) return;
    const cur = layer.tiles.get(key);
    if (!cur) {
      m.set(key, { k: "empty" });
      return;
    }
    const s = this.host.backend.createSurface();
    this.host.backend.copy(s, cur);
    m.set(key, { k: "gpu", s });
  }

  addBounds(r: Rect): void {
    if (!this.bounds) {
      this.bounds = { ...r };
      return;
    }
    const x0 = Math.min(this.bounds.x, r.x);
    const y0 = Math.min(this.bounds.y, r.y);
    const x1 = Math.max(this.bounds.x + this.bounds.w, r.x + r.w);
    const y1 = Math.max(this.bounds.y + this.bounds.h, r.y + r.h);
    this.bounds = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  get size(): number {
    let n = 0;
    for (const m of this.map.values()) n += m.size;
    return n;
  }

  /** Put every recorded tile back as it was, keeping the record (preview sessions). */
  revert(): void {
    const be = this.host.backend;
    for (const [lid, tiles] of this.map) {
      const layer = this.host.layer(lid);
      if (!layer) continue;
      for (const [key, d] of tiles) {
        if (d.k === "gpu") {
          let s = layer.tiles.get(key);
          if (!s) layer.tiles.set(key, (s = be.createSurface()));
          be.copy(s, d.s);
        } else if (d.k === "empty") {
          const s = layer.tiles.get(key);
          if (s) {
            be.destroySurface(s);
            layer.tiles.delete(key);
          }
        }
        this.host.touched(lid, key);
      }
    }
  }

  toStep(id: HistoryId, label: string, fallback: Rect): TileSwapStep {
    const step = new TileSwapStep(id, label, this.bounds ?? fallback, this.map, this.host);
    return step;
  }

  /** Free the recorded surfaces without making a step. */
  discard(): void {
    for (const m of this.map.values()) for (const d of m.values()) if (d.k === "gpu") this.host.backend.destroySurface(d.s);
    this.map.clear();
  }
}

export interface Budget {
  /** Total (GPU + RAM) bytes of history pixels. */
  total: number;
  /** GPU-resident bytes before steps demote to RAM. */
  gpu: number;
}

export const DEFAULT_BUDGET: Budget = { total: 1.5 * 1024 * 1024 * 1024, gpu: 512 * 1024 * 1024 };

export class History {
  steps: Step[] = [];
  cursor = 0;
  private nextId = 1;
  constructor(public budget: Budget) {}

  newId(): HistoryId {
    return this.nextId++;
  }

  push(step: Step): void {
    for (const s of this.steps.splice(this.cursor)) s.release();
    this.steps.push(step);
    this.cursor = this.steps.length;
    this.enforce();
  }

  /** The top step, when nothing was undone. */
  top(): Step | null {
    return this.cursor === this.steps.length && this.cursor > 0 ? (this.steps[this.cursor - 1] as Step) : null;
  }

  undo(): boolean {
    if (this.cursor === 0) return false;
    const s = this.steps[this.cursor - 1] as Step;
    if (!s.available) return false;
    s.undo();
    this.cursor--;
    return true;
  }

  redo(): boolean {
    if (this.cursor >= this.steps.length) return false;
    const s = this.steps[this.cursor] as Step;
    if (!s.available) return false;
    s.redo();
    this.cursor++;
    return true;
  }

  jumpTo(id: HistoryId): void {
    const idx = this.steps.findIndex((s) => s.id === id);
    if (idx < 0) return;
    while (this.cursor > idx + 1) if (!this.undo()) return;
    while (this.cursor < idx + 1) if (!this.redo()) return;
  }

  entries(): HistoryEntry[] {
    return this.steps.map((s) => ({ id: s.id, label: s.label, bounds: s.bounds, available: s.available }));
  }

  totalBytes(): number {
    return this.steps.reduce((n, s) => n + s.bytes(), 0);
  }
  gpuBytes(): number {
    return this.steps.reduce((n, s) => n + s.gpuBytes(), 0);
  }

  enforce(): void {
    let gpu = this.gpuBytes();
    for (let i = 0; i < this.steps.length && gpu > this.budget.gpu; i++) gpu -= (this.steps[i] as Step).demote();
    let total = this.totalBytes();
    for (let i = 0; i < this.steps.length - 1 && total > this.budget.total; i++) {
      const s = this.steps[i] as Step;
      if (!s.available) continue;
      total -= s.bytes();
      s.drop();
      // Steps older than a dropped one can't be reached either.
      for (let j = 0; j < i; j++) {
        const o = this.steps[j] as Step;
        if (o.available) {
          total -= o.bytes();
          o.drop();
        }
      }
    }
  }

  clear(): void {
    for (const s of this.steps) s.release();
    this.steps = [];
    this.cursor = 0;
  }
}

export { tileKey };
