import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  renders: [] as number[],
  qualities: [] as string[],
  shows: [] as unknown[],
  disposed: { n: 0 },
  fail: { value: false },
}));

vi.mock("@/viz/engine", async () => {
  const { GLUnavailableError } = await import("@/viz/gl/core");
  return {
    Engine: class {
      options: { width: number; height: number };
      constructor(
        readonly canvas: HTMLCanvasElement,
        opts: { width: number; height: number },
      ) {
        if (h.fail.value) throw new GLUnavailableError("none");
        this.options = { width: opts.width, height: opts.height };
      }
      setAnalysis() {}
      setShow(s: unknown) {
        h.shows.push(s);
      }
      setTextures() {}
      setQuality(q: string) {
        h.qualities.push(q);
      }
      resize(w: number, hh: number) {
        this.options = { width: w, height: hh };
      }
      render(t: number) {
        h.renders.push(t);
      }
      dispose() {
        h.disposed.n++;
      }
    },
  };
});

import { buildFixture } from "@/viz/fixture";
import { PRESETS, showFromPreset } from "@/viz/presets";
import { fitSize, loudestWindow, thumbSize } from "./host";
import { PresetThumbs, orderThumbs, type ThumbItem } from "./PresetThumbs";
import { VisualsCanvas } from "./VisualsCanvas";

const preset = PRESETS[0]!;
const analysis = buildFixture({ durationMs: 20_000, fps: 30 });

beforeEach(() => {
  h.renders.length = 0;
  h.qualities.length = 0;
  h.shows.length = 0;
  h.disposed.n = 0;
  h.fail.value = false;
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});

describe("host helpers", () => {
  it("fits an aspect inside a box and caps the long side", () => {
    expect(fitSize(800, 400, 16 / 9, 1)).toMatchObject({ w: 711, h: 400 });
    expect(fitSize(4000, 4000, 16 / 9, 2).w).toBe(1920);
    expect(fitSize(300, 600, 9 / 16, 1)).toMatchObject({ cssW: 300 });
  });

  it("sizes thumbnails at 320 on the long side", () => {
    expect(thumbSize(16 / 9)).toEqual({ w: 320, h: 180 });
    expect(thumbSize(9 / 16)).toEqual({ w: 180, h: 320 });
  });

  it("finds the loudest window", () => {
    const level = new Float32Array(300);
    level.fill(0.1, 0, 300);
    level.fill(1, 150, 250);
    const a = { fps: 10, channel: () => level };
    const start = loudestWindow(a, 8000);
    expect(start).toBeGreaterThanOrEqual(15_000 - 1000);
    expect(start).toBeLessThanOrEqual(17_000);
    expect(loudestWindow({ fps: 10, channel: () => null }, 8000)).toBe(0);
  });
});

describe("VisualsCanvas", () => {
  it("renders on each timeMs change and disposes on unmount", async () => {
    const show = showFromPreset(preset);
    const { rerender, unmount } = render(<VisualsCanvas show={show} analysis={analysis} timeMs={1000} aspect={16 / 9} mode="opaque" />);
    await waitFor(() => expect(h.renders).toContain(1000));
    rerender(<VisualsCanvas show={show} analysis={analysis} timeMs={1016} aspect={16 / 9} mode="opaque" />);
    await waitFor(() => expect(h.renders).toContain(1016));
    unmount();
    expect(h.disposed.n).toBe(1);
  });

  it("honours a fixed quality", async () => {
    render(<VisualsCanvas show={showFromPreset(preset)} analysis={analysis} timeMs={0} aspect={1} mode="opaque" quality="draft" />);
    await waitFor(() => expect(h.qualities).toContain("draft"));
  });

  it("shows a friendly message when WebGL is unavailable", async () => {
    h.fail.value = true;
    render(<VisualsCanvas show={showFromPreset(preset)} analysis={analysis} timeMs={0} aspect={1} mode="opaque" />);
    expect(await screen.findByText(/can't run the visualizer/)).toBeTruthy();
  });
});

describe("PresetThumbs", () => {
  const items: ThumbItem[] = [
    { id: "p1", name: "Preset one", description: "First", show: showFromPreset(preset), kind: "preset" },
    { id: "m1", name: "Saved one", description: "Saved design", show: showFromPreset(preset), kind: "mine" },
  ];

  it("lists saved designs first with a badge", () => {
    expect(orderThumbs(items).map((i) => i.id)).toEqual(["m1", "p1"]);
    render(<PresetThumbs items={items} analysis={analysis} timeMs={0} aspect={16 / 9} mode="opaque" selectedId={null} onSelect={() => undefined} />);
    const cards = screen.getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") !== null);
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual(["Saved one", "Preset one"]);
    expect(screen.getByText("Mine")).toBeTruthy();
  });

  it("selects with the keyboard and marks the selection", async () => {
    const onSelect = vi.fn();
    render(<PresetThumbs items={items} analysis={analysis} timeMs={null} aspect={16 / 9} mode="opaque" selectedId="p1" onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: "Preset one" }).getAttribute("aria-pressed")).toBe("true");
    screen.getByRole("button", { name: "Saved one" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }));
  });

  it("offers rename and delete only for saved designs when handlers are given", () => {
    render(<PresetThumbs items={items} analysis={analysis} timeMs={0} aspect={16 / 9} mode="opaque" selectedId={null} onSelect={() => undefined} onRename={() => undefined} onDelete={() => undefined} />);
    expect(screen.getAllByRole("button", { name: /options/ })).toHaveLength(1);
  });

  it("renders thumbnails with the hidden engine", async () => {
    render(<PresetThumbs items={items} analysis={analysis} timeMs={2500} aspect={16 / 9} mode="opaque" selectedId={null} onSelect={() => undefined} />);
    await waitFor(() => expect(h.renders).toContain(2500));
  });
});
