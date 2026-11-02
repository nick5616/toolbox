import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LoadImage = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ ComposerService: { LoadImage, SaveRender: vi.fn() } }));

import { bytesToBase64 } from "./export";
import { cachedImage, clearImageCache, forgetImage, loadImage, loadImages } from "./loadImages";

const PNG_1PX = "data:image/png;base64,iVBORw0KGgo=";

beforeEach(() => {
  clearImageCache();
  LoadImage.mockReset();
  LoadImage.mockResolvedValue(PNG_1PX);
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1, height: 1, close() {} }) as unknown as ImageBitmap));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadImages", () => {
  it("loads once per path and size, sharing concurrent requests", async () => {
    const [a, b] = await Promise.all([loadImage("/a.png", 2048), loadImage("/a.png", 2048)]);
    expect(a).toBe(b);
    expect(await loadImage("/a.png", 2048)).toBe(a);
    expect(LoadImage).toHaveBeenCalledTimes(1);
    expect(LoadImage).toHaveBeenCalledWith("/a.png", 2048);
    await loadImage("/a.png", 4096); // another size is another bitmap
    expect(LoadImage).toHaveBeenCalledTimes(2);
    expect(cachedImage("/a.png", 2048)).toBe(a);
  });

  it("forgetImage drops every size of a path", async () => {
    await loadImage("/a.png", 2048);
    await loadImage("/a.png", 4096);
    await loadImage("/b.png", 2048);
    forgetImage("/a.png");
    expect(cachedImage("/a.png", 2048)).toBeUndefined();
    expect(cachedImage("/a.png", 4096)).toBeUndefined();
    expect(cachedImage("/b.png", 2048)).toBeDefined();
  });

  it("loadImages reports failures without rejecting", async () => {
    LoadImage.mockImplementation(async (p: string) => {
      if (p === "/bad.heic") throw new Error("HEIC photos need the AI engine");
      return PNG_1PX;
    });
    const r = await loadImages(["/ok.png", "/bad.heic", "/ok.png"]);
    expect([...r.images.keys()]).toEqual(["/ok.png"]);
    expect(r.failed.get("/bad.heic")).toMatch(/AI engine/);
    // A failure is not cached: the next call retries.
    LoadImage.mockResolvedValue(PNG_1PX);
    expect((await loadImages(["/bad.heic"])).images.size).toBe(1);
  });

  it("a failing load doesn't poison the in-flight table", async () => {
    LoadImage.mockRejectedValueOnce(new Error("boom"));
    await expect(loadImage("/x.png")).rejects.toThrow("boom");
    await expect(loadImage("/x.png")).resolves.toBeDefined();
  });
});

describe("bytesToBase64", () => {
  it("matches btoa on small and large inputs", () => {
    expect(bytesToBase64(new Uint8Array([72, 105]))).toBe("SGk=");
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
    const big = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
    let s = "";
    for (const b of big) s += String.fromCharCode(b);
    expect(bytesToBase64(big)).toBe(btoa(s));
  });
});
