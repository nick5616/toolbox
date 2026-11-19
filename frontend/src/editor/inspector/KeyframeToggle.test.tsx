import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditParam, Key } from "@/viz/edit/types";
import { KeyframeToggle } from "./KeyframeToggle";
import { CURVE_H, CURVE_W, curvePath, curveOfEase, curveRange, curveToPx, moveHandle, nudgeHandle, pxToCurve, type Bez } from "./easeCurve";
import { EaseCurveEditor } from "./EaseCurveEditor";
import { paramKeys, setBezierAt, setEaseAt, setKeyAt } from "./paramOps";

afterEach(cleanup);

const keyed = (ease: Key["ease"], bez?: Key["bez"]): EditParam => ({ base: 0, keys: [bez ? { t: 100, v: 1, ease, bez } : { t: 100, v: 1, ease }, { t: 900, v: 5, ease: "linear" }] });

describe("ease picker", () => {
  it("offers the seven choices", () => {
    render(<KeyframeToggle name="Scale" value={keyed("linear")} current={1} clipTimeMs={100} onChange={() => undefined} />);
    const sel = screen.getByRole("combobox", { name: "Easing of Scale key" });
    expect(Array.from(sel.querySelectorAll("option")).map((o) => o.textContent)).toEqual(["Linear", "Hold", "Ease in", "Ease out", "Ease in-out", "Smooth", "Custom"]);
  });

  it("picking Ease in sets the key's ease", async () => {
    const onChange = vi.fn();
    render(<KeyframeToggle name="Scale" value={keyed("linear")} current={1} clipTimeMs={100} onChange={onChange} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Easing of Scale key" }), "in");
    const next = onChange.mock.calls[0]?.[0] as EditParam;
    expect(paramKeys(next)[0]).toEqual({ t: 100, v: 1, ease: "in" });
  });

  it("picking Custom starts from the current curve and opens the editor", async () => {
    let value = keyed("inout");
    const onChange = vi.fn((n: EditParam) => {
      value = n;
    });
    const { rerender } = render(<KeyframeToggle name="Scale" value={value} current={1} clipTimeMs={100} onChange={onChange} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Easing of Scale key" }), "bezier");
    expect(paramKeys(value)[0]).toMatchObject({ ease: "bezier", bez: curveOfEase("inout") });
    rerender(<KeyframeToggle name="Scale" value={value} current={1} clipTimeMs={100} onChange={onChange} />);
    expect(screen.getByTestId("ease-curve")).toBeTruthy();
  });

  it("a custom key shows an Edit curve button that toggles the editor", async () => {
    render(<KeyframeToggle name="Scale" value={keyed("bezier", [0.2, 0.4, 0.6, 0.9])} current={1} clipTimeMs={100} onChange={() => undefined} />);
    expect(screen.queryByTestId("ease-curve")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Edit Scale curve" }));
    expect(screen.getByTestId("ease-curve")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Edit Scale curve" }));
    expect(screen.queryByTestId("ease-curve")).toBeNull();
  });

  it("every control has a tooltip", () => {
    render(<KeyframeToggle name="Scale" value={keyed("bezier", [0.2, 0.4, 0.6, 0.9])} current={1} clipTimeMs={100} onChange={() => undefined} />);
    for (const el of [screen.getByRole("combobox", { name: "Easing of Scale key" }), screen.getByRole("button", { name: "Edit Scale curve" }), screen.getByRole("button", { name: "Remove Scale key" })]) {
      expect(el.getAttribute("data-tip")).toBeTruthy();
    }
  });
});

describe("paramOps with curves", () => {
  it("setKeyAt keeps a custom curve; other eases drop it", () => {
    const p = keyed("bezier", [0.2, 0.4, 0.6, 0.9]);
    expect(paramKeys(setKeyAt(p, 100, 3))[0]).toEqual({ t: 100, v: 3, ease: "bezier", bez: [0.2, 0.4, 0.6, 0.9] });
    expect(paramKeys(setKeyAt(p, 100, 3, "linear"))[0]).toEqual({ t: 100, v: 3, ease: "linear" });
    expect(paramKeys(setEaseAt(p, 100, "out"))[0]).toEqual({ t: 100, v: 1, ease: "out" });
  });
  it("setBezierAt clamps to the schema's limits", () => {
    const k = paramKeys(setBezierAt(keyed("linear"), 100, [-1, -5, 3, 9]))[0];
    expect(k).toEqual({ t: 100, v: 1, ease: "bezier", bez: [0, -1, 1, 2] });
  });
});

describe("curve maths", () => {
  const bez: Bez = [0.25, 0.1, 0.25, 1];
  it("the range covers 0..1 and any overshoot", () => {
    expect(curveRange(bez)).toEqual({ lo: -0.1, hi: 1.1 });
    const wide = curveRange([0, -0.5, 1, 1.6]);
    expect(wide.lo).toBeCloseTo(-0.6, 9);
    expect(wide.hi).toBeCloseTo(1.7, 9);
  });
  it("px and curve space round-trip", () => {
    const r = curveRange(bez);
    const p = curveToPx({ x: 0.25, y: 0.1 }, r);
    expect(p.x).toBeGreaterThan(0);
    expect(p.x).toBeLessThan(CURVE_W);
    expect(p.y).toBeLessThan(CURVE_H);
    const back = pxToCurve(p, r);
    expect(back.x).toBeCloseTo(0.25, 2);
    expect(back.y).toBeCloseTo(0.1, 2);
  });
  it("y grows upward", () => {
    const r = curveRange(bez);
    expect(curveToPx({ x: 0, y: 1 }, r).y).toBeLessThan(curveToPx({ x: 0, y: 0 }, r).y);
  });
  it("handles clamp and nudge", () => {
    expect(moveHandle(bez, 1, { x: 2, y: -3 })).toEqual([1, -1, 0.25, 1]);
    expect(moveHandle(bez, 2, { x: -1, y: 5 })).toEqual([0.25, 0.1, 0, 2]);
    expect(nudgeHandle(bez, 1, 0.02, -0.02)).toEqual([0.27, 0.08, 0.25, 1]);
  });
  it("draws a cubic path from corner to corner", () => {
    expect(curvePath(bez, curveRange(bez))).toMatch(/^M [\d.]+ [\d.]+ C /);
  });
});

describe("curve editor", () => {
  it("arrow keys nudge the focused handle, Shift by more", () => {
    const onChange = vi.fn();
    render(<EaseCurveEditor value={[0.25, 0.1, 0.25, 1]} onChange={onChange} />);
    const h1 = screen.getByTestId("ease-handle-1");
    fireEvent.keyDown(h1, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith([0.27, 0.1, 0.25, 1]);
    fireEvent.keyDown(h1, { key: "ArrowUp", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith([0.25, 0.2, 0.25, 1]);
    fireEvent.keyDown(screen.getByTestId("ease-handle-2"), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith([0.25, 0.1, 0.23, 1]);
    const n = onChange.mock.calls.length;
    fireEvent.keyDown(h1, { key: "a" });
    expect(onChange.mock.calls.length).toBe(n);
  });

  it("dragging a handle moves it", () => {
    const onChange = vi.fn();
    render(<EaseCurveEditor value={[0.25, 0.1, 0.25, 1]} onChange={onChange} />);
    const svg = screen.getByTestId("ease-curve");
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: CURVE_W, height: CURVE_H, right: CURVE_W, bottom: CURVE_H, x: 0, y: 0, toJSON: () => ({}) });
    const h1 = screen.getByTestId("ease-handle-1");
    fireEvent.pointerDown(h1, { button: 0, pointerId: 1 });
    // the centre of the plot is x 0.5; y at 0.5 of the range
    fireEvent.pointerMove(h1, { pointerId: 1, clientX: CURVE_W / 2, clientY: CURVE_H / 2 });
    const next = onChange.mock.calls.at(-1)?.[0] as Bez;
    expect(next[0]).toBeCloseTo(0.5, 2);
    expect(next[1]).toBeCloseTo(0.5, 1);
    expect(next[2]).toBe(0.25);
    fireEvent.pointerUp(h1, { pointerId: 1 });
  });

  it("handles have names, values and tooltips", () => {
    render(<EaseCurveEditor value={[0.25, 0.1, 0.25, 1]} onChange={() => undefined} />);
    const h = screen.getByTestId("ease-handle-2");
    expect(h.getAttribute("aria-valuetext")).toBe("x 0.25, y 1.00");
    expect(h.getAttribute("data-tip")).toBeTruthy();
  });
});
