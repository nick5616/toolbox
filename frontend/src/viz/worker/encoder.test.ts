import { afterEach, describe, expect, it, vi } from "vitest";
import { bitrateFor, chooseEncoder, codecFor } from "./encoder";

function mockEncoder(supported: (hw: string | undefined) => boolean) {
  vi.stubGlobal("VideoEncoder", { isConfigSupported: vi.fn(async (c: VideoEncoderConfig) => ({ supported: supported(c.hardwareAcceleration), config: c })) });
}
afterEach(() => vi.unstubAllGlobals());

describe("chooseEncoder", () => {
  it("prefers hardware H.264", async () => {
    mockEncoder(() => true);
    expect((await chooseEncoder(1920, 1080, 30, false)).label).toBe("h264-hw");
  });
  it("falls back to software, then JPEG", async () => {
    mockEncoder((hw) => hw === "prefer-software");
    expect((await chooseEncoder(1920, 1080, 30, false)).label).toBe("h264-sw");
    mockEncoder(() => false);
    expect((await chooseEncoder(1920, 1080, 30, false)).label).toBe("jpeg");
  });
  it("uses JPEG when forced or when VideoEncoder is missing", async () => {
    mockEncoder(() => true);
    expect((await chooseEncoder(1920, 1080, 30, false, true)).label).toBe("jpeg");
    vi.unstubAllGlobals();
    expect((await chooseEncoder(1920, 1080, 30, false)).label).toBe("jpeg");
  });
  it("treats a throwing isConfigSupported as unsupported", async () => {
    vi.stubGlobal("VideoEncoder", {
      isConfigSupported: vi.fn(async () => {
        throw new Error("x");
      }),
    });
    expect((await chooseEncoder(1280, 720, 30, false)).label).toBe("jpeg");
  });
  it("picks codec level and bitrate by size", () => {
    expect(codecFor(1920, 1080)).toBe("avc1.640028");
    expect(codecFor(3840, 2160)).toBe("avc1.640033");
    expect(bitrateFor(1920, 1080, 30, false)).toBe(14e6);
    expect(bitrateFor(1920, 1080, 60, true)).toBe(Math.round(14e6 * 1.5 * 1.6));
  });
});
