// Pointer input (SPEC §1.2): turns PointerEvents into InputPoints in canvas
// pixels and drives the engine's stroke API. Coalesced events give every
// sample, predicted events a provisional tail, `pointerrawupdate` (where it
// exists) lowers latency for pens. Mice get pressure simulated from velocity;
// while a pen is in use, touch only navigates (palm rejection).

import { evalCurve } from "../brushes/curve";
import type { Curve } from "../brushes/schema";
import type { InputPoint, PaintEngine, Point, StrokeResult, ToolState } from "../engine/types";
import type { PaintEngineExt } from "../engine/engine";

export interface PointerOptions {
  engine: PaintEngine & Partial<PaintEngineExt>;
  /** The tool to paint with, or null when the pointer shouldn't paint (navigating, a transform is active…). */
  getTool(e: PointerEvent): ToolState | null;
  /** A mouse's pressure follows its speed (default true). */
  simulatePressure?: () => boolean;
  /** While a pen is active, ignore touch for drawing (default true). */
  palmRejection?: () => boolean;
  /** Global pressure response; identity when absent. */
  pressureCurve?: () => Curve | undefined;
  onStrokeStart?(): void;
  onStrokeEnd?(r: StrokeResult): void;
  /** A touch was ignored because a pen is active (let the host treat it as navigation). */
  onRejectedTouch?(e: PointerEvent): void;
}

const MOUSE_PRESSURE_FLOOR = 0.2;

export function toolPressure(e: PointerEvent, simulated: number, simulate: boolean): number {
  if (e.pointerType === "pen") return e.pressure > 0 ? e.pressure : 0.01;
  if (e.pointerType === "mouse") return simulate ? simulated : 1;
  return e.pressure > 0 && e.pressure !== 0.5 ? e.pressure : 1;
}

/** tiltX/tiltY in degrees from a PointerEvent (tilt properties, else altitude/azimuth). */
export function tiltOf(e: PointerEvent): [number, number] {
  if (e.tiltX || e.tiltY) return [e.tiltX, e.tiltY];
  const ev = e as PointerEvent & { altitudeAngle?: number; azimuthAngle?: number };
  const alt = ev.altitudeAngle;
  const az = ev.azimuthAngle;
  if (typeof alt === "number" && typeof az === "number" && alt < Math.PI / 2 - 1e-3) {
    const t = Math.tan(Math.PI / 2 - alt);
    const deg = (v: number) => (Math.atan(v) * 180) / Math.PI;
    return [deg(t * Math.cos(az)), deg(t * Math.sin(az))];
  }
  return [0, 0];
}

/** Attach to the canvas element; returns a detach function. */
export function attachPointer(el: HTMLCanvasElement, o: PointerOptions): () => void {
  el.style.touchAction = "none";
  let activeId = -1;
  let penSeen = false;
  let t0 = 0;
  let lastX = 0;
  let lastY = 0;
  let lastT = 0;
  let simP = 0.6;
  let lastTs = 0;

  const toCanvas = (e: PointerEvent): Point => {
    const r = el.getBoundingClientRect();
    return o.engine.view.screenToCanvas({ x: e.clientX - r.left, y: e.clientY - r.top });
  };

  const point = (e: PointerEvent): InputPoint => {
    const c = toCanvas(e);
    const t = Math.max(0, e.timeStamp - t0);
    if (e.pointerType === "mouse") {
      const dt = Math.max(1, t - lastT);
      const speed = Math.hypot(c.x - lastX, c.y - lastY) / dt; // canvas px per ms
      const target = Math.max(MOUSE_PRESSURE_FLOOR, 1 - speed * 0.3);
      simP += (target - simP) * 0.25;
    }
    lastX = c.x;
    lastY = c.y;
    lastT = t;
    const curve = o.pressureCurve?.();
    let pr = toolPressure(e, simP, o.simulatePressure?.() ?? true);
    if (curve) pr = evalCurve(curve, pr);
    const [tx, ty] = tiltOf(e);
    return { x: c.x, y: c.y, pressure: pr, tiltX: tx, tiltY: ty, twist: e.twist || 0, t, pointer: e.pointerType === "pen" ? "pen" : e.pointerType === "touch" ? "touch" : "mouse" };
  };

  const finish = () => {
    activeId = -1;
    const ext = o.engine.endStrokeAsync;
    if (ext) void ext.call(o.engine).then((r) => o.onStrokeEnd?.(r));
    else o.onStrokeEnd?.(o.engine.endStroke());
  };

  const down = (e: PointerEvent) => {
    if (e.pointerType === "pen") penSeen = true;
    if (e.pointerType === "touch" && penSeen && (o.palmRejection?.() ?? true)) {
      o.onRejectedTouch?.(e);
      return;
    }
    if (activeId !== -1) {
      // A second pointer (a two-finger gesture) cancels the stroke.
      o.engine.cancelStroke();
      activeId = -1;
      return;
    }
    if (e.button !== 0) return;
    const tool = o.getTool(e);
    if (!tool) return;
    activeId = e.pointerId;
    t0 = e.timeStamp;
    lastTs = e.timeStamp;
    simP = 0.6;
    const c = toCanvas(e);
    lastX = c.x;
    lastY = c.y;
    lastT = 0;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events have no active pointer */
    }
    o.onStrokeStart?.();
    o.engine.beginStroke(tool, point(e));
    e.preventDefault();
  };

  const move = (e: PointerEvent) => {
    if (e.pointerId !== activeId) return;
    const co = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    // pointerrawupdate and pointermove both arrive: only take samples we haven't seen.
    const fresh = (co.length > 0 ? co : [e]).filter((x) => x.timeStamp > lastTs);
    if (fresh.length === 0) return;
    lastTs = (fresh[fresh.length - 1] as PointerEvent).timeStamp;
    const pts = fresh.map(point);
    const pr = typeof e.getPredictedEvents === "function" ? e.getPredictedEvents().map(predictedPoint) : [];
    o.engine.extendStroke(pts, pr);
    e.preventDefault();
  };

  // Predicted points must not disturb the velocity filter.
  const predictedPoint = (e: PointerEvent): InputPoint => {
    const c = toCanvas(e);
    const [tx, ty] = tiltOf(e);
    const base = point(e);
    return { ...base, x: c.x, y: c.y, tiltX: tx, tiltY: ty };
  };

  const up = (e: PointerEvent) => {
    if (e.pointerId !== activeId) return;
    const co = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    const fresh = co.filter((x) => x.timeStamp > lastTs);
    if (fresh.length > 0) o.engine.extendStroke(fresh.map(point), []);
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    finish();
  };

  const cancel = (e: PointerEvent) => {
    if (e.pointerId !== activeId) return;
    activeId = -1;
    o.engine.cancelStroke();
  };

  const hasRaw = "onpointerrawupdate" in el;
  el.addEventListener("pointerdown", down);
  el.addEventListener(hasRaw ? "pointerrawupdate" : "pointermove", move as EventListener);
  if (hasRaw) el.addEventListener("pointermove", move); // raw updates stop for mice/touch on some builds
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", cancel);
  return () => {
    el.removeEventListener("pointerdown", down);
    el.removeEventListener(hasRaw ? "pointerrawupdate" : "pointermove", move as EventListener);
    if (hasRaw) el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", cancel);
  };
}
