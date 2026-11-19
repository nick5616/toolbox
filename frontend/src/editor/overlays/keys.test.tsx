import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findClip } from "@/editor/doc";
import { useEditStudio } from "@/editor/store";
import { normalizeProject } from "@/viz/edit/defaults";
import { fixtureProject } from "@/viz/edit/fixture";
import { setPreSampler, rgbToHex } from "@/viz/edit/preSampler";
import { parseEffects, parseTransform, serializeEffects, serializeTransform } from "@/viz/edit/schema";
import type { EditClip } from "@/lib/api";
import { CropBox, writeCrop } from "./CropBox";
import { EyedropperLayer, setEffectColour } from "./EyedropperLayer";
import { buildCtx } from "./overlayContext";
import { useOverlayMode } from "./overlayMode";

const st = () => useEditStudio.getState();
const clip = (): EditClip => findClip(st().history!.present, "c1")!.clip;
const frame = { w: 540, h: 960 };

function ctxFor(c: EditClip) {
  return buildCtx(c, undefined, frame, 1, c.startMs + 500, (e) => ({ x: e.clientX, y: e.clientY }));
}

beforeEach(() => {
  st().open("p1", "Test", normalizeProject(fixtureProject()));
  useOverlayMode.setState({ cropClipId: null, pick: null, pickError: null });
});
afterEach(() => {
  cleanup();
  setPreSampler(null);
  st().close();
});

describe("crop writing", () => {
  it("writes edges, keeps them in the document and removes an all-zero crop", () => {
    writeCrop("c1", { l: 0.1, t: 0.2 }, 0, "");
    expect(parseTransform(clip().transform).value.crop).toEqual({ l: 0.1, r: 0, t: 0.2, b: 0 });
    writeCrop("c1", { l: 0, t: 0 }, 0, "");
    expect(parseTransform(clip().transform).value.crop).toBeUndefined();
  });
  it("clamps to 0.45", () => {
    writeCrop("c1", { r: 0.9 }, 0, "");
    expect(parseTransform(clip().transform).value.crop?.r).toBe(0.45);
  });
  it("keys the edge at the playhead once it is keyed", () => {
    const t = parseTransform(clip().transform).value;
    st().edit(
      {
        ...st().history!.present,
        tracks: st().history!.present.tracks.map((tr) => ({
          ...tr,
          clips: tr.clips.map((cl) => (cl.id === "c1" ? { ...cl, transform: serializeTransform({ ...t, crop: { l: 0, r: 0, t: 0, b: { base: 0.1, keys: [{ t: 0, v: 0.1, ease: "linear" }] } } }) } : cl)),
        })),
      },
      "",
    );
    // keyed: a write at 400 ms adds a second key and leaves the first alone
    writeCrop("c1", { b: 0.2 }, 400, "");
    const b = parseTransform(clip().transform).value.crop?.b;
    expect(typeof b === "object" ? b.keys : null).toEqual([
      { t: 0, v: 0.1, ease: "linear" },
      { t: 400, v: 0.2, ease: "ease" },
    ]);
  });
});

describe("crop handles", () => {
  it("render four named, tooltipped edge handles and drag the crop", () => {
    const c = clip();
    render(
      <svg>
        <CropBox ctx={ctxFor(c)} />
      </svg>,
    );
    for (const id of ["l", "r", "t", "b"]) expect(screen.getByTestId(`crop-handle-${id}`).getAttribute("data-tip")).toBeTruthy();
    const left = screen.getByTestId("crop-handle-l");
    fireEvent.pointerDown(left, { button: 0, pointerId: 1 });
    // the clip fills the frame (no source info): x = 135 is a quarter of the width
    fireEvent.pointerMove(left, { pointerId: 1, clientX: 135, clientY: 480 });
    fireEvent.pointerUp(left, { pointerId: 1 });
    expect(parseTransform(clip().transform).value.crop?.l).toBeCloseTo(0.25, 6);
  });
});

describe("eyedropper", () => {
  const target = { clipId: "c1", postId: "fx1", param: "color" };
  function withKey() {
    const c = clip();
    st().edit(
      {
        ...st().history!.present,
        tracks: st().history!.present.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((cl) => (cl.id === "c1" ? { ...cl, effects: serializeEffects([{ id: "fx1", type: "chromakey", enabled: true, params: { color: "#00b140" } }]) } : cl)),
        })),
      },
      "",
    );
    return c;
  }

  it("setEffectColour changes only that effect's colour", () => {
    withKey();
    setEffectColour(target, "#112233");
    expect(parseEffects(clip().effects).value[0]?.params.color).toBe("#112233");
  });

  it("a click samples the clip's pre-effect pixel at the source point and sets the colour", () => {
    withKey();
    const sample = vi.fn(() => [0.1, 0.8, 0.2] as [number, number, number]);
    setPreSampler(sample);
    useOverlayMode.getState().startPick(target);
    render(
      <svg>
        <EyedropperLayer ctx={ctxFor(clip())} target={target} />
      </svg>,
    );
    fireEvent.pointerDown(screen.getByTestId("eyedropper"), { button: 0, clientX: 270, clientY: 480 });
    expect(sample).toHaveBeenCalledTimes(1);
    const [id, u, v] = sample.mock.calls[0] as unknown as [string, number, number];
    expect(id).toBe("c1");
    expect(u).toBeCloseTo(0.5, 6);
    expect(v).toBeCloseTo(0.5, 6);
    expect(parseEffects(clip().effects).value[0]?.params.color).toBe(rgbToHex([0.1, 0.8, 0.2]));
    expect(useOverlayMode.getState().pick).toBeNull();
  });

  it("explains when nothing can be sampled", () => {
    withKey();
    useOverlayMode.getState().startPick(target);
    render(
      <svg>
        <EyedropperLayer ctx={ctxFor(clip())} target={target} />
      </svg>,
    );
    fireEvent.pointerDown(screen.getByTestId("eyedropper"), { button: 0, clientX: 270, clientY: 480 });
    expect(useOverlayMode.getState().pickError).toMatch(/sample/);
    expect(parseEffects(clip().effects).value[0]?.params.color).toBe("#00b140");
  });

  it("Escape cancels", () => {
    useOverlayMode.getState().startPick(target);
    render(
      <svg>
        <EyedropperLayer ctx={ctxFor(clip())} target={target} />
      </svg>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useOverlayMode.getState().pick).toBeNull();
  });

  it("rgbToHex rounds and clamps", () => {
    expect(rgbToHex([0, 1, 2])).toBe("#00ffff");
    expect(rgbToHex([0.5, 0.25, -1])).toBe("#804000");
  });
});
