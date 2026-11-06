// Transform: lift the layer (or the selection) into a floating buffer, move it
// through an affine / perspective / 4×4 warp, and commit as one undo step.
// While active the live layer shows the preview (bilinear); the pre-lift
// tiles are held by a TileRecorder, so cancel restores them exactly.

import { blendInto } from "./blend";
import type { GLBackend, Surface } from "./gl";
import type { Layer } from "./layers";
import { newBuf, rectsIntersect, unionRect, type PixelBuf } from "./pixels";
import { TilePixels, tilesOf } from "./region";
import { identityMesh, invertAffine, multiplyAffine, transformAffine, transformCorners, transformMesh, type Affine, type Placed, type Resample } from "./sample";
import type { TileRecorder, TileSwapStep } from "./history";
import { TILE, type HistoryId, type Point, type Rect, type TransformAPI, type TransformMode } from "./types";

export interface TransformHost {
  activeLayer(): Layer | null;
  canvas(): Rect;
  selectionMask(): Uint8Array | null;
  selectionBounds(): Rect | null;
  backend(): GLBackend;
  newRecorder(): TileRecorder;
  touched(layerId: string, key: string): void;
  commit(step: TileSwapStep): HistoryId;
  /** A fresh history id for the committed step. */
  nextId(): HistoryId;
  changed(): void;
}

interface Active {
  layer: Layer;
  rect: Rect;
  content: Placed;
  rec: TileRecorder;
  before: Map<string, Surface>;
  last: Rect | null;
}

function contentBounds(be: GLBackend, layer: Layer, canvas: Rect): Rect | null {
  let r: Rect | null = null;
  for (const [key, s] of layer.tiles) {
    const m = /^(-?\d+)_(-?\d+)$/.exec(key);
    if (!m) continue;
    const ox = Number(m[1]) * TILE;
    const oy = Number(m[2]) * TILE;
    const d = be.download(s, 0, 0, TILE, TILE);
    let x0 = TILE;
    let y0 = TILE;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        if (d[(y * TILE + x) * 4 + 3] !== 0) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          y1 = y;
        }
      }
    }
    if (x1 >= 0) r = unionRect(r, { x: ox + x0, y: oy + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  return r ? rectsIntersect(r, canvas) : null;
}

export class TransformImpl implements TransformAPI {
  private a: Active | null = null;
  private mode: TransformMode = "free";
  private matrix: Affine = [1, 0, 0, 1, 0, 0];
  private corners: Point[] = [];
  private mesh: Point[] = [];

  constructor(private readonly host: TransformHost) {}

  get active(): boolean {
    return this.a !== null;
  }

  begin(mode: TransformMode): void {
    if (this.a) this.cancel();
    const layer = this.host.activeLayer();
    if (!layer || layer.props.locked) return;
    const be = this.host.backend();
    const canvas = this.host.canvas();
    const sel = this.host.selectionMask();
    const rect = this.host.selectionBounds() ?? contentBounds(be, layer, canvas);
    if (!rect) return;
    const rec = this.host.newRecorder();
    for (const key of tilesOf(rect)) if (layer.tiles.has(key)) rec.touch(layer, key);
    const before = new Map<string, Surface>();
    this.mirrorBefore(layer, rec, before);
    const px = new TilePixels(be, before, null, canvas);
    const buf = px.read(rect);
    if (sel) {
      for (let y = 0; y < rect.h; y++) {
        for (let x = 0; x < rect.w; x++) {
          const k = (sel[(rect.y + y) * canvas.w + rect.x + x] as number) / 255;
          const o = (y * rect.w + x) * 4;
          for (let c = 0; c < 4; c++) buf.data[o + c] = Math.round((buf.data[o + c] as number) * k);
        }
      }
    }
    this.mode = mode;
    this.matrix = [1, 0, 0, 1, 0, 0];
    this.corners = [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.w, y: rect.y },
      { x: rect.x + rect.w, y: rect.y + rect.h },
      { x: rect.x, y: rect.y + rect.h },
    ];
    this.mesh = identityMesh(rect.x, rect.y, rect.w, rect.h);
    this.a = { layer, rect, content: { x: rect.x, y: rect.y, buf }, rec, before, last: null };
    this.refresh("bilinear");
  }

  /** Surfaces holding the layer's state before the transform (recorded tiles only). */
  private mirrorBefore(layer: Layer, rec: TileRecorder, before: Map<string, Surface>): void {
    const m = rec.map.get(layer.id);
    if (!m) return;
    for (const [key, d] of m) if (d.k === "gpu") before.set(key, d.s);
  }

  set(t: { matrix?: number[]; corners?: Point[]; mesh?: Point[] }): void {
    if (!this.a) return;
    if (t.mesh && t.mesh.length === 16) {
      this.mesh = t.mesh.map((p) => ({ ...p }));
      this.mode = "warp";
    } else if (t.corners && t.corners.length === 4) {
      this.corners = t.corners.map((p) => ({ ...p }));
      this.mode = "distort";
    } else if (t.matrix && t.matrix.length === 6) {
      this.matrix = t.matrix.slice(0, 6) as Affine;
      if (this.mode === "distort" || this.mode === "warp") this.mode = "free";
    }
    this.refresh("bilinear");
  }

  /** Centre of the transformed rect's bounding box. */
  private centre(): Point {
    const a = this.a as Active;
    let pts: Point[];
    if (this.mode === "warp") pts = this.mesh;
    else if (this.mode === "distort") pts = this.corners;
    else {
      const r = a.rect;
      const m = this.matrix;
      pts = [
        [r.x, r.y],
        [r.x + r.w, r.y],
        [r.x + r.w, r.y + r.h],
        [r.x, r.y + r.h],
      ].map(([x, y]) => ({ x: (m[0] as number) * (x as number) + (m[2] as number) * (y as number) + (m[4] as number), y: (m[1] as number) * (x as number) + (m[3] as number) * (y as number) + (m[5] as number) }));
    }
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  }

  /** Apply g to the current destination geometry. */
  private applyAround(g: Affine): void {
    if (this.mode === "warp") this.mesh = this.mesh.map((p) => ({ x: g[0] * p.x + g[2] * p.y + g[4], y: g[1] * p.x + g[3] * p.y + g[5] }));
    else if (this.mode === "distort") this.corners = this.corners.map((p) => ({ x: g[0] * p.x + g[2] * p.y + g[4], y: g[1] * p.x + g[3] * p.y + g[5] }));
    else this.matrix = multiplyAffine(g, this.matrix);
    this.refresh("bilinear");
  }

  flip(axis: "h" | "v"): void {
    if (!this.a) return;
    const c = this.centre();
    this.applyAround(axis === "h" ? [-1, 0, 0, 1, 2 * c.x, 0] : [1, 0, 0, -1, 0, 2 * c.y]);
  }

  rotate90(dir: 1 | -1): void {
    if (!this.a) return;
    const c = this.centre();
    // 90° about c: (x, y) → (c.x - dir (y - c.y), c.y + dir (x - c.x)).
    const g: Affine = [0, dir, -dir, 0, c.x + dir * c.y, c.y - dir * c.x];
    this.applyAround(g);
  }

  private compute(q: Resample): Placed | null {
    const a = this.a as Active;
    if (this.mode === "warp") return transformMesh(a.content, this.mesh, q);
    if (this.mode === "distort") return transformCorners(a.content, this.corners, q);
    return transformAffine(a.content, this.matrix, q);
  }

  private refresh(q: Resample): void {
    const a = this.a as Active;
    const be = this.host.backend();
    const canvas = this.host.canvas();
    const out = this.compute(q);
    const outRect = out ? { x: out.x, y: out.y, w: out.buf.w, h: out.buf.h } : null;
    let region: Rect = a.rect;
    if (a.last) region = unionRect(region, a.last);
    if (outRect) region = unionRect(region, outRect);
    const clip = rectsIntersect(region, canvas);
    if (!clip) return;
    for (const key of tilesOf(clip)) {
      a.rec.touch(a.layer, key);
      this.mirrorBefore(a.layer, a.rec, a.before);
    }
    // Base = the layer as it was, minus the lifted pixels.
    const base = new TilePixels(be, a.before, null, canvas).read(clip);
    const sel = this.host.selectionMask();
    const inner = rectsIntersect(a.rect, clip);
    if (inner) {
      for (let y = 0; y < inner.h; y++) {
        for (let x = 0; x < inner.w; x++) {
          const k = sel ? 1 - (sel[(inner.y + y) * canvas.w + inner.x + x] as number) / 255 : 0;
          const o = ((inner.y - clip.y + y) * clip.w + (inner.x - clip.x + x)) * 4;
          for (let c = 0; c < 4; c++) base.data[o + c] = Math.round((base.data[o + c] as number) * k);
        }
      }
    }
    if (out) over(base, clip, out);
    const px = new TilePixels(be, a.layer.tiles, (key) => a.rec.touch(a.layer, key), canvas);
    px.write(clip, base);
    for (const key of px.flush()) this.host.touched(a.layer.id, key);
    a.last = outRect;
    this.host.changed();
  }

  commit(resample: Resample): HistoryId {
    const a = this.a;
    if (!a) return 0;
    this.refresh(resample);
    const step = a.rec.toStep(this.host.nextId(), "Transform", a.last ? unionRect(a.rect, a.last) : a.rect);
    this.a = null;
    return this.host.commit(step);
  }

  cancel(): void {
    const a = this.a;
    if (!a) return;
    a.rec.revert();
    a.rec.discard();
    this.a = null;
    this.host.changed();
  }
}

/** Source-over `src` (placed in canvas space) onto `base` (a buffer at `at`). */
function over(base: PixelBuf, at: Rect, src: Placed): void {
  const ov = rectsIntersect(at, { x: src.x, y: src.y, w: src.buf.w, h: src.buf.h });
  if (!ov) return;
  for (let y = 0; y < ov.h; y++) {
    for (let x = 0; x < ov.w; x++) {
      const so = ((ov.y - src.y + y) * src.buf.w + (ov.x - src.x + x)) * 4;
      const a = (src.buf.data[so + 3] as number) / 255;
      if (a <= 0) continue;
      blendInto(base.data, ((ov.y - at.y + y) * base.w + (ov.x - at.x + x)) * 4, (src.buf.data[so] as number) / 255, (src.buf.data[so + 1] as number) / 255, (src.buf.data[so + 2] as number) / 255, a, 0, false);
    }
  }
}

export { invertAffine, newBuf };
