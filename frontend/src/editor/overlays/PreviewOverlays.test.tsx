import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { EditSourceState } from "@/lib/api";
import { normalizeProject } from "@/viz/edit/defaults";
import { fixtureProject } from "@/viz/edit/fixture";
import { newMask, parseMasks, parseTransform, serializeMasks } from "@/viz/edit/schema";
import type { Mask } from "@/viz/edit/types";
import { findClip, withClip } from "@/editor/doc";
import { useMaskSelection } from "../inspector/inspectorState";
import { useEditStudio } from "@/editor/store";
import { PreviewOverlays } from "./PreviewOverlays";

const st = () => useEditStudio.getState();
const clip = (id: string) => findClip(st().history!.present, id)!.clip;

/** A 540×960 canvas shown at 1:1 inside a positioned parent. */
function mount() {
  const canvas = document.createElement("canvas");
  canvas.width = 540;
  canvas.height = 960;
  canvas.getBoundingClientRect = () => new DOMRect(10, 20, 540, 960);
  const host = document.createElement("div");
  host.getBoundingClientRect = () => new DOMRect(0, 0, 700, 1000);
  document.body.appendChild(host);
  const view = render(<PreviewOverlays canvas={canvas} width={540} height={960} />, { container: host });
  return { ...view, canvas };
}

/** A 1080×1920 portrait video, so `fill` is exactly the frame. */
const source = (path: string): EditSourceState =>
  ({ path, info: { path, kind: "video", durationMs: 8000, width: 1080, height: 1920, fps: 30, rotation: 0, hasAudio: false, takenAt: 0, error: "" }, preview: null, image: "", shots: null, preparing: false, error: "" }) as EditSourceState;

function open(id: string | null, extra?: (doc: ReturnType<typeof normalizeProject>) => ReturnType<typeof normalizeProject>) {
  let doc = normalizeProject(fixtureProject());
  if (extra) doc = extra(doc);
  st().open("p1", "T", doc);
  st().setSources([source("/fixture/a.mp4"), source("/fixture/b.mp4"), { ...source("/fixture/photo.jpg"), info: { ...source("").info, kind: "image" } }]);
  st().select(id ? { kind: "clips", ids: [id] } : null);
}

const down = (el: Element, x: number, y: number, extra: Record<string, unknown> = {}) => fireEvent.pointerDown(el, { clientX: x + 10, clientY: y + 20, button: 0, pointerId: 1, ...extra });
const moveTo = (el: Element, x: number, y: number, extra: Record<string, unknown> = {}) => fireEvent.pointerMove(el, { clientX: x + 10, clientY: y + 20, pointerId: 1, ...extra });
const up = (el: Element) => fireEvent.pointerUp(el, { pointerId: 1 });

beforeEach(() => {
  st().close();
  useMaskSelection.getState().select(null, null);
  document.body.innerHTML = "";
});

describe("PreviewOverlays: transform box", () => {
  it("shows for a selected video clip at the playhead, and not when the playhead is outside it", () => {
    open("c1");
    st().setPlayhead(1000);
    mount();
    expect(screen.getByTestId("transform-box")).toBeTruthy();
    act(() => st().setPlayhead(9000)); // c1 ends at 8000
    expect(screen.queryByTestId("transform-box")).toBeNull();
    act(() => st().setPlayhead(2000));
    expect(screen.getByTestId("transform-box")).toBeTruthy();
    act(() => st().setPlaying(true));
    expect(screen.queryByTestId("transform-box")).toBeNull();
  });

  it("is hidden for nothing selected, several clips and adjustment clips", () => {
    open(null);
    st().setPlayhead(1000);
    mount();
    expect(screen.queryByTestId("transform-box")).toBeNull();
    act(() => st().select({ kind: "clips", ids: ["c1", "c2"] }));
    expect(screen.queryByTestId("transform-box")).toBeNull();
    act(() => {
      st().setPlayhead(17_000);
      st().select({ kind: "clips", ids: ["c4"] });
    });
    expect(screen.queryByTestId("transform-box")).toBeNull();
  });

  it("moves x/y by the drag, in one undo step, snapping to the centre lines", () => {
    open("c1");
    st().setPlayhead(1000);
    mount();
    const before = st().history!.past.length;
    const body = screen.getByTestId("transform-body");
    down(body, 270, 480);
    moveTo(body, 270 + 54, 480 - 96); // +0.1 of W, −0.1 of H
    moveTo(body, 270 + 108, 480 - 192);
    let t = parseTransform(clip("c1").transform).value;
    expect(t.x).toBeCloseTo(0.2);
    expect(t.y).toBeCloseTo(-0.2);
    // back to within 5 px of the centre lines: snapped to exactly 0
    moveTo(body, 270 + 3, 480 - 4);
    t = parseTransform(clip("c1").transform).value;
    expect(t.x).toBe(0);
    expect(t.y).toBe(0);
    up(body);
    expect(st().history!.past.length).toBe(before + 1);
    st().undo();
    expect(clip("c1").transform).toBe("");
  });

  it("scales uniformly from a corner", () => {
    open("c1");
    st().setPlayhead(1000);
    mount();
    const h = screen.getByTestId("handle-br");
    down(h, 540, 960);
    moveTo(h, 270 + 540, 480 + 960); // twice as far from the centre
    up(h);
    expect(parseTransform(clip("c1").transform).value.scale).toBeCloseTo(2);
  });

  it("rotates with the top handle and snaps near 0/45°", () => {
    open("c1");
    st().setPlayhead(1000);
    mount();
    const h = screen.getByTestId("handle-rotate");
    down(h, 270, 480 - 480 - 30);
    moveTo(h, 270 + 300, 480); // a quarter turn clockwise
    expect(parseTransform(clip("c1").transform).value.rotation).toBeCloseTo(90);
    moveTo(h, 270 + 300, 480 - 295); // ≈ 45° → snaps
    expect(parseTransform(clip("c1").transform).value.rotation).toBe(45);
    up(h);
  });

  it("writes a key at the playhead when the param is keyed, else the base", () => {
    open("c2", (d) => d); // c2: photo at 8000..16000 with scale keys at 0 and 8000
    st().setPlayhead(12_000); // clip time 4000
    mount();
    const body = screen.getByTestId("transform-body");
    down(body, 270, 480);
    moveTo(body, 270 + 27, 480);
    up(body);
    const t = parseTransform(clip("c2").transform).value;
    expect(t.x).toBeCloseTo(0.05); // x isn't keyed: base
    const h = screen.getByTestId("handle-tl");
    down(h, 0, 0);
    moveTo(h, -270, -480);
    up(h);
    const scale = parseTransform(clip("c2").transform).value.scale;
    expect(typeof scale === "object" && scale.keys?.map((k) => k.t)).toEqual([0, 4000, 8000]);
  });
});

describe("PreviewOverlays: mask handles", () => {
  const withMask = (shape: Mask["shape"]) => (d: ReturnType<typeof normalizeProject>) => {
    const m = { ...newMask("m1", shape) };
    return withClip(d, "c1", { masks: serializeMasks([m]) });
  };

  it("shows handles instead of the box for the selected mask, and moves a rect mask", () => {
    open("c1", withMask("rect"));
    st().setPlayhead(1000);
    useMaskSelection.getState().select("c1", "m1");
    mount();
    expect(screen.queryByTestId("transform-box")).toBeNull();
    const body = screen.getByTestId("mask-body");
    down(body, 270, 480);
    moveTo(body, 270 + 54, 480);
    up(body);
    const m = parseMasks(clip("c1").masks).value[0]!;
    expect(m.x).toBeCloseTo(0.6);
    expect(m.y).toBeCloseTo(0.5);
  });

  it("resizes a rect mask from a corner around its centre", () => {
    open("c1", withMask("ellipse"));
    st().setPlayhead(1000);
    useMaskSelection.getState().select("c1", "m1");
    mount();
    const c = screen.getByTestId("mask-corner-2"); // bottom right of a 0.5×0.5 mask: (405, 720)
    down(c, 405, 720);
    moveTo(c, 540, 960);
    up(c);
    const m = parseMasks(clip("c1").masks).value[0]!;
    expect(m.w).toBeCloseTo(1);
    expect(m.h).toBeCloseTo(1);
  });

  it("drags, adds and removes path points", () => {
    open("c1", withMask("path"));
    st().setPlayhead(1000);
    useMaskSelection.getState().select("c1", "m1");
    mount();
    // the default path is the square 0.3..0.7: point 0 is at (162, 288)
    const p0 = screen.getByTestId("mask-point-0");
    down(p0, 162, 288);
    moveTo(p0, 108, 192);
    up(p0);
    expect(parseMasks(clip("c1").masks).value[0]?.points?.[0]).toEqual([expect.closeTo(0.2), expect.closeTo(0.2)]);
    // double-click on the edge between point 0 (108,192) and point 1 (378,288), at its midpoint, adds a point after point 0
    fireEvent.doubleClick(screen.getByTestId("mask-edges"), { clientX: 243 + 10, clientY: 240 + 20 });
    let pts = parseMasks(clip("c1").masks).value[0]!.points!;
    expect(pts).toHaveLength(5);
    expect(pts[1]?.[0]).toBeCloseTo(0.45, 2);
    expect(pts[1]?.[1]).toBeCloseTo(0.25, 2);
    // Alt-click removes a point, but never below three
    fireEvent.pointerDown(screen.getByTestId("mask-point-1"), { button: 0, pointerId: 2, altKey: true });
    pts = parseMasks(clip("c1").masks).value[0]!.points!;
    expect(pts).toHaveLength(4);
    fireEvent.pointerDown(screen.getByTestId("mask-point-1"), { button: 0, pointerId: 2, altKey: true });
    fireEvent.pointerDown(screen.getByTestId("mask-point-1"), { button: 0, pointerId: 2, altKey: true });
    expect(parseMasks(clip("c1").masks).value[0]!.points).toHaveLength(3);
  });

  it("ignores a selected mask that belongs to another clip", () => {
    open("c1", withMask("rect"));
    st().setPlayhead(1000);
    useMaskSelection.getState().select("c2", "m1");
    mount();
    expect(screen.getByTestId("transform-box")).toBeTruthy();
    expect(screen.queryByTestId("mask-handles")).toBeNull();
  });
});

describe("PreviewOverlays: safe zones", () => {
  it("draw only when switched on and for 9:16 and 4:5", () => {
    open(null);
    mount();
    expect(screen.queryByTestId("safe-zones")).toBeNull();
    act(() => st().setSafeZones(true));
    const zones = screen.getByTestId("safe-zones");
    expect(zones.querySelectorAll("[data-zone]")).toHaveLength(4);
    expect(zones.textContent).toContain("Bottom 22%");
    act(() => st().edit({ ...st().history!.present, aspect: "1:1" }));
    expect(screen.queryByTestId("safe-zones")).toBeNull();
    act(() => st().edit({ ...st().history!.present, aspect: "4:5" }));
    expect(screen.getByTestId("safe-zones")).toBeTruthy();
  });

  it("sit over the canvas's on-screen box", () => {
    open(null);
    mount();
    const root = screen.getByTestId("preview-overlays");
    expect(root.style.left).toBe("10px");
    expect(root.style.top).toBe("20px");
    expect(root.style.width).toBe("540px");
    expect(root.style.height).toBe("960px");
  });
});
