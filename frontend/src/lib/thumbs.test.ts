import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ FilesService: { ImageThumb: vi.fn() } }));

import { FilesService } from "@/lib/api";
import { LRU, Limiter, SharedLoader, cachedThumb, clearThumbs, loadThumb } from "./thumbs";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("LRU", () => {
  it("evicts the least recently used entry, not everything", () => {
    const c = new LRU<number>(3);
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    c.get("a");
    c.set("d", 4);
    expect(c.has("b")).toBe(false);
    expect([c.has("a"), c.has("c"), c.has("d")]).toEqual([true, true, true]);
    expect(c.size).toBe(3);
  });
});

describe("Limiter", () => {
  it("never runs more than the limit at once", async () => {
    const l = new Limiter(2);
    const gates = Array.from({ length: 5 }, () => deferred<void>());
    const done = gates.map((g) => l.push(() => g.promise));
    await Promise.resolve();
    expect(l.peak).toBe(2);
    for (const g of gates) g.resolve();
    await Promise.all(done);
    expect(l.peak).toBe(2);
  });
});

describe("SharedLoader", () => {
  it("shares one fetch between callers and caches the result", async () => {
    const s = new SharedLoader<string>(10, new Limiter(2));
    const fetch = vi.fn(async () => "x");
    const [a, b] = await Promise.all([s.load("k", fetch), s.load("k", fetch)]);
    expect([a, b]).toEqual(["x", "x"]);
    expect(await s.load("k", fetch)).toBe("x");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(s.peek("k")).toBe("x");
  });

  it("drops a queued load only when every caller cancelled", async () => {
    const s = new SharedLoader<string>(10, new Limiter(1));
    const gate = deferred<string>();
    void s.load("busy", () => gate.promise);
    let a = false;
    let b = false;
    const fetch = vi.fn(async () => "y");
    const pa = s.load("k", fetch, () => a);
    const pb = s.load("k", fetch, () => b);
    a = true;
    gate.resolve("z");
    expect(await Promise.all([pa, pb])).toEqual(["y", "y"]);
    expect(fetch).toHaveBeenCalledTimes(1);

    const gate2 = deferred<string>();
    void s.load("busy2", () => gate2.promise);
    let c = false;
    const fetch2 = vi.fn(async () => "w");
    const pc = s.load("k2", fetch2, () => c);
    c = true;
    gate2.resolve("z");
    expect(await pc).toBeUndefined();
    expect(fetch2).not.toHaveBeenCalled();
  });

  it("does not cache failures", async () => {
    const s = new SharedLoader<string>(10, new Limiter(1));
    await expect(s.load("k", () => Promise.reject(new Error("no")))).rejects.toThrow("no");
    expect(await s.load("k", async () => "ok")).toBe("ok");
  });
});

describe("loadThumb", () => {
  it("asks the engine once per path+size+stamp and then answers from the cache", async () => {
    clearThumbs();
    const f = vi.mocked(FilesService.ImageThumb);
    f.mockResolvedValue("data:image/png;base64,AA");
    expect(cachedThumb("/a.png", 240)).toBeUndefined();
    await Promise.all([loadThumb("/a.png", 240), loadThumb("/a.png", 240)]);
    expect(cachedThumb("/a.png", 240)).toBe("data:image/png;base64,AA");
    await loadThumb("/a.png", 240);
    expect(f).toHaveBeenCalledTimes(1);
    await loadThumb("/a.png", 240, "newer");
    expect(f).toHaveBeenCalledTimes(2);
  });
});
