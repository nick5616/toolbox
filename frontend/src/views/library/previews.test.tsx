import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (orig) => {
  const { libraryApiMock } = await import("./testSvc");
  return libraryApiMock(orig as never);
});

import { OutputKind } from "@/lib/api";
import { fromOutput } from "./items";
import { ItemThumb, firstLines } from "./previews/ItemThumb";
import { CACHE_SIZE, LRU, Limiter, MAX_CONCURRENT, clearPreviewCache, previewKey } from "./previews/loader";
import { img, out, resetMocks, svc } from "./testFixtures";

describe("preview loading", () => {
  it("the cache is an LRU of 500, keyed by path and age", () => {
    expect(CACHE_SIZE).toBe(500);
    const c = new LRU<number>(3);
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    c.get("a"); // a is fresh again
    c.set("d", 4);
    expect(c.has("b")).toBe(false);
    expect(c.has("a")).toBe(true);
    expect(c.size).toBe(3);
    const base = { path: "/x.png", at: 1, sizeBytes: 5 };
    expect(previewKey(base)).not.toBe(previewKey({ ...base, at: 2 }));
  });

  it("runs at most 6 loads at once", async () => {
    expect(MAX_CONCURRENT).toBe(6);
    const l = new Limiter(MAX_CONCURRENT);
    let running = 0;
    let peak = 0;
    const task = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 2));
      running--;
    };
    await Promise.all(Array.from({ length: 25 }, () => l.push(task, () => false)));
    expect(peak).toBe(6);
    expect(l.peak).toBe(6);
  });

  it("skips loads that were cancelled before they started", async () => {
    const l = new Limiter(1);
    const ran: number[] = [];
    const first = l.push(async () => ran.push(1), () => false);
    const second = l.push(async () => ran.push(2), () => true);
    await Promise.all([first, second]);
    expect(ran).toEqual([1]);
  });

  it("firstLines keeps the first non-empty lines", () => {
    expect(firstLines("a\n\n b \nc\nd", 3)).toBe("a\n b \nc");
  });
});

describe("ItemThumb", () => {
  beforeEach(() => {
    resetMocks();
    clearPreviewCache();
  });

  it("images use ImageThumb", async () => {
    const { container } = render(<ItemThumb item={fromOutput(img("i1"))} />);
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA"));
    expect(svc.ImageThumb).toHaveBeenCalledWith("/lib/i1.png", 320);
  });

  it("caches by path, so a second card doesn't ask again", async () => {
    const item = fromOutput(img("i2"));
    const { container, unmount } = render(<ItemThumb item={item} />);
    await waitFor(() => expect(container.querySelector("img")).toBeTruthy());
    unmount();
    const again = render(<ItemThumb item={item} />);
    expect(again.container.querySelector("img")).toBeTruthy();
    expect(svc.ImageThumb).toHaveBeenCalledTimes(1);
  });

  it("video: a poster from the filmstrip that scrubs on hover", async () => {
    render(<ItemThumb item={fromOutput(out("v1", { kind: OutputKind.KindVideo, path: "/lib/v1.mp4", name: "v1.mp4" }))} />);
    const poster = await screen.findByTestId("video-poster");
    expect(svc.Filmstrip).toHaveBeenCalledWith("/lib/v1.mp4", 8, 120);
    expect(poster.style.backgroundImage).toContain("/media/t/strip.jpg");
    expect(poster.getAttribute("data-frame")).toBe("1");
    poster.getBoundingClientRect = () => ({ left: 0, width: 80, top: 0, height: 10, right: 80, bottom: 10, x: 0, y: 0, toJSON: () => undefined });
    fireEvent.mouseMove(poster, { clientX: 79 });
    expect(poster.getAttribute("data-frame")).toBe("7");
    fireEvent.mouseLeave(poster);
    expect(poster.getAttribute("data-frame")).toBe("1");
  });

  it("audio: a mini waveform and an inline play button", async () => {
    const { container } = render(<ItemThumb item={fromOutput(out("s1"))} play />);
    await waitFor(() => expect(container.querySelectorAll("[aria-hidden=true] span").length).toBe(48));
    expect(svc.Waveform).toHaveBeenCalledWith("/lib/s1.mp3", 100);
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
  });

  it("PDF: the first page and the page count", async () => {
    const { container } = render(<ItemThumb item={fromOutput(out("d1", { kind: OutputKind.KindDocument, path: "/lib/d1.pdf", name: "d1.pdf" }))} />);
    await screen.findByText("3 p");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,BBBB");
    expect(svc.Thumbnail).toHaveBeenCalledWith("/lib/d1.pdf", 1, 240, "");
  });

  it("text: the first lines, read 2 KB at most", async () => {
    render(<ItemThumb item={fromOutput(out("t1", { kind: OutputKind.KindDocument, path: "/lib/t1.srt", name: "t1.srt" }))} />);
    await screen.findByText(/line one/);
    expect(svc.ReadText).toHaveBeenCalledWith("/lib/t1.srt", 2048);
  });

  it("a missing file is greyed and never loaded", () => {
    const { container } = render(<ItemThumb item={fromOutput(img("m1", { missing: true }))} />);
    expect(container.firstElementChild?.className).toMatch(/missing/);
    expect(svc.ImageThumb).not.toHaveBeenCalled();
  });

  it("falls back to the type's icon when the preview fails", async () => {
    svc.ImageThumb.mockRejectedValue(new Error("HEIC"));
    const { container } = render(<ItemThumb item={fromOutput(img("h1", { path: "/lib/h1.heic", name: "h1.heic" }))} />);
    await waitFor(() => expect(svc.ImageThumb).toHaveBeenCalled());
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toBeTruthy();
  });
});
