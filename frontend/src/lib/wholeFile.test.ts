import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ MediaService: { URLFor: async (p: string) => `/media/tok${p}` } }));

import { fetchWhole, wholeFileBuffer, wholeFileBytes } from "./wholeFile";

const MiB = 1024 * 1024;

/** A fake /media server: answers ranges with at most 4 MiB, like the real one. */
function server(data: Uint8Array): { fetch: typeof fetch; ranges: string[] } {
  const ranges: string[] = [];
  const f = (async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.Range ?? "";
    ranges.push(range);
    const m = /bytes=(\d+)-(\d+)/.exec(range);
    const start = Number(m?.[1] ?? 0);
    if (start >= data.length) return new Response(null, { status: 416 });
    const end = Math.min(data.length - 1, start + 4 * MiB - 1, Number(m?.[2] ?? Infinity));
    return new Response(data.slice(start, end + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${data.length}` } });
  }) as unknown as typeof fetch;
  return { fetch: f, ranges };
}

const sample = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) % 251);

describe("wholeFile", () => {
  it("joins ranges of at most 4 MiB into the whole file", async () => {
    const data = sample(9 * MiB + 123);
    const s = server(data);
    const out = await fetchWhole("/media/t/x.m4a", s.fetch);
    expect(out.length).toBe(data.length);
    expect(out.every((b, i) => b === data[i])).toBe(true);
    expect(s.ranges).toHaveLength(3);
    expect(s.ranges[0]).toBe(`bytes=0-${4 * MiB - 1}`);
  });

  it("gets the URL through MediaService and returns the bytes", async () => {
    const data = sample(1000);
    const s = server(data);
    expect(Array.from(await wholeFileBytes("/a.m4a", s.fetch))).toEqual(Array.from(data));
  });

  it("an ArrayBuffer has exactly the file's length", async () => {
    const s = server(sample(777));
    expect((await wholeFileBuffer("/a.m4a", s.fetch)).byteLength).toBe(777);
  });

  it("fails on an error status", async () => {
    const f = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    await expect(fetchWhole("/media/t/x", f)).rejects.toThrow();
  });
});
