/**
 * Small GL-free containers of the edit engine: a pool of same-shape resources
 * (render targets, SPEC §8.5 "targets are pooled by size") and an LRU of
 * uploaded textures keyed by the image object.
 */

export interface Sized {
  w: number;
  h: number;
}

/** Hands out and takes back resources by size; keeps at most `retain` idle ones per size. */
export class Pool<T extends Sized> {
  private readonly free = new Map<string, T[]>();
  private out = 0;
  /** Resources ever created (tests, leak checks). */
  created = 0;

  constructor(
    private readonly make: (w: number, h: number) => T,
    private readonly destroy: (t: T) => void,
    private readonly retain = 6,
  ) {}

  /** Resources handed out and not yet released. */
  get outstanding(): number {
    return this.out;
  }

  acquire(w: number, h: number): T {
    const k = `${w}x${h}`;
    const t = this.free.get(k)?.pop() ?? (this.created++, this.make(w, h));
    this.out++;
    return t;
  }

  release(t: T): void {
    this.out--;
    const k = `${t.w}x${t.h}`;
    let l = this.free.get(k);
    if (!l) {
      l = [];
      this.free.set(k, l);
    }
    if (l.length >= this.retain) this.destroy(t);
    else l.push(t);
  }

  /** Destroys every idle resource (a resize drops the old sizes). */
  trim(): void {
    for (const l of this.free.values()) for (const t of l) this.destroy(t);
    this.free.clear();
  }
}

/** An LRU of per-image values (uploaded textures) with a count cap; `destroy` runs once per evicted value. */
export class ImageLRU<V> {
  private readonly map = new Map<object, { v: V; used: number }>();
  private tick = 0;

  constructor(
    private readonly cap: number,
    private readonly destroy: (v: V) => void,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get(img: object): V | undefined {
    const e = this.map.get(img);
    if (!e) return undefined;
    e.used = ++this.tick;
    return e.v;
  }

  set(img: object, v: V): void {
    this.map.set(img, { v, used: ++this.tick });
    while (this.map.size > this.cap) {
      let oldest: object | null = null;
      let used = Infinity;
      for (const [k, e] of this.map) {
        if (k !== img && e.used < used) {
          used = e.used;
          oldest = k;
        }
      }
      if (!oldest) return;
      const e = this.map.get(oldest) as { v: V };
      this.map.delete(oldest);
      this.destroy(e.v);
    }
  }

  clear(): void {
    for (const e of this.map.values()) this.destroy(e.v);
    this.map.clear();
  }
}
