// A CPU view over a set of tiles (a layer, or a stroke's scratch): read and
// write arbitrary rectangles as premultiplied buffers, then flush the changed
// tiles back to the GPU. The pixel-level tools (smudge, bleed, fill, writeRegion,
// transform, adjustments, resize) all go through it.

import type { GLBackend, Surface } from "./gl";
import { newBuf, parseKey, rectsIntersect, tileKey, type PixelBuf } from "./pixels";
import { TILE, type Rect } from "./types";

export class TilePixels {
  private readonly cache = new Map<string, Uint8ClampedArray>();
  private readonly dirty = new Set<string>();

  constructor(
    private readonly be: GLBackend,
    private readonly tiles: Map<string, Surface>,
    /** Called with a tile key before the tile's surface first changes (undo recording). */
    private readonly beforeChange: ((key: string) => void) | null,
    private readonly bounds: Rect,
  ) {}

  private tile(key: string, create: boolean): Uint8ClampedArray | null {
    let d = this.cache.get(key);
    if (d) return d;
    const s = this.tiles.get(key);
    if (s) d = this.be.download(s, 0, 0, TILE, TILE);
    else if (create) d = new Uint8ClampedArray(TILE * TILE * 4);
    else return null;
    this.cache.set(key, d);
    return d;
  }

  /** Premultiplied pixels of r (outside the canvas / absent tiles = transparent). */
  read(r: Rect): PixelBuf {
    const out = newBuf(r.w, r.h);
    const tx0 = Math.floor(r.x / TILE);
    const ty0 = Math.floor(r.y / TILE);
    const tx1 = Math.floor((r.x + r.w - 1) / TILE);
    const ty1 = Math.floor((r.y + r.h - 1) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = this.tile(tileKey(tx, ty), false);
        if (!t) continue;
        const ov = rectsIntersect(r, { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE });
        if (!ov) continue;
        for (let y = 0; y < ov.h; y++) {
          const so = ((ov.y - ty * TILE + y) * TILE + (ov.x - tx * TILE)) * 4;
          out.data.set(t.subarray(so, so + ov.w * 4), ((ov.y - r.y + y) * r.w + (ov.x - r.x)) * 4);
        }
      }
    }
    return out;
  }

  /** Overwrite r with buf (clipped to the canvas). */
  write(r: Rect, buf: PixelBuf): void {
    const clip = rectsIntersect(r, this.bounds);
    if (!clip) return;
    const tx0 = Math.floor(clip.x / TILE);
    const ty0 = Math.floor(clip.y / TILE);
    const tx1 = Math.floor((clip.x + clip.w - 1) / TILE);
    const ty1 = Math.floor((clip.y + clip.h - 1) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = tileKey(tx, ty);
        const ov = rectsIntersect(clip, { x: tx * TILE, y: ty * TILE, w: TILE, h: TILE });
        if (!ov) continue;
        const t = this.tile(key, true) as Uint8ClampedArray;
        for (let y = 0; y < ov.h; y++) {
          const so = ((ov.y - r.y + y) * buf.w + (ov.x - r.x)) * 4;
          t.set(buf.data.subarray(so, so + ov.w * 4), ((ov.y - ty * TILE + y) * TILE + (ov.x - tx * TILE)) * 4);
        }
        this.dirty.add(key);
      }
    }
  }

  /** Upload changed tiles; returns their keys. */
  flush(): string[] {
    const keys = [...this.dirty];
    for (const key of keys) {
      this.beforeChange?.(key);
      let s = this.tiles.get(key);
      if (!s) {
        s = this.be.createSurface();
        this.be.clear(s);
        this.tiles.set(key, s);
      }
      this.be.upload(s, this.cache.get(key) as Uint8ClampedArray, 0, 0, TILE, TILE);
    }
    this.dirty.clear();
    return keys;
  }

  /** Drop cached copies (after the surfaces changed behind our back). */
  invalidate(): void {
    this.cache.clear();
    this.dirty.clear();
  }

  get changed(): boolean {
    return this.dirty.size > 0;
  }
}

/** Tile keys covering r (clamped at 0). */
export function tilesOf(r: Rect): string[] {
  const out: string[] = [];
  const tx0 = Math.max(0, Math.floor(r.x / TILE));
  const ty0 = Math.max(0, Math.floor(r.y / TILE));
  const tx1 = Math.floor((r.x + r.w - 1) / TILE);
  const ty1 = Math.floor((r.y + r.h - 1) / TILE);
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) out.push(tileKey(tx, ty));
  return out;
}

export function tileRect(key: string): Rect {
  const p = parseKey(key) ?? [0, 0];
  return { x: p[0] * TILE, y: p[1] * TILE, w: TILE, h: TILE };
}
