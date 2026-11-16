import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FramedMedia } from "./FramedMedia";

const FRAMING = { zoom: 1, panX: 0, panY: 0, rotation: 0 };

function box(): HTMLElement {
  const img = screen.getByTestId("framed-media").querySelector("img");
  if (!img?.parentElement) throw new Error("no picture");
  return img.parentElement;
}

function loadImage(w: number, h: number): void {
  const img = screen.getByTestId("framed-media").querySelector("img")!;
  Object.defineProperty(img, "naturalWidth", { value: w, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: h, configurable: true });
  fireEvent.load(img);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FramedMedia", () => {
  it("shows the picture once it has loaded, and hides it again until the next URL loads", () => {
    const { rerender } = render(<FramedMedia url="data:a" aspect="4:5" framing={FRAMING} />);
    expect(box().style.opacity).toBe("0");
    loadImage(240, 180);
    expect(box().style.opacity).toBe("");
    expect(box().style.width).not.toBe("");

    rerender(<FramedMedia url="data:b" aspect="4:5" framing={FRAMING} />);
    expect(box().style.opacity).toBe("0");
    loadImage(180, 240);
    expect(box().style.opacity).toBe("");
  });

  // Switching slides remounts the stage: a picture seen before lays out in the first render.
  it("lays out a picture it measured before as soon as it mounts again", () => {
    const first = render(<FramedMedia url="data:seen" aspect="4:5" framing={FRAMING} />);
    loadImage(300, 200);
    first.unmount();
    render(<FramedMedia url="data:seen" aspect="4:5" framing={FRAMING} />);
    expect(box().style.opacity).toBe("");
    expect(box().style.width).not.toBe("");
  });

  // Small data-URL thumbnails could finish loading before the effect that reset the
  // size ran, which left every slide-strip thumbnail invisible (a black tile).
  it("measures a picture that was already decoded when it mounted", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(240);
    vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(180);
    render(<FramedMedia url="data:cached" aspect="4:5" framing={FRAMING} />);
    expect(box().style.opacity).toBe("");
    expect(box().style.width).not.toBe("");
  });
});
