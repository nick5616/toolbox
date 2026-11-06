// createPaintEngine: the Paint+ engine (SPEC §2.3). Tiles, layers, the
// compositor, strokes (brush / eraser / smudge / history / mask / Lab),
// selection, transform, fill, history and saving. All GPU work goes through a
// GLBackend, so vitest runs the same code on the CPU reference backend.

import { BrushAssets, type AssetResolver } from "../brushes/assets";
import { bleed, bleedMargin } from "../brushes/bleed";
import { DabList, StrokeRenderer } from "../brushes/engine";
import { keyedRng } from "../brushes/rng";
import type { BrushPreset } from "../brushes/schema";
import { Smudger } from "../brushes/smudge";
import { LineAssist, assistActive, defaultGuides, parseGuides, stringifyGuides, type GuidesConfig } from "../guides/guides";
import type { LabContext, LabTool } from "../lab/types";
import type { LabContextExt } from "../lab/ext";
import { flushTool } from "../lab/ext";
import { blendInto } from "./blend";
import { browserCodec, type PngCodec } from "./codec";
import { floodMask, haloMask } from "./fill";
import { blendId, type DabBatch, type DabStyle, type GLBackend, type MergeOp, type MergeParams, type Surface } from "./gl";
import { CompoundStep, DEFAULT_BUDGET, History, TileRecorder, materialise, type Budget, type Step, type TileData, type TileHost } from "./history";
import { DEFAULT_PROPS, MAX_LAYERS, type Layer } from "./layers";
import { getLabTool } from "./lab-registry";
import { isEmpty, newBuf, premultiplied, rectsIntersect, straightImage, tileKey, unionRect, makeImageData, type PixelBuf } from "./pixels";
import { TilePixels, tilesOf } from "./region";
import { resizeBuf, type Resample } from "./sample";
import { SelectionImpl, featherMask, maskBounds } from "./selection";
import { TransformImpl } from "./transform";
import { ViewImpl } from "./view";
import {
  PaintGLError,
  TILE,
  type EngineEvent,
  type HistoryEntry,
  type HistoryId,
  type InputPoint,
  type LayerProps,
  type PaintDoc,
  type PaintEngine,
  type Point,
  type Rect,
  type RGBA,
  type StrokeResult,
  type TileSource,
  type ToolState,
} from "./types";
import { createGLBackend } from "./glBackend";
import { registerAll } from "../lab/index";
import { registerLabTool } from "./lab-registry";

registerAll(registerLabTool);

export interface EngineOptions {
  /** Default: WebGL2, made on attach(). */
  backend?: GLBackend;
  resolver?: AssetResolver;
  codec?: PngCodec;
  budget?: Partial<Budget>;
  /** Most `step` ticks a Lab tool runs at stroke end (default 300). */
  labMaxTicks?: number;
}

export interface PreviewSession {
  /** Show `img` over r of the layer (through mask and the selection) without recording history. */
  set(r: Rect, img: { data: Uint8ClampedArray; width: number; height: number }, mask?: ImageData): void;
  cancel(): void;
  commit(label?: string): HistoryId;
}

/** What the engine offers beyond the frozen PaintEngine contract. */
export interface PaintEngineExt {
  readonly backendName: "webgl2" | "cpu";
  /** The element's CSS size; the view maths use it. */
  setViewport(cssW: number, cssH: number): void;
  setResolver(r: AssetResolver | null): void;
  /** Forget a cached tip/grain (e.g. "stamp:<layer>" after a new cut-out). */
  invalidateAsset(ref: string): void;
  /** Load a preset's tip and grain images; call when a brush is picked. */
  prepareBrush(p: BrushPreset): Promise<void>;
  getGuides(): GuidesConfig;
  setGuides(g: GuidesConfig): void;
  /** Tile keys that failed to load, per layer ("Clear those tiles" banner). */
  failedTiles(): Map<string, string[]>;
  clearFailedTiles(layerId: string): void;
  /** Like endStroke(); Lab strokes finish asynchronously (their tools flush), and this awaits it. */
  endStrokeAsync(): Promise<StrokeResult>;
  /** The raw points of the running stroke (QuickShape). */
  strokePoints(): InputPoint[];
  /** Undo the last stroke and redo it along `points` (QuickShape edits). */
  restroke(tool: ToolState, points: InputPoint[]): StrokeResult;
  beginPreview(layerId?: string): PreviewSession;
  /** Premultiplied pixels of r, synchronously (adjustments, tests). */
  readPixels(r: Rect, src: "layer" | "merged", layerId?: string): PixelBuf;
  /** The id of the last applied history step (0 = none). */
  historyCursor(): number;
  /** Is a stroke running? */
  readonly stroking: boolean;
  setHistoryBudget(b: Partial<Budget>): void;
  /** Tests: the flattened view texture (premultiplied RGBA, canvas size). */
  readComposite(): Uint8ClampedArray;
  dispose(): void;
}

interface DabSink {
  renderer: StrokeRenderer;
  style: DabStyle;
  drawn: number;
  started: boolean;
}

interface StrokeState {
  tool: ToolState;
  layer: Layer;
  inert: boolean;
  renderer: StrokeRenderer | null;
  style: DabStyle | null;
  op: MergeOp;
  mode: number;
  opacity: number;
  wetEdges: number;
  impasto: number;
  wet: boolean;
  maskKind: boolean;
  scratch: Map<string, Surface>;
  pred: Map<string, Surface>;
  predList: DabList;
  drawn: number;
  bounds: Rect | null;
  smudge: { rec: TileRecorder; px: TilePixels; sm: Smudger } | null;
  lab: { tool: LabTool; ctx: LabContext & LabContextExt; sinks: Map<string, DabSink>; main: DabSink | null } | null;
  sources: Map<string, Surface>;
  assist: LineAssist | null;
  label: string;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function parseBg(bg: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(bg);
  if (!m) return null;
  const n = parseInt(m[1] as string, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function createPaintEngine(opts: EngineOptions = {}): PaintEngine & PaintEngineExt {
  return new Engine(opts);
}

class Engine implements PaintEngine, PaintEngineExt {
  private be: GLBackend | null;
  private readonly ownBackend: boolean;
  private canvasEl: HTMLCanvasElement | null = null;
  private readonly codec: PngCodec;
  private readonly assets: BrushAssets;

  private docW = 0;
  private docH = 0;
  private background = "transparent";
  private palette: string[] = [];
  private guidesJSON = "";
  private guides: GuidesConfig = defaultGuides();
  private source = "";
  private layers: Layer[] = [];
  private activeId = "";
  private nextLayerNum = 1;

  private readonly hist: History;
  private readonly listeners = new Map<EngineEvent, Set<() => void>>();
  private readonly dirtySave = new Map<string, Set<string>>();
  private readonly compDirty = new Set<string>();
  private compAll = true;
  private presentDirty = true;
  private readonly failed = new Map<string, string[]>();
  private readonly pool: Surface[] = [];
  private docCache: PaintDoc | null = null;
  private labMaxTicks: number;

  private stroke: StrokeState | null = null;
  private readonly finishing: StrokeState[] = [];
  private lastStroke: { tool: ToolState; points: InputPoint[]; stepId: HistoryId } | null = null;
  private preview: { rec: TileRecorder; layer: Layer; rect: Rect | null } | null = null;

  readonly selection: SelectionImpl;
  readonly transform: TransformImpl;
  readonly view: ViewImpl;

  private selSurf = new Map<string, Surface>();
  private selVer = -1;

  constructor(readonly opts: EngineOptions) {
    this.be = null;
    this.ownBackend = !opts.backend;
    this.codec = opts.codec ?? browserCodec();
    this.assets = new BrushAssets(() => this.backend(), opts.resolver ?? null);
    this.hist = new History({ ...DEFAULT_BUDGET, ...opts.budget });
    this.labMaxTicks = opts.labMaxTicks ?? 300;
    if (opts.backend) this.setBackend(opts.backend);
    this.view = new ViewImpl(
      () => ({ w: this.docW, h: this.docH }),
      () => {
        this.presentDirty = true;
        this.emit("view");
      },
    );
    this.selection = new SelectionImpl({
      size: () => ({ w: this.docW, h: this.docH }),
      pixels: (all) => this.selectionPixels(all),
      changed: () => {
        this.presentDirty = true;
        this.emit("selection");
      },
    });
    this.transform = new TransformImpl({
      activeLayer: () => this.activeLayer() ?? null,
      canvas: () => this.canvasRect(),
      selectionMask: () => this.selection.m,
      selectionBounds: () => this.selection.bounds(),
      backend: () => this.backend(),
      newRecorder: () => new TileRecorder(this.tileHost),
      touched: (l, k) => this.touched(l, k),
      commit: (step) => {
        this.hist.push(step);
        this.emit("history");
        this.emit("change");
        return step.id;
      },
      nextId: () => this.hist.newId(),
      changed: () => {
        this.presentDirty = true;
        this.emit("change");
      },
    });
  }

  // ---- infrastructure ----

  private readonly tileHost: TileHost = {
    backend: null as unknown as GLBackend,
    layer: (id) => this.layers.find((l) => l.id === id),
    touched: (l, k) => this.touched(l, k),
  };

  private backend(): GLBackend {
    if (!this.be) throw new PaintGLError("Paint+ needs a canvas before it can draw");
    return this.be;
  }

  private setBackend(be: GLBackend): void {
    this.be = be;
    this.tileHost.backend = be;
  }

  get backendName(): "webgl2" | "cpu" {
    return this.be?.name ?? "webgl2";
  }

  private emit(ev: EngineEvent): void {
    this.docCache = null;
    for (const cb of this.listeners.get(ev) ?? []) cb();
  }

  on(ev: EngineEvent, cb: () => void): () => void {
    let s = this.listeners.get(ev);
    if (!s) this.listeners.set(ev, (s = new Set()));
    s.add(cb);
    return () => s.delete(cb);
  }

  private canvasRect(): Rect {
    return { x: 0, y: 0, w: this.docW, h: this.docH };
  }

  private touched(layerId: string, key: string): void {
    let s = this.dirtySave.get(layerId);
    if (!s) this.dirtySave.set(layerId, (s = new Set()));
    s.add(key);
    this.compDirty.add(key);
    this.presentDirty = true;
  }

  private markAllComp(): void {
    this.compAll = true;
    this.presentDirty = true;
  }

  private acquire(): Surface {
    return this.pool.pop() ?? this.backend().createSurface();
  }
  private release(s: Surface): void {
    this.pool.push(s);
  }

  private activeLayer(): Layer | undefined {
    return this.layers.find((l) => l.id === this.activeId);
  }

  // ---- doc ----

  get doc(): Readonly<PaintDoc> {
    if (!this.docCache) {
      this.docCache = {
        version: 1,
        width: this.docW,
        height: this.docH,
        background: this.background,
        layers: this.layers.map((l) => ({
          id: l.id,
          name: l.props.name,
          hidden: l.props.hidden,
          locked: l.props.locked,
          alphaLock: l.props.alphaLock,
          clip: l.props.clip,
          reference: l.props.reference,
          opacity: l.props.opacity,
          blend: l.props.blend,
          tiles: [...l.tiles.keys()].sort(),
          rev: l.rev,
        })),
        active: this.activeId,
        palette: this.palette,
        guides: this.guidesJSON,
        tileSize: TILE,
        source: this.source,
      } as PaintDoc;
    }
    return this.docCache;
  }

  attach(canvas: HTMLCanvasElement): void {
    this.canvasEl = canvas;
    if (!this.be) this.setBackend(createGLBackend(canvas));
    this.view.setViewport(canvas.clientWidth || canvas.width, canvas.clientHeight || canvas.height);
    this.markAllComp();
    this.render();
  }

  detach(): void {
    this.canvasEl = null;
  }

  setViewport(w: number, h: number): void {
    this.view.setViewport(w, h);
  }

  setResolver(r: AssetResolver | null): void {
    this.assets.setResolver(r);
  }

  invalidateAsset(ref: string): void {
    this.assets.invalidate(ref);
  }

  prepareBrush(p: BrushPreset): Promise<void> {
    return this.assets.prepare(p);
  }

  getGuides(): GuidesConfig {
    return this.guides;
  }
  setGuides(g: GuidesConfig): void {
    this.guides = g;
    this.guidesJSON = stringifyGuides(g);
    this.emit("change");
  }

  failedTiles(): Map<string, string[]> {
    return new Map(this.failed);
  }
  clearFailedTiles(layerId: string): void {
    for (const k of this.failed.get(layerId) ?? []) this.touched(layerId, k);
    this.failed.delete(layerId);
    this.emit("change");
  }

  get stroking(): boolean {
    return this.stroke !== null;
  }

  setHistoryBudget(b: Partial<Budget>): void {
    this.hist.budget = { ...this.hist.budget, ...b };
    this.hist.enforce();
  }

  async load(doc: PaintDoc, tiles: TileSource): Promise<void> {
    const be = this.backend();
    this.cancelStroke();
    this.transform.cancel();
    this.clearLayers();
    this.hist.clear();
    this.docW = doc.width;
    this.docH = doc.height;
    this.background = doc.background || "transparent";
    this.palette = [...(doc.palette ?? [])];
    this.guidesJSON = doc.guides ?? "";
    this.guides = parseGuides(this.guidesJSON);
    this.source = doc.source ?? "";
    this.dirtySave.clear();
    this.failed.clear();
    this.nextLayerNum = 1;
    for (const l of doc.layers ?? []) {
      const layer: Layer = {
        id: l.id,
        props: { name: l.name, hidden: l.hidden, locked: l.locked, alphaLock: l.alphaLock, clip: l.clip, reference: l.reference, opacity: l.opacity, blend: l.blend },
        tiles: new Map(),
        rev: l.rev,
      };
      const n = /^l(\d+)$/.exec(l.id);
      if (n) this.nextLayerNum = Math.max(this.nextLayerNum, Number(n[1]) + 1);
      this.layers.push(layer);
      const keys = [...(l.tiles ?? [])];
      for (let i = 0; i < keys.length; i += 64) {
        const batch = keys.slice(i, i + 64);
        try {
          const got = await tiles.load(l.id, batch);
          for (const key of batch) {
            const bmp = got.get(key);
            if (!bmp) {
              this.fail(l.id, key);
              continue;
            }
            const raw = this.codec.fromBitmap(bmp);
            const s = be.createSurface();
            be.clear(s);
            const w = Math.min(raw.width, TILE);
            const h = Math.min(raw.height, TILE);
            const pm = premultiplied({ data: raw.data, width: raw.width, height: raw.height });
            be.upload(s, w === raw.width ? pm.data : cropRows(pm, w, h), 0, 0, w, h);
            layer.tiles.set(key, s);
          }
        } catch {
          for (const key of batch) this.fail(l.id, key);
        }
      }
    }
    if (this.layers.length === 0) this.layers.push(this.makeLayer({ name: "Layer 1" }));
    this.activeId = this.layers.some((l) => l.id === doc.active) ? doc.active : (this.layers[this.layers.length - 1] as Layer).id;
    be.resizeComposite(this.docW, this.docH);
    this.selection.reset();
    this.markAllComp();
    this.emit("layers");
    this.emit("history");
    this.emit("change");
    this.render();
  }

  private fail(layerId: string, key: string): void {
    const a = this.failed.get(layerId) ?? [];
    a.push(key);
    this.failed.set(layerId, a);
  }

  private clearLayers(): void {
    for (const l of this.layers) for (const s of l.tiles.values()) this.be?.destroySurface(s);
    this.layers = [];
    this.selSurf.clear();
  }

  private makeLayer(p: Partial<LayerProps>): Layer {
    return { id: `l${this.nextLayerNum++}`, props: { ...DEFAULT_PROPS, ...p }, tiles: new Map(), rev: 0 };
  }

  // ---- layers ----

  private pushStructural(label: string, undo: () => void, redo: () => void, extra?: { bytes?: () => number; release?: () => void; drop?: () => void }): HistoryId {
    const id = this.hist.newId();
    this.hist.push(
      new CompoundStep(id, label, this.canvasRect(), [], {
        undo: () => {
          undo();
          this.structureChanged();
        },
        redo: () => {
          redo();
          this.structureChanged();
        },
        extraBytes: extra?.bytes,
        release: extra?.release,
        drop: extra?.drop,
      }),
    );
    this.structureChanged();
    this.emit("history");
    return id;
  }

  private structureChanged(): void {
    this.markAllComp();
    this.emit("layers");
    this.emit("change");
  }

  addLayer(opts: Partial<LayerProps> = {}, index?: number): string {
    if (this.layers.length >= MAX_LAYERS) return this.activeId;
    const layer = this.makeLayer({ name: `Layer ${this.nextLayerNum}`, ...opts });
    const at = clamp(index ?? this.layers.findIndex((l) => l.id === this.activeId) + 1, 0, this.layers.length);
    const prevActive = this.activeId;
    this.insertLayer(layer, at);
    this.activeId = layer.id;
    let applied = true;
    this.pushStructural(
      "Add layer",
      () => {
        this.removeFromList(layer.id);
        this.activeId = prevActive;
        applied = false;
      },
      () => {
        this.insertLayer(layer, at);
        this.activeId = layer.id;
        applied = true;
      },
      { release: () => !applied && this.destroyLayer(layer) },
    );
    return layer.id;
  }

  private insertLayer(layer: Layer, at: number): void {
    this.layers.splice(clamp(at, 0, this.layers.length), 0, layer);
  }
  private removeFromList(id: string): number {
    const i = this.layers.findIndex((l) => l.id === id);
    if (i >= 0) this.layers.splice(i, 1);
    return i;
  }
  private destroyLayer(l: Layer): void {
    for (const s of l.tiles.values()) this.be?.destroySurface(s);
    l.tiles.clear();
  }

  removeLayer(id: string): void {
    if (this.layers.length <= 1) return;
    const layer = this.layers.find((l) => l.id === id);
    if (!layer) return;
    const prevActive = this.activeId;
    const at = this.removeFromList(id);
    if (this.activeId === id) this.activeId = (this.layers[Math.max(0, at - 1)] as Layer).id;
    const newActive = this.activeId;
    let removed = true;
    for (const k of layer.tiles.keys()) this.touched(id, k);
    this.pushStructural(
      "Delete layer",
      () => {
        this.insertLayer(layer, at);
        this.activeId = prevActive;
        removed = false;
      },
      () => {
        this.removeFromList(id);
        this.activeId = newActive;
        removed = true;
      },
      { bytes: () => (removed ? layer.tiles.size * TILE * TILE * 4 : 0), release: () => removed && this.destroyLayer(layer), drop: () => undefined },
    );
  }

  moveLayer(id: string, toIndex: number): void {
    const from = this.layers.findIndex((l) => l.id === id);
    if (from < 0) return;
    const to = clamp(toIndex, 0, this.layers.length - 1);
    if (from === to) return;
    const move = (a: number, b: number) => {
      const [l] = this.layers.splice(a, 1);
      this.layers.splice(b, 0, l as Layer);
    };
    move(from, to);
    this.pushStructural("Move layer", () => move(to, from), () => move(from, to));
  }

  setLayer(id: string, p: Partial<LayerProps>): void {
    const layer = this.layers.find((l) => l.id === id);
    if (!layer) return;
    const before = { ...layer.props };
    const after = { ...before, ...p };
    const keys = Object.keys(p).sort().join(",");
    // Dragging a slider is one step: merge into the previous step for the same layer.
    const top = this.hist.top() as (Step & { prop?: { id: string; keys: string; holder: { after: LayerProps } } }) | null;
    if (top?.prop && top.prop.id === id && top.prop.keys === keys && keys === "opacity") {
      layer.props = after;
      top.prop.holder.after = after;
      this.structureChanged();
      return;
    }
    const holder = { after };
    layer.props = after;
    const stepId = this.pushStructural(
      "Layer settings",
      () => {
        layer.props = before;
      },
      () => {
        layer.props = holder.after;
      },
    );
    const st = this.hist.steps.find((x) => x.id === stepId) as (Step & { prop?: unknown }) | undefined;
    if (st) st.prop = { id, keys, holder };
  }

  duplicateLayer(id: string): string {
    const src = this.layers.find((l) => l.id === id);
    if (!src || this.layers.length >= MAX_LAYERS) return this.activeId;
    const be = this.backend();
    const copy = this.makeLayer({ ...src.props, name: `${src.props.name} copy` });
    for (const [k, s] of src.tiles) {
      const c = be.createSurface();
      be.copy(c, s);
      copy.tiles.set(k, c);
      this.touched(copy.id, k);
    }
    const at = this.layers.findIndex((l) => l.id === id) + 1;
    const prevActive = this.activeId;
    this.insertLayer(copy, at);
    this.activeId = copy.id;
    let applied = true;
    this.pushStructural(
      "Duplicate layer",
      () => {
        this.removeFromList(copy.id);
        this.activeId = prevActive;
        applied = false;
      },
      () => {
        this.insertLayer(copy, at);
        this.activeId = copy.id;
        applied = true;
      },
      { bytes: () => copy.tiles.size * TILE * TILE * 4, release: () => !applied && this.destroyLayer(copy) },
    );
    return copy.id;
  }

  mergeDown(id: string): void {
    const i = this.layers.findIndex((l) => l.id === id);
    if (i <= 0) return;
    const be = this.backend();
    const top = this.layers[i] as Layer;
    const below = this.layers[i - 1] as Layer;
    const rec = new TileRecorder(this.tileHost);
    if (!top.props.hidden) {
      for (const [key, s] of top.tiles) {
        rec.touch(below, key);
        let t = below.tiles.get(key);
        if (!t) {
          t = be.createSurface();
          be.clear(t);
          below.tiles.set(key, t);
        }
        be.blend(t, s, { mode: blendId(top.props.blend), opacity: top.props.opacity });
        this.touched(below.id, key);
      }
    }
    const part = rec.toStep(this.hist.newId(), "Merge down", this.canvasRect());
    const prevActive = this.activeId;
    this.removeFromList(top.id);
    this.activeId = below.id;
    let removed = true;
    const step = new CompoundStep(this.hist.newId(), "Merge down", this.canvasRect(), [part], {
      undo: () => {
        this.insertLayer(top, i);
        this.activeId = prevActive;
        removed = false;
        this.structureChanged();
      },
      redo: () => {
        this.removeFromList(top.id);
        this.activeId = below.id;
        removed = true;
        this.structureChanged();
      },
      extraBytes: () => (removed ? top.tiles.size * TILE * TILE * 4 : 0),
      release: () => removed && this.destroyLayer(top),
    });
    this.hist.push(step);
    this.structureChanged();
    this.emit("history");
  }

  flatten(): void {
    const be = this.backend();
    const keys = new Set<string>();
    for (const l of this.layers) if (!l.props.hidden) for (const k of l.tiles.keys()) keys.add(k);
    const flat = this.makeLayer({ name: "Flattened" });
    const visible = (l: Layer) => !l.props.hidden;
    for (const key of keys) {
      const m = /^(-?\d+)_(-?\d+)$/.exec(key);
      if (!m) continue;
      const s = be.createSurface();
      this.composeTile(Number(m[1]), Number(m[2]), s, false, visible);
      flat.tiles.set(key, s);
    }
    const old = this.layers;
    const oldActive = this.activeId;
    for (const l of old) for (const k of l.tiles.keys()) this.touched(l.id, k);
    for (const k of flat.tiles.keys()) this.touched(flat.id, k);
    this.layers = [flat];
    this.activeId = flat.id;
    let applied = true;
    const free = (ls: Layer[]) => ls.forEach((l) => this.destroyLayer(l));
    this.pushStructural(
      "Flatten",
      () => {
        this.layers = old;
        this.activeId = oldActive;
        applied = false;
      },
      () => {
        this.layers = [flat];
        this.activeId = flat.id;
        applied = true;
      },
      {
        bytes: () => old.reduce((n, l) => n + l.tiles.size, 0) * TILE * TILE * 4,
        release: () => free(applied ? old : [flat]),
      },
    );
  }

  setActive(id: string): void {
    if (this.layers.some((l) => l.id === id) && id !== this.activeId) {
      this.activeId = id;
      this.emit("layers");
    }
  }

  // ---- compositor ----

  private selectionTile(key: string): Surface | null {
    const m = this.selection.m;
    if (!m) return null;
    if (this.selVer !== this.selection.version) {
      for (const s of this.selSurf.values()) this.release(s);
      this.selSurf.clear();
      this.selVer = this.selection.version;
    }
    let s = this.selSurf.get(key);
    if (s) return s;
    const mm = /^(-?\d+)_(-?\d+)$/.exec(key);
    if (!mm) return null;
    const ox = Number(mm[1]) * TILE;
    const oy = Number(mm[2]) * TILE;
    const w = Math.min(TILE, this.docW - ox);
    const h = Math.min(TILE, this.docH - oy);
    if (w <= 0 || h <= 0) return null;
    const be = this.backend();
    s = be.createSurface();
    be.clear(s);
    const a = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) a.set(m.subarray((oy + y) * this.docW + ox, (oy + y) * this.docW + ox + w), y * w);
    be.uploadAlpha(s, a, 0, 0, w, h);
    this.selSurf.set(key, s);
    return s;
  }

  private strokeStates(): StrokeState[] {
    return this.stroke ? [...this.finishing, this.stroke] : this.finishing;
  }

  private mergeParams(st: StrokeState, key: string): MergeParams {
    return {
      op: st.op,
      mode: st.mode,
      opacity: st.opacity,
      wetEdges: st.wetEdges,
      impasto: st.impasto,
      selection: this.selectionTile(key),
      source: st.sources.get(key) ?? null,
    };
  }

  /** The layer's tile for compositing, with running strokes merged in (temps go to `temps`). */
  private layerTile(layer: Layer, key: string, temps: Surface[]): Surface | null {
    let s = layer.tiles.get(key) ?? null;
    for (const st of this.strokeStates()) {
      if (st.layer !== layer || st.inert || st.maskKind) continue;
      const sc = st.scratch.get(key);
      const pr = st.pred.get(key);
      if (!sc && !pr) continue;
      const be = this.backend();
      const t = this.acquire();
      if (s) be.copy(t, s);
      else be.clear(t);
      if (sc) be.mergeScratch(t, sc, this.mergeParams(st, key));
      if (pr) be.mergeScratch(t, pr, this.mergeParams(st, key));
      temps.push(t);
      s = t;
    }
    return s;
  }

  /** Compose every visible layer's tile (tx, ty) into `out`. */
  private composeTile(tx: number, ty: number, out: Surface, withBg: boolean, only?: (l: Layer) => boolean): void {
    const be = this.backend();
    const key = tileKey(tx, ty);
    const rgb = parseBg(this.background);
    if (withBg && rgb) be.fill(out, rgb[0], rgb[1], rgb[2], 255);
    else be.clear(out);
    const L = only ? this.layers.filter(only) : this.layers;
    let i = 0;
    while (i < L.length) {
      const base = L[i] as Layer;
      i++;
      const group: Layer[] = [];
      while (i < L.length && (L[i] as Layer).props.clip) group.push(L[i++] as Layer);
      if (base.props.hidden) continue;
      const temps: Surface[] = [];
      const bs = this.layerTile(base, key, temps);
      if (bs) {
        if (group.length === 0) {
          be.blend(out, bs, { mode: blendId(base.props.blend), opacity: base.props.opacity });
        } else {
          const g = this.acquire();
          be.copy(g, bs);
          for (const c of group) {
            if (c.props.hidden) continue;
            const cs = this.layerTile(c, key, temps);
            if (cs) be.blend(g, cs, { mode: blendId(c.props.blend), opacity: c.props.opacity, atop: true });
          }
          be.blend(out, g, { mode: blendId(base.props.blend), opacity: base.props.opacity });
          this.release(g);
        }
      }
      for (const t of temps) this.release(t);
    }
  }

  /** Compose region r of the canvas (premultiplied; outside the canvas transparent). */
  private composeRegion(r: Rect, withBg: boolean, only?: (l: Layer) => boolean): PixelBuf {
    const be = this.backend();
    const out = newBuf(r.w, r.h);
    const clip = rectsIntersect(r, this.canvasRect());
    if (!clip) return out;
    const tmp = this.acquire();
    for (const key of tilesOf(clip)) {
      const m = /^(\d+)_(\d+)$/.exec(key) as RegExpExecArray;
      const tx = Number(m[1]);
      const ty = Number(m[2]);
      this.composeTile(tx, ty, tmp, withBg, only);
      const ov = rectsIntersect(clip, { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE });
      if (!ov) continue;
      const d = be.download(tmp, ov.x - tx * TILE, ov.y - ty * TILE, ov.w, ov.h);
      for (let y = 0; y < ov.h; y++) out.data.set(d.subarray(y * ov.w * 4, (y + 1) * ov.w * 4), ((ov.y - r.y + y) * r.w + (ov.x - r.x)) * 4);
    }
    this.release(tmp);
    return out;
  }

  private selectionPixels(sampleAll: boolean): PixelBuf {
    const only = sampleAll ? undefined : (l: Layer) => l.id === this.activeId || l.props.reference;
    return this.composeRegion(this.canvasRect(), sampleAll, only);
  }

  render(): void {
    const be = this.be;
    if (!be || !this.canvasEl || this.docW === 0) return;
    if (this.compAll || this.compDirty.size) {
      const tmp = this.acquire();
      const keys = this.compAll ? tilesOf(this.canvasRect()) : [...this.compDirty];
      for (const key of keys) {
        const m = /^(\d+)_(\d+)$/.exec(key);
        if (!m) continue;
        const tx = Number(m[1]);
        const ty = Number(m[2]);
        const w = Math.min(TILE, this.docW - tx * TILE);
        const h = Math.min(TILE, this.docH - ty * TILE);
        if (w <= 0 || h <= 0) continue;
        this.composeTile(tx, ty, tmp, true);
        be.storeComposite(tmp, tx * TILE, ty * TILE, w, h);
      }
      this.release(tmp);
      this.compAll = false;
      this.compDirty.clear();
      this.presentDirty = true;
    }
    if (!this.presentDirty) return;
    this.presentDirty = false;
    be.present({
      canvas: this.canvasEl,
      cssW: this.view.vw,
      cssH: this.view.vh,
      matrix: this.view.matrix(),
      docW: this.docW,
      docH: this.docH,
      checker: this.background === "transparent",
      nearest: this.view.state.zoom >= 2,
    });
  }

  /** Bring the composite texture up to date without presenting (tests). */
  readComposite(): Uint8ClampedArray {
    const be = this.backend();
    const tmp = this.acquire();
    for (const key of tilesOf(this.canvasRect())) {
      const m = /^(\d+)_(\d+)$/.exec(key) as RegExpExecArray;
      const tx = Number(m[1]);
      const ty = Number(m[2]);
      this.composeTile(tx, ty, tmp, true);
      be.storeComposite(tmp, tx * TILE, ty * TILE, Math.min(TILE, this.docW - tx * TILE), Math.min(TILE, this.docH - ty * TILE));
    }
    this.release(tmp);
    return be.readComposite();
  }

  // ---- strokes ----

  private symmetryOf(): GuidesConfig["symmetry"] {
    return this.guides.symmetry;
  }

  beginStroke(tool: ToolState, p: InputPoint): void {
    if (this.stroke) this.cancelStroke();
    if (this.transform.active) return;
    const layer = this.activeLayer();
    if (!layer || this.docW === 0) return;
    const maskKind = tool.kind === "mask";
    const inert = layer.props.locked || (layer.props.hidden && !maskKind);
    const preset = tool.brush;
    const erase = tool.kind === "eraser" || (tool.kind === "brush" && preset.blend === "erase");
    const coverageOnly = tool.kind !== "brush" && tool.kind !== "lab" ? true : erase;
    const st: StrokeState = {
      tool,
      layer,
      inert,
      renderer: null,
      style: null,
      op: erase ? "erase" : layer.props.alphaLock ? "atop" : "over",
      mode: tool.kind === "brush" ? blendId(preset.blend === "erase" ? "normal" : preset.blend) : 0,
      opacity: preset.opacity,
      wetEdges: preset.wet.edges,
      impasto: preset.rendering === "heavy" ? preset.impasto : 0,
      wet: preset.wet.mix > 0,
      maskKind,
      scratch: new Map(),
      pred: new Map(),
      predList: new DabList(),
      drawn: 0,
      bounds: null,
      smudge: null,
      lab: null,
      sources: new Map(),
      assist: assistActive(this.guides) ? new LineAssist(this.guides) : null,
      label: tool.kind === "eraser" ? "Erase" : tool.kind === "smudge" ? "Smudge" : tool.kind === "history" ? "History brush" : tool.kind === "lab" ? `Lab: ${tool.toolId}` : "Brush stroke",
    };
    if (tool.kind === "history") st.op = "revert";
    if (tool.kind === "mask" || tool.kind === "smudge") st.op = "over";
    this.stroke = st;
    if (inert) return;
    st.assist?.begin(p);
    const color: RGBA = tool.kind === "brush" || tool.kind === "lab" ? tool.color : { r: 0, g: 0, b: 0, a: 1 };
    const secondary: RGBA = tool.kind === "brush" ? tool.secondary : color;
    const cfg = { preset, color, secondary, seed: tool.seed, symmetry: this.symmetryOf() };
    if (tool.kind === "lab") {
      const t = getLabTool(tool.toolId);
      if (!t) {
        st.inert = true;
        return;
      }
      st.lab = { tool: t, ctx: this.labContext(st, tool), sinks: new Map(), main: null };
      t.onStrokeBegin(st.lab.ctx, p);
      return;
    }
    st.renderer = new StrokeRenderer(cfg);
    st.style = this.assets.style(preset, coverageOnly);
    if (tool.kind === "smudge") {
      const be = this.backend();
      const rec = new TileRecorder(this.tileHost);
      const px = new TilePixels(be, layer.tiles, (k) => rec.touch(layer, k), this.canvasRect());
      st.smudge = { rec, px, sm: new Smudger(px, st.style, preset.opacity, this.canvasRect(), layer.props.alphaLock, this.selection.m) };
    }
    st.renderer.begin(this.mapPoint(st, p));
    this.drawNew(st);
  }

  private mapPoint(st: StrokeState, p: InputPoint): InputPoint {
    return st.assist ? this.assistInto(st, p, { ...p }) : p;
  }

  private assistInto(st: StrokeState, p: InputPoint, out: InputPoint): InputPoint {
    const t = { x: p.x, y: p.y };
    st.assist?.map(p.x, p.y, t);
    out.x = t.x;
    out.y = t.y;
    return out;
  }

  extendStroke(points: InputPoint[], predicted: InputPoint[]): void {
    const st = this.stroke;
    if (!st || st.inert) return;
    if (st.lab) {
      st.lab.tool.onStrokeExtend(st.lab.ctx, points);
      this.presentDirty = true;
      this.emit("change");
      return;
    }
    const r = st.renderer;
    if (!r) return;
    r.add(st.assist ? points.map((p) => this.assistInto(st, p, { ...p })) : points);
    this.drawNew(st);
    if (!st.smudge) this.drawPredicted(st, st.assist ? predicted.map((p) => this.assistInto(st, p, { ...p })) : predicted);
    this.presentDirty = true;
    this.emit("change");
  }

  private dabBounds(f: Float32Array, start: number, end: number): Rect | null {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let n = start; n < end; n++) {
      const o = n * 20;
      const a = f[o + 5] as number;
      const s = f[o + 2] as number;
      if (a <= 0 || s <= 0) continue;
      const reach = (s / 2) * Math.SQRT2 + 2;
      const x = f[o] as number;
      const y = f[o + 1] as number;
      x0 = Math.min(x0, x - reach);
      y0 = Math.min(y0, y - reach);
      x1 = Math.max(x1, x + reach);
      y1 = Math.max(y1, y + reach);
    }
    if (x0 > x1) return null;
    return { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1) - Math.floor(x0), h: Math.ceil(y1) - Math.floor(y0) };
  }

  /** Draw dabs not yet drawn into the stroke's scratch (or smudge them). */
  private drawNew(st: StrokeState): void {
    const r = st.renderer;
    if (!r || !st.style) return;
    const list = r.dabs;
    if (list.count <= st.drawn) return;
    const start = st.drawn;
    st.drawn = list.count;
    if (st.smudge) {
      st.smudge.sm.run(list.data, start, list.count);
      for (const k of st.smudge.px.flush()) this.touched(st.layer.id, k);
      return;
    }
    this.drawDabsInto(st, st.scratch, { data: list.data, start, end: list.count }, st.style, true);
  }

  private drawDabsInto(st: StrokeState, target: Map<string, Surface>, batch: DabBatch, style: DabStyle, track: boolean): void {
    const bb = this.dabBounds(batch.data, batch.start, batch.end);
    if (!bb) return;
    const clip = rectsIntersect(bb, this.canvasRect());
    if (!clip) return;
    if (track) st.bounds = unionRect(st.bounds, clip);
    const be = this.backend();
    for (const key of tilesOf(clip)) {
      const m = /^(\d+)_(\d+)$/.exec(key) as RegExpExecArray;
      let s = target.get(key);
      if (!s) {
        s = be.createSurface();
        be.clear(s);
        target.set(key, s);
      }
      if (st.tool.kind === "history" && track && !st.sources.has(key)) {
        const src = this.historyTile(st.tool.source, st.layer.id, key);
        if (src) st.sources.set(key, src);
      }
      be.drawDabs(s, Number(m[1]) * TILE, Number(m[2]) * TILE, batch, style, st.wet ? (st.layer.tiles.get(key) ?? null) : null, this.canvasRect());
      this.compDirty.add(key);
    }
    this.presentDirty = true;
  }

  private drawPredicted(st: StrokeState, predicted: InputPoint[]): void {
    const r = st.renderer;
    if (!r || !st.style) return;
    for (const [key, s] of st.pred) {
      this.release(s);
      this.compDirty.add(key);
    }
    st.pred.clear();
    if (predicted.length === 0) return;
    r.preview(predicted, st.predList);
    if (st.predList.count === 0) return;
    this.drawDabsInto(st, st.pred, { data: st.predList.data, start: 0, end: st.predList.count }, st.style, false);
  }

  cancelStroke(): void {
    const st = this.stroke;
    if (!st) return;
    this.stroke = null;
    if (st.smudge) {
      st.smudge.rec.revert();
      st.smudge.rec.discard();
    }
    this.disposeStroke(st);
    this.markAllComp();
    this.emit("change");
  }

  private disposeStroke(st: StrokeState): void {
    const be = this.backend();
    for (const s of st.scratch.values()) be.destroySurface(s);
    for (const s of st.pred.values()) be.destroySurface(s);
    for (const s of st.sources.values()) be.destroySurface(s);
    st.scratch.clear();
    st.pred.clear();
    st.sources.clear();
  }

  strokePoints(): InputPoint[] {
    return this.stroke?.renderer?.raw.slice() ?? [];
  }

  endStroke(): StrokeResult {
    const st = this.stroke;
    const empty: StrokeResult = { history: null, bounds: { x: 0, y: 0, w: 0, h: 0 } };
    if (!st) return empty;
    this.stroke = null;
    if (st.inert) return empty;
    if (st.lab) {
      this.finishing.push(st);
      this.pendingLab = this.finishLab(st).finally(() => {
        const i = this.finishing.indexOf(st);
        if (i >= 0) this.finishing.splice(i, 1);
      });
      return empty;
    }
    return this.finishStroke(st);
  }

  private pendingLab: Promise<StrokeResult> | null = null;

  async endStrokeAsync(): Promise<StrokeResult> {
    const r = this.endStroke();
    return this.pendingLab ? await this.pendingLab : r;
  }

  private async finishLab(st: StrokeState): Promise<StrokeResult> {
    const lab = st.lab as NonNullable<StrokeState["lab"]>;
    lab.tool.onStrokeEnd(lab.ctx);
    if (lab.tool.step) {
      let tick = 0;
      while (tick < this.labMaxTicks && lab.tool.step(lab.ctx, tick++)) {
        /* fixed ticks */
      }
    }
    await flushTool(lab.tool);
    return this.finishStroke(st);
  }

  private finishStroke(st: StrokeState): StrokeResult {
    const be = this.backend();
    const r = st.renderer;
    if (r) {
      const retro = r.finish();
      if (retro && st.style && !st.smudge) {
        for (const s of st.scratch.values()) be.clear(s);
        st.drawn = 0;
        st.bounds = null;
      }
      this.drawNew(st);
    }
    if (st.lab) {
      for (const sink of st.lab.sinks.values()) this.finishSink(st, sink);
      if (st.lab.main) this.finishSink(st, st.lab.main);
    }
    const bounds = st.bounds ?? { x: 0, y: 0, w: 0, h: 0 };
    let result: StrokeResult;
    if (st.smudge) {
      const keys = st.smudge.rec.size;
      const sb = st.smudge.sm.bounds;
      if (keys === 0) {
        st.smudge.rec.discard();
        result = { history: null, bounds };
      } else {
        const step = st.smudge.rec.toStep(this.hist.newId(), st.label, sb ?? bounds);
        this.hist.push(step);
        result = { history: step.id, bounds: sb ?? bounds };
      }
    } else if (st.maskKind) {
      result = { history: null, bounds, mask: this.maskImage(st) };
    } else {
      this.settleBleed(st);
      result = this.mergeStroke(st);
    }
    this.disposeStroke(st);
    this.lastStroke = r ? { tool: st.tool, points: r.raw.slice(), stepId: result.history ?? 0 } : null;
    this.markAllComp();
    this.emit("history");
    this.emit("change");
    return result;
  }

  private finishSink(st: StrokeState, sink: DabSink): void {
    if (!sink.started) return;
    sink.renderer.finish();
    this.drawSink(st, sink);
  }

  private maskImage(st: StrokeState): ImageData {
    const b = st.bounds;
    if (!b || b.w <= 0 || b.h <= 0) return makeImageData(0, 0);
    const px = new TilePixels(this.backend(), st.scratch, null, this.canvasRect()).read(b);
    const out = new Uint8ClampedArray(b.w * b.h * 4);
    for (let i = 0; i < b.w * b.h; i++) {
      out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255;
      out[i * 4 + 3] = px.data[i * 4 + 3] as number;
    }
    return makeImageData(b.w, b.h, out);
  }

  /** Wet bleed: the stroke's paint spreads a little, on fixed ticks, before it merges. */
  private settleBleed(st: StrokeState): void {
    const amount = st.tool.brush.wet.bleed;
    if (amount <= 0 || !st.bounds || st.op === "erase" || st.op === "revert") return;
    const m = bleedMargin(amount);
    const region = rectsIntersect({ x: st.bounds.x - m, y: st.bounds.y - m, w: st.bounds.w + 2 * m, h: st.bounds.h + 2 * m }, this.canvasRect());
    if (!region) return;
    const px = new TilePixels(this.backend(), st.scratch, null, this.canvasRect());
    const buf = px.read(region);
    bleed(buf, amount);
    px.write(region, buf);
    px.flush();
    st.bounds = unionRect(st.bounds, region);
  }

  private mergeStroke(st: StrokeState): StrokeResult {
    const be = this.backend();
    const rec = new TileRecorder(this.tileHost);
    const layer = st.layer;
    for (const [key, sc] of st.scratch) {
      if (st.op === "erase" && st.layer.props.alphaLock) continue;
      rec.touch(layer, key);
      let t = layer.tiles.get(key);
      if (!t) {
        if (st.op === "erase") continue;
        t = be.createSurface();
        be.clear(t);
        layer.tiles.set(key, t);
      }
      be.mergeScratch(t, sc, this.mergeParams(st, key));
      this.touched(layer.id, key);
    }
    if (rec.size === 0) {
      rec.discard();
      return { history: null, bounds: st.bounds ?? { x: 0, y: 0, w: 0, h: 0 } };
    }
    const step = rec.toStep(this.hist.newId(), st.label, st.bounds ?? this.canvasRect());
    this.hist.push(step);
    return { history: step.id, bounds: st.bounds ?? this.canvasRect() };
  }

  restroke(tool: ToolState, points: InputPoint[]): StrokeResult {
    const last = this.lastStroke;
    if (last && last.stepId !== 0 && this.hist.top()?.id === last.stepId) this.undo();
    const first = points[0];
    if (!first) return { history: null, bounds: { x: 0, y: 0, w: 0, h: 0 } };
    this.beginStroke(tool, first);
    this.extendStroke(points.slice(1), []);
    return this.endStroke();
  }

  // ---- Lab ----

  private labContext(st: StrokeState, tool: Extract<ToolState, { kind: "lab" }>): LabContext & LabContextExt {
    const self = this;
    const lab = (): NonNullable<StrokeState["lab"]> => st.lab as NonNullable<StrokeState["lab"]>;
    const sinkFor = (style: Record<string, unknown> | null): DabSink => {
      const key = style ? JSON.stringify(style) : "";
      const l = lab();
      let s = key ? l.sinks.get(key) : l.main;
      if (s) return s;
      let preset: BrushPreset = tool.brush;
      let color = tool.color;
      if (style) {
        const sc = typeof style.sizeScale === "number" ? style.sizeScale : 1;
        const op = typeof style.opacity === "number" ? style.opacity : 1;
        preset = { ...preset, size: preset.size * sc, flow: preset.flow * op, tip: { ...preset.tip } };
        if (typeof style.tip === "string" && style.tip !== "brush") preset.tip.shape = style.tip;
        if (typeof style.angle === "number") {
          preset.tip.angle = style.angle;
          preset.tip.angleMode = "fixed";
        }
        if (style.color) color = style.color as RGBA;
      }
      void this.assets.prepare(preset);
      s = {
        renderer: new StrokeRenderer({ preset, color, secondary: color, seed: tool.seed, symmetry: self.symmetryOf() }),
        style: this.assets.style(preset, false),
        drawn: 0,
        started: false,
      };
      if (key) l.sinks.set(key, s);
      else l.main = s;
      return s;
    };
    const feed = (points: InputPoint[], style: Record<string, unknown> | null) => {
      if (points.length === 0) return;
      const sink = sinkFor(style);
      if (!sink.started) {
        sink.started = true;
        sink.renderer.begin(points[0] as InputPoint);
        sink.renderer.add(points.slice(1));
      } else sink.renderer.add(points);
      self.drawSink(st, sink);
      self.presentDirty = true;
    };
    const ctx: LabContext & LabContextExt = {
      rng: (key) => keyedRng(tool.seed, key),
      snapshot: async (r) => straightImage(new TilePixels(self.backend(), st.layer.tiles, null, self.canvasRect()).read(r)),
      gl: this.be?.gl ?? null,
      dab: (points) => feed(points, null),
      dabAs: (points, style) => feed(points, style as unknown as Record<string, unknown>),
      composite: (img, r, mask) => self.labComposite(st, img, r, mask),
      clearScratch: (r) => self.labClear(st, r),
      params: tool.params,
      seed: tool.seed,
      brushSize: tool.brush.size,
      brushHardness: tool.brush.tip.hardness,
      color: tool.color,
    };
    return ctx;
  }

  private drawSink(st: StrokeState, sink: DabSink): void {
    const list = sink.renderer.dabs;
    if (list.count <= sink.drawn) return;
    const start = sink.drawn;
    sink.drawn = list.count;
    this.drawDabsInto(st, st.scratch, { data: list.data, start, end: list.count }, sink.style, true);
  }

  private labComposite(st: StrokeState, img: ImageData | ImageBitmap, r: Rect, mask?: ImageData): void {
    const raw = "data" in img ? img : this.codec.fromBitmap(img);
    const src = premultiplied(raw);
    const px = new TilePixels(this.backend(), st.scratch, null, this.canvasRect());
    const clip = rectsIntersect(r, this.canvasRect());
    if (!clip) return;
    const dst = px.read(clip);
    for (let y = 0; y < clip.h; y++) {
      for (let x = 0; x < clip.w; x++) {
        const sx = clip.x - r.x + x;
        const sy = clip.y - r.y + y;
        const so = (sy * src.w + sx) * 4;
        let k = 1;
        if (mask) {
          const mx = sx < mask.width ? sx : mask.width - 1;
          const my = sy < mask.height ? sy : mask.height - 1;
          k = (mask.data[(my * mask.width + mx) * 4 + 3] as number) / 255;
        }
        if (k <= 0) continue;
        const a = ((src.data[so + 3] as number) / 255) * k;
        if (a <= 0) continue;
        blendInto(dst.data, (y * clip.w + x) * 4, ((src.data[so] as number) / 255) * k, ((src.data[so + 1] as number) / 255) * k, ((src.data[so + 2] as number) / 255) * k, a, 0, false);
      }
    }
    px.write(clip, dst);
    px.flush();
    st.bounds = unionRect(st.bounds, clip);
    for (const key of tilesOf(clip)) this.compDirty.add(key);
    this.presentDirty = true;
  }

  private labClear(st: StrokeState, r: Rect): void {
    const clip = rectsIntersect(r, this.canvasRect());
    if (!clip) return;
    const px = new TilePixels(this.backend(), st.scratch, null, this.canvasRect());
    px.write(clip, newBuf(clip.w, clip.h));
    px.flush();
    for (const key of tilesOf(clip)) this.compDirty.add(key);
    this.presentDirty = true;
  }

  // ---- pixels in and out ----

  readPixels(r: Rect, src: "layer" | "merged", layerId?: string): PixelBuf {
    if (src === "merged") return this.composeRegion(r, true);
    const l = layerId ? this.layers.find((x) => x.id === layerId) : this.activeLayer();
    if (!l) return newBuf(r.w, r.h);
    return new TilePixels(this.backend(), l.tiles, null, this.canvasRect()).read(r);
  }

  async readRegion(r: Rect, src: "layer" | "merged"): Promise<ImageData> {
    return straightImage(this.readPixels(r, src));
  }

  /** A change to one layer's pixels as one undo step. fn returns the changed bounds (null = nothing). */
  private edit(layer: Layer, label: string, fn: (px: TilePixels) => Rect | null): HistoryId | null {
    const rec = new TileRecorder(this.tileHost);
    const px = new TilePixels(this.backend(), layer.tiles, (k) => rec.touch(layer, k), this.canvasRect());
    const bounds = fn(px);
    if (!bounds) {
      rec.discard();
      return null;
    }
    const keys = px.flush();
    if (keys.length === 0) {
      rec.discard();
      return null;
    }
    for (const k of keys) this.touched(layer.id, k);
    rec.addBounds(bounds);
    const step = rec.toStep(this.hist.newId(), label, bounds);
    this.hist.push(step);
    this.emit("history");
    this.emit("change");
    return step.id;
  }

  private selectionFactor(r: Rect): Uint8Array | null {
    const m = this.selection.m;
    if (!m) return null;
    const out = new Uint8Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) {
      const cy = r.y + y;
      if (cy < 0 || cy >= this.docH) continue;
      for (let x = 0; x < r.w; x++) {
        const cx = r.x + x;
        if (cx >= 0 && cx < this.docW) out[y * r.w + x] = m[cy * this.docW + cx] as number;
      }
    }
    return out;
  }

  /** dst = lerp(dst, src, weight) over r, where weight = mask alpha × selection. */
  private lerpInto(px: TilePixels, r: Rect, src: PixelBuf, mask: Uint8Array | null): Rect | null {
    const clip = rectsIntersect(r, this.canvasRect());
    if (!clip) return null;
    const sel = this.selectionFactor(clip);
    const cur = px.read(clip);
    for (let y = 0; y < clip.h; y++) {
      for (let x = 0; x < clip.w; x++) {
        const sx = clip.x - r.x + x;
        const sy = clip.y - r.y + y;
        let k = 1;
        if (mask) k = (mask[sy * r.w + sx] as number) / 255;
        if (sel) k *= (sel[y * clip.w + x] as number) / 255;
        if (k <= 0) continue;
        const so = (sy * src.w + sx) * 4;
        const o = (y * clip.w + x) * 4;
        for (let c = 0; c < 4; c++) cur.data[o + c] = Math.round((cur.data[o + c] as number) + ((src.data[so + c] as number) - (cur.data[o + c] as number)) * k);
      }
    }
    px.write(clip, cur);
    return clip;
  }

  private maskWeights(r: Rect, mask?: ImageData, feather?: number): Uint8Array | null {
    if (!mask) return null;
    const m = new Uint8Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) {
      const my = Math.min(y, mask.height - 1);
      for (let x = 0; x < r.w; x++) m[y * r.w + x] = mask.data[(my * mask.width + Math.min(x, mask.width - 1)) * 4 + 3] as number;
    }
    return feather && feather > 0 ? featherMask(m, r.w, r.h, feather) : m;
  }

  writeRegion(layerId: string, r: Rect, img: ImageBitmap | ImageData, mask?: ImageData, feather?: number, label = "Write region"): HistoryId {
    const layer = this.layers.find((l) => l.id === layerId);
    if (!layer) return 0;
    const raw = "data" in img ? img : this.codec.fromBitmap(img);
    const src = premultiplied(raw);
    const w = this.maskWeights({ ...r, w: src.w, h: src.h }, mask, feather);
    const id = this.edit(layer, label, (px) => this.lerpInto(px, { x: r.x, y: r.y, w: src.w, h: src.h }, src, w));
    return id ?? 0;
  }

  fill(at: Point, o: { tolerance: number; sampleAll: boolean; color: RGBA }): HistoryId | null {
    const layer = this.activeLayer();
    if (!layer || layer.props.locked || this.docW === 0) return null;
    const x = Math.floor(at.x);
    const y = Math.floor(at.y);
    if (x < 0 || y < 0 || x >= this.docW || y >= this.docH) return null;
    const pix = this.selectionPixels(o.sampleAll);
    let m = floodMask(pix.data, this.docW, this.docH, x, y, o.tolerance, true, this.selection.m);
    m = haloMask(m, this.docW, this.docH);
    const bb = maskBounds(m, this.docW, this.docH);
    if (!bb) return null;
    const { r, g, b, a } = o.color;
    const sel = this.selection.m;
    return this.edit(layer, "Fill", (px) => {
      const buf = px.read(bb);
      for (let j = 0; j < bb.h; j++) {
        for (let i = 0; i < bb.w; i++) {
          const gi = (bb.y + j) * this.docW + bb.x + i;
          let cov = ((m[gi] as number) / 255) * a;
          if (sel) cov *= (sel[gi] as number) / 255;
          if (cov <= 0) continue;
          blendInto(buf.data, (j * bb.w + i) * 4, r * cov, g * cov, b * cov, cov, 0, layer.props.alphaLock);
        }
      }
      px.write(bb, buf);
      return bb;
    });
  }

  // ---- canvas ----

  private replaceTiles(label: string, w: number, h: number, build: (l: Layer, old: Map<string, Surface>) => Map<string, Surface>): HistoryId {
    const oldW = this.docW;
    const oldH = this.docH;
    const olds = this.layers.map((l) => ({ l, tiles: l.tiles }));
    const news = olds.map(({ l, tiles }) => ({ l, tiles: build(l, tiles) }));
    for (const { l, tiles } of olds) for (const k of tiles.keys()) this.touched(l.id, k);
    const apply = (set: Array<{ l: Layer; tiles: Map<string, Surface> }>, W: number, H: number) => {
      for (const { l, tiles } of set) l.tiles = tiles;
      this.docW = W;
      this.docH = H;
      this.backend().resizeComposite(W, H);
      this.selection.reset();
      for (const { l, tiles } of set) for (const k of tiles.keys()) this.touched(l.id, k);
    };
    apply(news, w, h);
    let applied = true;
    const free = (set: typeof olds) => set.forEach(({ tiles }) => tiles.forEach((s) => this.be?.destroySurface(s)));
    return this.pushStructural(
      label,
      () => {
        apply(olds, oldW, oldH);
        applied = false;
      },
      () => {
        apply(news, w, h);
        applied = true;
      },
      { bytes: () => olds.reduce((n, o) => n + o.tiles.size, 0) * TILE * TILE * 4, release: () => free(applied ? olds : news) },
    );
  }

  resizeCanvas(w: number, h: number, anchor: Point, background?: RGBA): HistoryId {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    const ox = Math.round((w - this.docW) * clamp(anchor.x, 0, 1));
    const oy = Math.round((h - this.docH) * clamp(anchor.y, 0, 1));
    const be = this.backend();
    const oldRect = this.canvasRect();
    const bottom = this.layers[0];
    return this.replaceTiles("Canvas size", w, h, (layer, old) => {
      const src = new TilePixels(be, old, null, oldRect);
      const out = new Map<string, Surface>();
      for (const key of tilesOf({ x: 0, y: 0, w, h })) {
        const m = /^(\d+)_(\d+)$/.exec(key) as RegExpExecArray;
        const tr = { x: Number(m[1]) * TILE, y: Number(m[2]) * TILE, w: TILE, h: TILE };
        const buf = src.read({ x: tr.x - ox, y: tr.y - oy, w: TILE, h: TILE });
        if (layer === bottom && background && background.a > 0) {
          for (let j = 0; j < TILE; j++) {
            for (let i = 0; i < TILE; i++) {
              const cx = tr.x + i - ox;
              const cy = tr.y + j - oy;
              if (cx >= 0 && cy >= 0 && cx < oldRect.w && cy < oldRect.h) continue;
              if (tr.x + i >= w || tr.y + j >= h) continue;
              const o = (j * TILE + i) * 4;
              buf.data[o] = Math.round(background.r * background.a * 255);
              buf.data[o + 1] = Math.round(background.g * background.a * 255);
              buf.data[o + 2] = Math.round(background.b * background.a * 255);
              buf.data[o + 3] = Math.round(background.a * 255);
            }
          }
        }
        // Keep the canvas clean beyond its new edge.
        for (let j = 0; j < TILE; j++) for (let i = 0; i < TILE; i++) if (tr.x + i >= w || tr.y + j >= h) buf.data.fill(0, (j * TILE + i) * 4, (j * TILE + i) * 4 + 4);
        if (isEmpty(buf.data)) continue;
        const s = be.createSurface();
        be.clear(s);
        be.upload(s, buf.data, 0, 0, TILE, TILE);
        out.set(key, s);
      }
      return out;
    });
  }

  resample(w: number, h: number, mode: Resample = "bilinear"): HistoryId {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    const be = this.backend();
    const oldW = this.docW;
    const oldH = this.docH;
    const sx = oldW / w;
    const sy = oldH / h;
    const oldRect = this.canvasRect();
    return this.replaceTiles("Image size", w, h, (_layer, old) => {
      const src = new TilePixels(be, old, null, oldRect);
      const out = new Map<string, Surface>();
      for (const key of tilesOf({ x: 0, y: 0, w, h })) {
        const m = /^(\d+)_(\d+)$/.exec(key) as RegExpExecArray;
        const dx = Number(m[1]) * TILE;
        const dy = Number(m[2]) * TILE;
        const tw = Math.min(TILE, w - dx);
        const th = Math.min(TILE, h - dy);
        const pad = 3;
        const region: Rect = { x: Math.floor(dx * sx) - pad, y: Math.floor(dy * sy) - pad, w: Math.ceil(tw * sx) + 2 * pad + 1, h: Math.ceil(th * sy) + 2 * pad + 1 };
        const sbuf = src.read(region);
        if (isEmpty(sbuf.data)) continue;
        // Resize the source region onto the tile's pixels.
        const scaled = resizeBuf(sbuf, Math.max(1, Math.round(sbuf.w / sx)), Math.max(1, Math.round(sbuf.h / sy)), mode);
        const ox = Math.round((dx * sx - region.x) / sx);
        const oy = Math.round((dy * sy - region.y) / sy);
        const tile = newBuf(TILE, TILE);
        for (let j = 0; j < th; j++) {
          for (let i = 0; i < tw; i++) {
            const si = ((j + oy) * scaled.w + (i + ox)) * 4;
            if (i + ox < 0 || j + oy < 0 || i + ox >= scaled.w || j + oy >= scaled.h) continue;
            tile.data.set(scaled.data.subarray(si, si + 4), (j * TILE + i) * 4);
          }
        }
        if (isEmpty(tile.data)) continue;
        const s = be.createSurface();
        be.clear(s);
        be.upload(s, tile.data, 0, 0, TILE, TILE);
        out.set(key, s);
      }
      return out;
    });
  }

  // ---- history ----

  private afterHistory(): void {
    this.markAllComp();
    this.emit("history");
    this.emit("layers");
    this.emit("change");
  }

  undo(): boolean {
    this.cancelStroke();
    const ok = this.hist.undo();
    if (ok) this.afterHistory();
    return ok;
  }
  redo(): boolean {
    this.cancelStroke();
    const ok = this.hist.redo();
    if (ok) this.afterHistory();
    return ok;
  }
  jumpTo(id: HistoryId): void {
    this.cancelStroke();
    this.hist.jumpTo(id);
    this.afterHistory();
  }
  history(): HistoryEntry[] {
    return this.hist.entries();
  }
  historyCursor(): number {
    return this.hist.cursor === 0 ? 0 : (this.hist.steps[this.hist.cursor - 1] as Step).id;
  }
  memoryBytes(): number {
    return this.hist.totalBytes();
  }

  /** The tile `key` of `layerId` as it was just after history step `id`, as a fresh surface (null = transparent). */
  private historyTile(id: HistoryId, layerId: string, key: string): Surface | null {
    const d = this.tileDataAt(id, layerId, key);
    if (!d || d.k === "empty" || d.k === "gone") return null;
    const be = this.backend();
    if (d.k === "gpu") {
      const c = be.createSurface();
      be.copy(c, d.s);
      return c;
    }
    return materialise(be, d);
  }

  private tileDataAt(id: HistoryId, layerId: string, key: string): TileData | null {
    const steps = this.hist.steps;
    const k = steps.findIndex((s) => s.id === id);
    if (k < 0) return null;
    const c = this.hist.cursor;
    const find = (j: number): TileData | undefined => {
      for (const p of (steps[j] as Step).tileParts()) {
        const d = p.peek(layerId, key);
        if (d) return d;
      }
      return undefined;
    };
    if (k >= c) {
      for (let j = k; j >= c; j--) {
        const d = find(j);
        if (d) return d;
      }
    } else if (k < c - 1) {
      for (let j = k + 1; j <= c - 1; j++) {
        const d = find(j);
        if (d) return d;
      }
    }
    const cur = this.layers.find((l) => l.id === layerId)?.tiles.get(key);
    return cur ? { k: "gpu", s: cur } : { k: "empty" };
  }

  async snapshotAt(id: HistoryId, r: Rect): Promise<ImageData> {
    const be = this.backend();
    const layer = this.activeLayer();
    const out = newBuf(r.w, r.h);
    if (!layer) return straightImage(out);
    const clip = rectsIntersect(r, this.canvasRect());
    if (clip) {
      for (const key of tilesOf(clip)) {
        const d = this.tileDataAt(id, layer.id, key);
        if (!d || d.k === "empty" || d.k === "gone") continue;
        const px = d.k === "gpu" ? be.download(d.s, 0, 0, TILE, TILE) : unpackRam(d);
        const m = /^(\d+)_(\d+)$/.exec(key) as RegExpExecArray;
        const ov = rectsIntersect(clip, { x: Number(m[1]) * TILE, y: Number(m[2]) * TILE, w: TILE, h: TILE });
        if (!ov) continue;
        for (let y = 0; y < ov.h; y++) {
          const so = ((ov.y - Number(m[2]) * TILE + y) * TILE + (ov.x - Number(m[1]) * TILE)) * 4;
          out.data.set(px.subarray(so, so + ov.w * 4), ((ov.y - r.y + y) * r.w + (ov.x - r.x)) * 4);
        }
      }
    }
    return straightImage(out);
  }

  // ---- previews (adjustments) ----

  beginPreview(layerId?: string): PreviewSession {
    const layer = (layerId ? this.layers.find((l) => l.id === layerId) : this.activeLayer()) as Layer;
    const rec = new TileRecorder(this.tileHost);
    const self = this;
    const state = { rec, layer, rect: null as Rect | null };
    this.preview = state;
    return {
      set(r, img, mask) {
        const clip = rectsIntersect(r, self.canvasRect());
        if (!clip) return;
        for (const key of tilesOf(clip)) rec.touch(layer, key);
        rec.revert();
        const src = premultiplied(img);
        const w = self.maskWeights({ ...r, w: src.w, h: src.h }, mask);
        const px = new TilePixels(self.backend(), layer.tiles, null, self.canvasRect());
        const b = self.lerpInto(px, { x: r.x, y: r.y, w: src.w, h: src.h }, src, w);
        for (const k of px.flush()) self.touched(layer.id, k);
        if (b) {
          state.rect = unionRect(state.rect, b);
          rec.addBounds(b);
        }
        self.emit("change");
      },
      cancel() {
        rec.revert();
        rec.discard();
        if (self.preview === state) self.preview = null;
        self.emit("change");
      },
      commit(label = "Adjustment") {
        if (self.preview === state) self.preview = null;
        if (rec.size === 0) {
          rec.discard();
          return 0;
        }
        const step = rec.toStep(self.hist.newId(), label, state.rect ?? self.canvasRect());
        self.hist.push(step);
        self.emit("history");
        self.emit("change");
        return step.id;
      },
    };
  }

  // ---- saving ----

  dirtyTiles(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const [l, s] of this.dirtySave) if (s.size) out.set(l, new Set(s));
    return out;
  }

  markSaved(layerId: string, keys: string[]): void {
    const s = this.dirtySave.get(layerId);
    if (!s) return;
    for (const k of keys) s.delete(k);
    if (s.size === 0) this.dirtySave.delete(layerId);
  }

  async encodeTile(layerId: string, key: string): Promise<Blob | null> {
    const layer = this.layers.find((l) => l.id === layerId);
    const s = layer?.tiles.get(key);
    const m = /^(-?\d+)_(-?\d+)$/.exec(key);
    if (!layer || !s || !m) return null;
    const w = Math.min(TILE, this.docW - Number(m[1]) * TILE);
    const h = Math.min(TILE, this.docH - Number(m[2]) * TILE);
    if (w <= 0 || h <= 0) return null;
    const px = this.backend().download(s, 0, 0, w, h);
    if (isEmpty(px)) {
      this.backend().destroySurface(s);
      layer.tiles.delete(key);
      this.docCache = null;
      return null;
    }
    const img = straightImage({ w, h, data: px });
    const bytes = await this.codec.encode({ data: img.data, width: w, height: h });
    return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/png" });
  }

  async flattenToBitmap(scale: number): Promise<ImageBitmap> {
    let buf = this.composeRegion(this.canvasRect(), true);
    if (scale !== 1) buf = resizeBuf(buf, Math.max(1, Math.round(this.docW * scale)), Math.max(1, Math.round(this.docH * scale)), scale > 1 ? "bicubic" : "bilinear");
    const img = straightImage(buf);
    return this.codec.toBitmap({ data: img.data, width: img.width, height: img.height });
  }

  dispose(): void {
    this.cancelStroke();
    this.clearLayers();
    this.hist.clear();
    this.assets.dispose();
    for (const s of this.pool) this.be?.destroySurface(s);
    this.pool.length = 0;
    if (this.ownBackend) this.be?.dispose();
  }
}

function cropRows(pm: PixelBuf, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(pm.data.subarray(y * pm.w * 4, y * pm.w * 4 + w * 4), y * w * 4);
  return out;
}

function unpackRam(d: Extract<TileData, { k: "ram" }>): Uint8ClampedArray {
  const out = new Uint8ClampedArray(TILE * TILE * 4);
  for (let y = 0; y < d.h; y++) out.set(d.px.subarray(y * d.w * 4, (y + 1) * d.w * 4), ((d.y + y) * TILE + d.x) * 4);
  return out;
}

export type { LabContext };
