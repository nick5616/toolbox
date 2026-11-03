/**
 * Byte source of one edit stream (Phase 9 SPEC §8.2): keyframe-aligned Range
 * reads of at most 4 MiB through the /media route into a 16 MiB cache, and
 * access-unit slices out of it.
 */
import { ByteCache } from "./cache";
import { frameBytes, MAX_RANGE_BYTES, planFetch } from "./gop";
import type { StreamIndex } from "./types";

/** Reads bytes [start, end) of `url` with one Range request. */
export async function fetchRange(url: string, start: number, end: number, fetchImpl: typeof fetch): Promise<Uint8Array> {
  const res = await fetchImpl(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
  if (!res.ok) throw new Error(`Couldn't read ${url} (${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const want = end - start;
  if (res.status === 200 && buf.length >= end) return buf.subarray(start, end); // a server that ignored Range
  if (buf.length < want) throw new Error(`Short read of ${url}: ${buf.length} of ${want} bytes`);
  return buf.length === want ? buf : buf.subarray(0, want);
}

export class StreamBytes {
  readonly cache: ByteCache;
  /** Range requests made, as [start, end) pairs (tests and Edit Lab). */
  readonly requests: Array<[number, number]> = [];
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly url: string,
    readonly index: StreamIndex,
    private readonly fetchImpl: typeof fetch,
    cache?: ByteCache,
  ) {
    this.cache = cache ?? new ByteCache();
  }

  /** Makes the bytes of frames [from, to] resident, fetching whole-GOP groups that are missing. */
  async ensure(from: number, to: number): Promise<void> {
    const groups = planFetch(this.index, from, to, MAX_RANGE_BYTES);
    const [need0] = frameBytes(this.index, Math.max(0, from));
    const [, need1] = frameBytes(this.index, Math.min(this.index.frames - 1, to));
    if (this.cache.has(need0, need1)) return;
    await Promise.all(
      groups.map((g) => {
        if (this.cache.has(g.start, g.end)) return Promise.resolve();
        const k = `${g.start}-${g.end}`;
        let p = this.inflight.get(k);
        if (!p) {
          this.requests.push([g.start, g.end]);
          p = fetchRange(this.url, g.start, g.end, this.fetchImpl)
            .then((data) => this.cache.put(g.start, data))
            .finally(() => this.inflight.delete(k));
          this.inflight.set(k, p);
        }
        return p;
      }),
    );
  }

  /** The access unit of frame n, or null when its bytes aren't resident. */
  au(n: number): Uint8Array | null {
    const [a, b] = frameBytes(this.index, n);
    return this.cache.slice(a, b);
  }
}
