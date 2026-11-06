/**
 * A fake PaintEngine for building and testing the UI before P1's engine is
 * wired in (engine-adapter.ts). It draws round dabs on 2D canvases (one per
 * layer), keeps whole-layer snapshots for undo, tracks dirty tiles, and has
 * no WebGL. In jsdom (no 2D canvas) every pixel operation is skipped, so the
 * layer, history, dirty-tile and event logic still runs.
 */
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
  type SelectionAPI,
  type StrokeResult,
  type TileSource,
  type ToolState,
  type TransformAPI,
  type ViewAPI,
  type ViewState,
} from "@/paint/engine/types";

const IS_JSDOM = typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent);

type Ctx = CanvasRenderingContext2D;

function ctxOf(c: HTMLCanvasElement | null): Ctx | null {
  if (!c || IS_JSDOM) return null;
  return c.getContext("2d");
}

interface LayerPix {
  canvas: HTMLCanvasElement | null;
}

interface Snapshot {
  id: HistoryId;
  label: string;
  bounds: Rect;
  /** layerId → canvas copy before the step. */
  before: Map<string, HTMLCanvasElement | null>;
  doc: string;
}

const css = (c: { r: number; g: number; b: number; a: number }) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;

export class FakeEngine implements PaintEngine {
  private _doc: PaintDoc = { version: 1, width: 0, height: 0, background: "#ffffff", layers: [], active: "", palette: [], guides: "", tileSize: TILE, source: "" };
  private canvas: HTMLCanvasElement | null = null;
  private pix = new Map<string, LayerPix>();
  private listeners = new Map<EngineEvent, Set<() => void>>();
  private dirty = new Map<string, Set<string>>();
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private nextLayer = 1;
  private nextHistory = 1;
  private stroke: { tool: ToolState; last: InputPoint; bounds: Rect; before: Snapshot; any: boolean } | null = null;
  private v: ViewState = { zoom: 1, panX: 0, panY: 0, rotation: 0, flipped: false };
  private raf = 0;
  /** Test hook: how many strokes ended. */
  strokes = 0;

  get doc(): Readonly<PaintDoc> {
    return this._doc;
  }

  readonly selection: SelectionAPI = (() => {
    let b: Rect | null = null;
    const set = (r: Rect | null) => {
      b = r;
      this.emit("selection");
    };
    return {
      get active() {
        return b !== null;
      },
      bounds: () => b,
      rect: (r: Rect) => set(r),
      ellipse: (r: Rect) => set(r),
      lasso: (pts: Point[]) => {
        if (!pts.length) return;
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        set({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
      },
      wand: (at: Point) => set({ x: at.x - 40, y: at.y - 40, w: 80, h: 80 }),
      fromMask: (_m: ImageData, at: Point) => set({ x: at.x, y: at.y, w: 1, h: 1 }),
      invert: () => this.emit("selection"),
      feather: () => undefined,
      grow: () => undefined,
      clear: () => set(null),
      mask: () => null,
    } satisfies SelectionAPI;
  })();

  readonly transform: TransformAPI = (() => {
    let on = false;
    return {
      get active() {
        return on;
      },
      begin: () => {
        on = true;
      },
      set: () => undefined,
      flip: () => undefined,
      rotate90: () => undefined,
      commit: () => {
        on = false;
        return this.push("Transform", { x: 0, y: 0, w: this._doc.width, h: this._doc.height });
      },
      cancel: () => {
        on = false;
      },
    } satisfies TransformAPI;
  })();

  readonly view: ViewAPI = {
    get: () => ({ ...this.v }),
    set: (p) => {
      this.v = { ...this.v, ...p };
      this.emit("view");
      this.schedule();
    },
    fit: () => {
      const c = this.canvas;
      if (!c || !this._doc.width) return;
      const zoom = Math.min((c.clientWidth || c.width) / this._doc.width, (c.clientHeight || c.height) / this._doc.height) * 0.92;
      this.view.set({ zoom: zoom || 1, panX: 0, panY: 0, rotation: 0 });
    },
    actual: () => this.view.set({ zoom: 1, panX: 0, panY: 0 }),
    screenToCanvas: (p) => {
      const c = this.canvas;
      const cx = (c?.clientWidth ?? 0) / 2 + this.v.panX;
      const cy = (c?.clientHeight ?? 0) / 2 + this.v.panY;
      const rad = (-this.v.rotation * Math.PI) / 180;
      const dx = p.x - cx;
      const dy = p.y - cy;
      let x = dx * Math.cos(rad) - dy * Math.sin(rad);
      const y = dx * Math.sin(rad) + dy * Math.cos(rad);
      if (this.v.flipped) x = -x;
      return { x: x / this.v.zoom + this._doc.width / 2, y: y / this.v.zoom + this._doc.height / 2 };
    },
    canvasToScreen: (p) => {
      const c = this.canvas;
      let x = (p.x - this._doc.width / 2) * this.v.zoom;
      const y = (p.y - this._doc.height / 2) * this.v.zoom;
      if (this.v.flipped) x = -x;
      const rad = (this.v.rotation * Math.PI) / 180;
      return { x: x * Math.cos(rad) - y * Math.sin(rad) + (c?.clientWidth ?? 0) / 2 + this.v.panX, y: x * Math.sin(rad) + y * Math.cos(rad) + (c?.clientHeight ?? 0) / 2 + this.v.panY };
    },
  };

  attach(canvas: HTMLCanvasElement): void {
    if (!IS_JSDOM && !canvas.getContext) throw new PaintGLError();
    this.canvas = canvas;
    this.schedule();
  }

  detach(): void {
    this.canvas = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  async load(doc: PaintDoc, tiles: TileSource): Promise<void> {
    this._doc = { ...doc, layers: (doc.layers ?? []).map((l) => ({ ...l })) };
    this.pix.clear();
    this.dirty.clear();
    this.undoStack = [];
    this.redoStack = [];
    for (const l of this._doc.layers ?? []) {
      const c = this.newCanvas();
      this.pix.set(l.id, { canvas: c });
      const keys = l.tiles ?? [];
      if (keys.length && c) {
        const got = await tiles.load(l.id, keys);
        const g = ctxOf(c);
        for (const [k, bmp] of got) {
          const [tx, ty] = k.split("_").map(Number);
          g?.drawImage(bmp, (tx ?? 0) * TILE, (ty ?? 0) * TILE);
        }
      }
    }
    this.emit("layers");
    this.emit("change");
    this.emit("history");
    this.view.fit();
  }

  // ---- input ----
  beginStroke(tool: ToolState, p: InputPoint): void {
    const id = this._doc.active;
    const before = this.snapshot("Stroke", { x: p.x, y: p.y, w: 1, h: 1 }, [id]);
    this.stroke = { tool, last: p, bounds: { x: p.x, y: p.y, w: 1, h: 1 }, before, any: false };
    this.dab(p, p);
  }

  extendStroke(points: InputPoint[]): void {
    const s = this.stroke;
    if (!s) return;
    for (const p of points) {
      this.dab(s.last, p);
      s.last = p;
    }
    this.emit("change");
    this.schedule();
  }

  endStroke(): StrokeResult {
    const s = this.stroke;
    this.stroke = null;
    if (!s || !s.any) return { history: null, bounds: { x: 0, y: 0, w: 0, h: 0 } };
    this.strokes++;
    const id = this.commit(s.before, s.bounds);
    this.markDirty(this._doc.active, s.bounds);
    return { history: id, bounds: s.bounds };
  }

  cancelStroke(): void {
    const s = this.stroke;
    this.stroke = null;
    if (s) this.restore(s.before);
  }

  private dab(a: InputPoint, b: InputPoint): void {
    const s = this.stroke;
    if (!s) return;
    const layer = this.pix.get(this._doc.active);
    const lp = (this._doc.layers ?? []).find((l) => l.id === this._doc.active);
    const g = ctxOf(layer?.canvas ?? null);
    const size = s.tool.kind === "history" ? 20 : Math.max(1, s.tool.brush.size);
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const step = Math.max(1, size * Math.max(0.05, s.tool.brush.spacing));
    const n = Math.max(1, Math.ceil(dist / step));
    if (lp?.locked || lp?.hidden) return;
    for (let i = 1; i <= n; i++) {
      const x = a.x + ((b.x - a.x) * i) / n;
      const y = a.y + ((b.y - a.y) * i) / n;
      const r = (size * (0.3 + 0.7 * b.pressure)) / 2;
      s.any = true;
      s.bounds = union(s.bounds, { x: x - r, y: y - r, w: r * 2, h: r * 2 });
      if (!g) continue;
      g.save();
      if (s.tool.kind === "eraser") g.globalCompositeOperation = "destination-out";
      g.globalAlpha = Math.max(0.05, s.tool.brush.opacity * 0.6);
      const color = s.tool.kind === "brush" || s.tool.kind === "lab" ? s.tool.color : { r: 0.5, g: 0.5, b: 0.5, a: 1 };
      const grad = g.createRadialGradient(x, y, 0, x, y, Math.max(0.5, r));
      const hard = s.tool.brush.tip.hardness;
      grad.addColorStop(0, css(color));
      grad.addColorStop(Math.min(0.99, Math.max(0.01, hard)), css(color));
      grad.addColorStop(1, css({ ...color, a: 0 }));
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }

  // ---- layers ----
  addLayer(opts: Partial<LayerProps> = {}, index?: number): string {
    this.pushUndoDoc("Add layer");
    const id = `L${this.nextLayer++}`;
    const layer = { id, name: opts.name ?? `Layer ${this.nextLayer - 1}`, hidden: false, locked: false, alphaLock: false, clip: false, reference: false, opacity: 1, blend: "normal", tiles: [], rev: 0, ...opts };
    const list = [...(this._doc.layers ?? [])];
    list.splice(index ?? list.length, 0, layer);
    this._doc = { ...this._doc, layers: list, active: id };
    this.pix.set(id, { canvas: this.newCanvas() });
    this.emit("layers");
    this.emit("change");
    return id;
  }

  removeLayer(id: string): void {
    const list = (this._doc.layers ?? []).filter((l) => l.id !== id);
    if (list.length === (this._doc.layers ?? []).length) return;
    this.pushUndoDoc("Delete layer");
    this._doc = { ...this._doc, layers: list, active: this._doc.active === id ? (list[list.length - 1]?.id ?? "") : this._doc.active };
    this.pix.delete(id);
    this.emit("layers");
    this.emit("change");
  }

  moveLayer(id: string, toIndex: number): void {
    const list = [...(this._doc.layers ?? [])];
    const from = list.findIndex((l) => l.id === id);
    if (from < 0) return;
    this.pushUndoDoc("Move layer");
    const [l] = list.splice(from, 1);
    if (l) list.splice(Math.max(0, Math.min(list.length, toIndex)), 0, l);
    this._doc = { ...this._doc, layers: list };
    this.emit("layers");
    this.emit("change");
  }

  setLayer(id: string, p: Partial<LayerProps>): void {
    this._doc = { ...this._doc, layers: (this._doc.layers ?? []).map((l) => (l.id === id ? { ...l, ...p } : l)) };
    this.emit("layers");
    this.emit("change");
    this.schedule();
  }

  duplicateLayer(id: string): string {
    const src = (this._doc.layers ?? []).find((l) => l.id === id);
    if (!src) return "";
    const idx = (this._doc.layers ?? []).indexOf(src);
    const nid = this.addLayer({ ...src, name: `${src.name} copy` }, idx + 1);
    const a = this.pix.get(id)?.canvas;
    const b = this.pix.get(nid)?.canvas;
    ctxOf(b ?? null)?.drawImage(a as CanvasImageSource, 0, 0);
    this.markDirty(nid, { x: 0, y: 0, w: this._doc.width, h: this._doc.height });
    return nid;
  }

  mergeDown(id: string): void {
    const list = this._doc.layers ?? [];
    const i = list.findIndex((l) => l.id === id);
    if (i <= 0) return;
    const below = list[i - 1];
    const above = list[i];
    if (!below || !above) return;
    this.pushUndoDoc("Merge down");
    const g = ctxOf(this.pix.get(below.id)?.canvas ?? null);
    const src = this.pix.get(above.id)?.canvas;
    if (g && src) {
      g.globalAlpha = above.opacity;
      g.drawImage(src, 0, 0);
      g.globalAlpha = 1;
    }
    this.markDirty(below.id, { x: 0, y: 0, w: this._doc.width, h: this._doc.height });
    this.removeLayerSilently(above.id);
  }

  private removeLayerSilently(id: string): void {
    const list = (this._doc.layers ?? []).filter((l) => l.id !== id);
    this._doc = { ...this._doc, layers: list, active: list[Math.max(0, list.findIndex((l) => l.id === this._doc.active))]?.id ?? list[0]?.id ?? "" };
    this.pix.delete(id);
    this.emit("layers");
    this.emit("change");
  }

  flatten(): void {
    const list = this._doc.layers ?? [];
    if (list.length < 2) return;
    this.pushUndoDoc("Flatten");
    const first = list[0];
    if (!first) return;
    const g = ctxOf(this.pix.get(first.id)?.canvas ?? null);
    for (const l of list.slice(1)) {
      const src = this.pix.get(l.id)?.canvas;
      if (g && src && !l.hidden) {
        g.globalAlpha = l.opacity;
        g.drawImage(src, 0, 0);
        g.globalAlpha = 1;
      }
      this.pix.delete(l.id);
    }
    this._doc = { ...this._doc, layers: [first], active: first.id };
    this.markDirty(first.id, { x: 0, y: 0, w: this._doc.width, h: this._doc.height });
    this.emit("layers");
    this.emit("change");
  }

  setActive(id: string): void {
    this._doc = { ...this._doc, active: id };
    this.emit("layers");
  }

  // ---- pixels ----
  async readRegion(r: Rect, src: "layer" | "merged"): Promise<ImageData> {
    const w = Math.max(1, Math.round(r.w));
    const h = Math.max(1, Math.round(r.h));
    const c = src === "layer" ? this.pix.get(this._doc.active)?.canvas : this.composite();
    const g = ctxOf(c ?? null);
    if (g) return g.getImageData(Math.round(r.x), Math.round(r.y), w, h);
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h, colorSpace: "srgb" } as ImageData;
  }

  writeRegion(layerId: string, r: Rect, img: ImageBitmap | ImageData, _mask?: ImageData, _feather?: number, label = "Edit"): HistoryId {
    const snap = this.snapshot(label, r, [layerId]);
    const g = ctxOf(this.pix.get(layerId)?.canvas ?? null);
    if (g) {
      if ("data" in img) g.putImageData(img, Math.round(r.x), Math.round(r.y));
      else g.drawImage(img, Math.round(r.x), Math.round(r.y));
    }
    this.markDirty(layerId, r);
    return this.commit(snap, r);
  }

  fill(at: Point, opts: { color: { r: number; g: number; b: number; a: number } }): HistoryId | null {
    const id = this._doc.active;
    const snap = this.snapshot("Fill", { x: 0, y: 0, w: this._doc.width, h: this._doc.height }, [id]);
    const g = ctxOf(this.pix.get(id)?.canvas ?? null);
    if (g) {
      g.fillStyle = css(opts.color);
      g.fillRect(0, 0, this._doc.width, this._doc.height);
    }
    void at;
    this.markDirty(id, { x: 0, y: 0, w: this._doc.width, h: this._doc.height });
    return this.commit(snap, { x: 0, y: 0, w: this._doc.width, h: this._doc.height });
  }

  resizeCanvas(w: number, h: number): HistoryId {
    const id = this.push("Canvas size", { x: 0, y: 0, w, h });
    this._doc = { ...this._doc, width: w, height: h };
    for (const l of this._doc.layers ?? []) this.markDirty(l.id, { x: 0, y: 0, w, h });
    this.emit("change");
    return id;
  }

  resample(w: number, h: number): HistoryId {
    return this.resizeCanvas(w, h);
  }

  // ---- history ----
  undo(): boolean {
    const s = this.undoStack.pop();
    if (!s) return false;
    const redo = this.capture(s.label, s.bounds, [...s.before.keys()]);
    redo.id = s.id;
    this.restore(s);
    this.redoStack.push(redo);
    this.emit("history");
    this.emit("change");
    return true;
  }

  redo(): boolean {
    const s = this.redoStack.pop();
    if (!s) return false;
    const undo = this.capture(s.label, s.bounds, [...s.before.keys()]);
    undo.id = s.id;
    this.restore(s);
    this.undoStack.push(undo);
    this.emit("history");
    this.emit("change");
    return true;
  }

  history(): HistoryEntry[] {
    return [...this.undoStack, ...[...this.redoStack].reverse()].map((s) => ({ id: s.id, label: s.label, bounds: s.bounds, available: true }));
  }

  jumpTo(id: HistoryId): void {
    while (this.undoStack.some((s) => s.id === id) && this.undoStack[this.undoStack.length - 1]?.id !== id) this.undo();
    if (this.undoStack[this.undoStack.length - 1]?.id !== id) while (this.redoStack.length && this.undoStack[this.undoStack.length - 1]?.id !== id) this.redo();
  }

  async snapshotAt(_id: HistoryId, r: Rect): Promise<ImageData> {
    return this.readRegion(r, "layer");
  }

  memoryBytes(): number {
    return this.undoStack.length * this._doc.width * this._doc.height * 4 * 0.1;
  }

  // ---- saving ----
  dirtyTiles(): Map<string, Set<string>> {
    return new Map([...this.dirty].map(([k, v]) => [k, new Set(v)]));
  }

  markSaved(layerId: string, keys: string[]): void {
    const s = this.dirty.get(layerId);
    if (!s) return;
    for (const k of keys) s.delete(k);
    if (s.size === 0) this.dirty.delete(layerId);
  }

  async encodeTile(layerId: string, key: string): Promise<Blob | null> {
    const src = this.pix.get(layerId)?.canvas;
    if (!src) return null;
    if (IS_JSDOM) return new Blob([`${layerId}/${key}`], { type: "image/png" });
    const [tx, ty] = key.split("_").map(Number);
    const t = document.createElement("canvas");
    t.width = TILE;
    t.height = TILE;
    const g = t.getContext("2d");
    g?.drawImage(src, -(tx ?? 0) * TILE, -(ty ?? 0) * TILE);
    const data = g?.getImageData(0, 0, TILE, TILE).data;
    if (data && !data.some((v, i) => i % 4 === 3 && v > 0)) return null;
    return new Promise((res) => t.toBlob((b) => res(b), "image/png"));
  }

  async flattenToBitmap(scale: number): Promise<ImageBitmap> {
    const w = Math.max(1, Math.round(this._doc.width * scale));
    const h = Math.max(1, Math.round(this._doc.height * scale));
    const c = this.composite();
    if (!c || IS_JSDOM) return { width: w, height: h, close() {} } as ImageBitmap;
    return createImageBitmap(c, { resizeWidth: w, resizeHeight: h });
  }

  on(ev: EngineEvent, cb: () => void): () => void {
    let set = this.listeners.get(ev);
    if (!set) this.listeners.set(ev, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  render(): void {
    const c = this.canvas;
    const g = ctxOf(c);
    if (!c || !g) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(c.clientWidth * dpr));
    const H = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.translate(c.clientWidth / 2 + this.v.panX, c.clientHeight / 2 + this.v.panY);
    g.rotate((this.v.rotation * Math.PI) / 180);
    g.scale(this.v.flipped ? -this.v.zoom : this.v.zoom, this.v.zoom);
    g.translate(-this._doc.width / 2, -this._doc.height / 2);
    g.shadowColor = "rgba(0,0,0,0.45)";
    g.shadowBlur = 24 / Math.max(0.2, this.v.zoom);
    g.fillStyle = this._doc.background === "transparent" ? "#cfcfcf" : this._doc.background;
    g.fillRect(0, 0, this._doc.width, this._doc.height);
    g.shadowBlur = 0;
    g.imageSmoothingEnabled = this.v.zoom < 1;
    const comp = this.composite(false);
    if (comp) g.drawImage(comp, 0, 0);
  }

  // ---- internals ----
  private schedule(): void {
    if (IS_JSDOM || this.raf || typeof requestAnimationFrame === "undefined") return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private emit(ev: EngineEvent): void {
    for (const cb of this.listeners.get(ev) ?? []) cb();
  }

  private newCanvas(): HTMLCanvasElement | null {
    if (IS_JSDOM || typeof document === "undefined") return null;
    const c = document.createElement("canvas");
    c.width = this._doc.width;
    c.height = this._doc.height;
    return c;
  }

  private composite(withBackground = true): HTMLCanvasElement | null {
    const out = this.newCanvas();
    const g = ctxOf(out);
    if (!out || !g) return null;
    if (withBackground && this._doc.background !== "transparent") {
      g.fillStyle = this._doc.background;
      g.fillRect(0, 0, out.width, out.height);
    }
    for (const l of this._doc.layers ?? []) {
      if (l.hidden) continue;
      const c = this.pix.get(l.id)?.canvas;
      if (!c) continue;
      g.globalAlpha = l.opacity;
      g.drawImage(c, 0, 0);
    }
    return out;
  }

  private markDirty(layerId: string, r: Rect): void {
    let s = this.dirty.get(layerId);
    if (!s) this.dirty.set(layerId, (s = new Set()));
    const x0 = Math.max(0, Math.floor(r.x / TILE));
    const y0 = Math.max(0, Math.floor(r.y / TILE));
    const x1 = Math.max(x0, Math.floor((Math.min(this._doc.width, r.x + r.w) - 1) / TILE));
    const y1 = Math.max(y0, Math.floor((Math.min(this._doc.height, r.y + r.h) - 1) / TILE));
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) s.add(`${tx}_${ty}`);
    this.emit("change");
  }

  private copyOf(layerId: string): HTMLCanvasElement | null {
    const src = this.pix.get(layerId)?.canvas;
    if (!src) return null;
    const c = this.newCanvas();
    ctxOf(c)?.drawImage(src, 0, 0);
    return c;
  }

  private capture(label: string, bounds: Rect, layers: string[]): Snapshot {
    return { id: this.nextHistory++, label, bounds, before: new Map(layers.map((l) => [l, this.copyOf(l)])), doc: JSON.stringify(this._doc) };
  }

  private snapshot(label: string, bounds: Rect, layers: string[]): Snapshot {
    const s = this.capture(label, bounds, layers);
    this.undoStack.push(s);
    this.redoStack = [];
    return s;
  }

  private commit(s: Snapshot, bounds: Rect): HistoryId {
    s.bounds = bounds;
    this.emit("history");
    this.emit("change");
    return s.id;
  }

  private push(label: string, bounds: Rect): HistoryId {
    const s = this.snapshot(label, bounds, []);
    return this.commit(s, bounds);
  }

  private pushUndoDoc(label: string): void {
    this.snapshot(label, { x: 0, y: 0, w: this._doc.width, h: this._doc.height }, []);
    this.emit("history");
  }

  private restore(s: Snapshot): void {
    for (const [id, c] of s.before) {
      const dst = this.pix.get(id)?.canvas;
      const g = ctxOf(dst ?? null);
      if (g && dst) {
        g.clearRect(0, 0, dst.width, dst.height);
        if (c) g.drawImage(c, 0, 0);
      }
      this.markDirty(id, { x: 0, y: 0, w: this._doc.width, h: this._doc.height });
    }
    if (s.before.size === 0) {
      const prev = JSON.parse(s.doc) as PaintDoc;
      this._doc = prev;
      for (const l of prev.layers ?? []) if (!this.pix.has(l.id)) this.pix.set(l.id, { canvas: this.newCanvas() });
      this.emit("layers");
    }
    this.emit("change");
    this.schedule();
  }
}

function union(a: Rect, b: Rect): Rect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
}

/** A tile source that finds nothing (blank projects, tests). */
export const EMPTY_TILES: TileSource = { load: async () => new Map() };
