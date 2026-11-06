/**
 * Pointer input for the canvas (SPEC §1.2): pen/mouse/touch strokes with
 * coalesced and predicted points, mouse pressure from velocity, palm
 * rejection (touch only navigates once a pen was seen), Space/middle-drag pan,
 * R-drag rotate, Ctrl+wheel and pinch zoom, Alt/long-press eyedropper,
 * Shift-line, marquee/lasso/wand/fill dispatch, two- and three-finger taps.
 *
 * It drives the PaintEngine contract only, so P1's own input helper can
 * replace it by changing `runtime.attachInput` (engine-adapter.ts).
 */
import type { InputPoint, PaintEngine, Point, PointerKind, Rect, StrokeResult, ToolState } from "@/paint/engine/types";
import { isEditableTarget } from "@/lib/shortcuts";

export type OverlayShape = { kind: "rect" | "ellipse"; rect: Rect } | { kind: "lasso"; points: Point[] } | { kind: "points"; points: Array<Point & { positive: boolean }> };

/** What the editor tells the input layer, and what the input layer reports back. */
export interface InputController {
  /** The tool as the editor has it right now. */
  mode(): "stroke" | "eyedropper" | "fill" | "rect" | "ellipse" | "lasso" | "wand" | "transform" | "points" | "none";
  /** Brush-like tool state to start a stroke with (null = can't paint, e.g. a locked layer). */
  strokeTool(): ToolState | null;
  simulatePressure(): boolean;
  palmRejection(): boolean;
  onStrokeEnd(result: StrokeResult, tool: ToolState): void;
  onEyedrop(at: Point): void;
  onFill(at: Point): void;
  onWand(at: Point): void;
  onTransformDrag(dx: number, dy: number): void;
  /** Select object: a click, positive unless Alt was held. */
  onPoint(at: Point, positive: boolean): void;
  onOverlay(shape: OverlayShape | null): void;
  onTwoFingerTap(): void;
  onThreeFingerTap(): void;
  /** Called with the pointer's position in screen px while it moves (for cursors); optional. */
  onHover?(p: Point | null): void;
}

const TAP_MS = 260;
const TAP_SLOP = 12;

export function attachCanvasInput(canvas: HTMLCanvasElement, engine: PaintEngine, ctl: InputController): () => void {
  canvas.style.touchAction = "none";
  let space = false;
  let rotKey = false;
  let alt = false;
  let penSeen = false;
  let lastEnd: InputPoint | null = null;

  // Active gesture on the primary pointer.
  type Drag =
    | { kind: "stroke"; id: number; t0: number; last: Point; lastT: number; pressure: number; tool: ToolState; pointer: PointerKind }
    | { kind: "pan"; id: number; x: number; y: number }
    | { kind: "rotate"; id: number; cx: number; cy: number; a0: number; r0: number }
    | { kind: "shape"; id: number; mode: "rect" | "ellipse" | "lasso"; start: Point; points: Point[] }
    | { kind: "transform"; id: number; last: Point }
    | null;
  let drag: Drag = null;

  // Touch gesture tracking (palm-rejected or two+ fingers).
  const touches = new Map<number, { x: number; y: number; x0: number; y0: number; t0: number }>();
  let gesture: { dist: number; angle: number; cx: number; cy: number; zoom: number; rot: number; moved: boolean; max: number; t0: number } | null = null;

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toCanvas = (e: { clientX: number; clientY: number }): Point => engine.view.screenToCanvas(local(e));

  const inputPoint = (e: PointerEvent, st: { t0: number; last: Point; lastT: number; pressure: number }): InputPoint => {
    const kind = (e.pointerType === "pen" ? "pen" : e.pointerType === "touch" ? "touch" : "mouse") as PointerKind;
    const at = toCanvas(e);
    let pressure = e.pressure;
    if (kind === "mouse") {
      if (ctl.simulatePressure()) {
        const dt = Math.max(1, e.timeStamp - st.lastT);
        const speed = Math.hypot(at.x - st.last.x, at.y - st.last.y) * engine.view.get().zoom / dt; // screen px / ms
        const target = Math.min(1, Math.max(0.25, 1 - speed * 0.3));
        pressure = st.pressure + (target - st.pressure) * 0.35;
      } else pressure = 1;
    } else if (pressure === 0) pressure = 0.5;
    st.pressure = pressure;
    st.last = at;
    st.lastT = e.timeStamp;
    return { x: at.x, y: at.y, pressure, tiltX: e.tiltX || 0, tiltY: e.tiltY || 0, twist: e.twist || 0, t: Math.max(0, e.timeStamp - st.t0), pointer: kind };
  };

  const zoomAt = (factor: number, s: Point) => {
    const v = engine.view.get();
    const cp = engine.view.screenToCanvas(s);
    const zoom = Math.min(64, Math.max(0.02, v.zoom * factor));
    engine.view.set({ zoom });
    const s2 = engine.view.canvasToScreen(cp);
    const now = engine.view.get();
    engine.view.set({ panX: now.panX + (s.x - s2.x), panY: now.panY + (s.y - s2.y) });
  };

  const down = (e: PointerEvent) => {
    canvas.focus?.({ preventScroll: true });
    if (e.pointerType === "pen") penSeen = true;
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: e.timeStamp });
      canvas.setPointerCapture?.(e.pointerId);
      if (touches.size >= 2) {
        if (drag?.kind === "stroke") {
          engine.cancelStroke();
          drag = null;
        }
        startGesture(e.timeStamp);
        e.preventDefault();
        return;
      }
      if (penSeen && ctl.palmRejection()) {
        // A single finger only pans while a pen is in use.
        drag = { kind: "pan", id: e.pointerId, x: e.clientX, y: e.clientY };
        return;
      }
    }
    if (drag) return;
    canvas.setPointerCapture?.(e.pointerId);
    const s = local(e);
    if (e.button === 1 || (e.button === 0 && space)) {
      drag = { kind: "pan", id: e.pointerId, x: e.clientX, y: e.clientY };
      e.preventDefault();
      return;
    }
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (rotKey) {
      const r = canvas.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      drag = { kind: "rotate", id: e.pointerId, cx, cy, a0: Math.atan2(e.clientY - cy, e.clientX - cx), r0: engine.view.get().rotation };
      return;
    }
    const mode = ctl.mode();
    const at = engine.view.screenToCanvas(s);
    if (alt || mode === "eyedropper") {
      if (mode === "points") ctl.onPoint(at, !alt);
      else ctl.onEyedrop(at);
      return;
    }
    switch (mode) {
      case "stroke": {
        const tool = ctl.strokeTool();
        if (!tool) return;
        const st = { t0: e.timeStamp, last: at, lastT: e.timeStamp, pressure: e.pointerType === "mouse" ? 0.5 : e.pressure || 0.5 };
        if (e.shiftKey && lastEnd) {
          // Shift: a straight line from where the last stroke ended.
          const from = lastEnd;
          engine.beginStroke(tool, from);
          engine.extendStroke([{ ...from, t: 1 }, inputPoint(e, st)], []);
          const result = engine.endStroke();
          ctl.onStrokeEnd(result, tool);
          lastEnd = inputPoint(e, st);
          return;
        }
        const p = inputPoint(e, st);
        engine.beginStroke(tool, p);
        drag = { kind: "stroke", id: e.pointerId, ...st, tool, pointer: p.pointer };
        return;
      }
      case "fill":
        ctl.onFill(at);
        return;
      case "wand":
        ctl.onWand(at);
        return;
      case "points":
        ctl.onPoint(at, true);
        return;
      case "rect":
      case "ellipse":
      case "lasso":
        drag = { kind: "shape", id: e.pointerId, mode, start: at, points: [at] };
        return;
      case "transform":
        drag = { kind: "transform", id: e.pointerId, last: at };
        return;
      default:
        return;
    }
  };

  const move = (e: PointerEvent) => {
    ctl.onHover?.(local(e));
    if (e.pointerType === "touch" && touches.has(e.pointerId)) {
      const t = touches.get(e.pointerId);
      if (t) {
        t.x = e.clientX;
        t.y = e.clientY;
      }
      if (gesture && touches.size >= 2) {
        updateGesture();
        e.preventDefault();
        return;
      }
    }
    const d = drag;
    if (!d || d.id !== e.pointerId) return;
    if (d.kind === "pan") {
      const v = engine.view.get();
      engine.view.set({ panX: v.panX + (e.clientX - d.x), panY: v.panY + (e.clientY - d.y) });
      d.x = e.clientX;
      d.y = e.clientY;
    } else if (d.kind === "rotate") {
      const a = Math.atan2(e.clientY - d.cy, e.clientX - d.cx);
      engine.view.set({ rotation: d.r0 + ((a - d.a0) * 180) / Math.PI });
    } else if (d.kind === "stroke") {
      const co = (e.getCoalescedEvents?.() ?? []).filter((x) => x.pointerId === e.pointerId);
      const list = co.length ? co : [e];
      const pts = list.map((ev) => inputPoint(ev, d));
      const pred = (e.getPredictedEvents?.() ?? []).map((ev) => {
        const at = toCanvas(ev);
        return { x: at.x, y: at.y, pressure: d.pressure, tiltX: ev.tiltX || 0, tiltY: ev.tiltY || 0, twist: ev.twist || 0, t: Math.max(0, ev.timeStamp - d.t0), pointer: d.pointer } satisfies InputPoint;
      });
      engine.extendStroke(pts, pred);
    } else if (d.kind === "shape") {
      const at = toCanvas(e);
      if (d.mode === "lasso") {
        d.points.push(at);
        ctl.onOverlay({ kind: "lasso", points: [...d.points] });
      } else {
        const r = rectOf(d.start, at, e.shiftKey);
        ctl.onOverlay({ kind: d.mode, rect: r });
      }
    } else if (d.kind === "transform") {
      const at = toCanvas(e);
      ctl.onTransformDrag(at.x - d.last.x, at.y - d.last.y);
      d.last = at;
    }
  };

  const up = (e: PointerEvent) => {
    if (e.pointerType === "touch") {
      const t = touches.get(e.pointerId);
      if (t && gesture) {
        const n = touches.size;
        if (!gesture.moved && e.timeStamp - gesture.t0 < TAP_MS && Math.hypot(e.clientX - t.x0, e.clientY - t.y0) < TAP_SLOP) {
          if (gesture.max === 2 && n === 2) ctl.onTwoFingerTap();
          else if (gesture.max === 3 && n === 3) ctl.onThreeFingerTap();
          gesture.max = 0;
        }
      }
      touches.delete(e.pointerId);
      if (touches.size < 2) gesture = null;
    }
    const d = drag;
    if (!d || d.id !== e.pointerId) return;
    drag = null;
    if (d.kind === "stroke") {
      const result = engine.endStroke();
      lastEnd = { x: d.last.x, y: d.last.y, pressure: d.pressure, tiltX: 0, tiltY: 0, twist: 0, t: 0, pointer: d.pointer };
      ctl.onStrokeEnd(result, d.tool);
    } else if (d.kind === "shape") {
      ctl.onOverlay(null);
      const at = toCanvas(e);
      if (d.mode === "lasso") {
        if (d.points.length > 2) engine.selection.lasso(d.points, e.shiftKey ? "add" : "replace");
      } else {
        const r = rectOf(d.start, at, e.shiftKey);
        if (r.w > 1 && r.h > 1) d.mode === "rect" ? engine.selection.rect(r, e.shiftKey ? "add" : "replace") : engine.selection.ellipse(r, e.shiftKey ? "add" : "replace");
        else engine.selection.clear();
      }
    }
  };

  const cancel = (e: PointerEvent) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) gesture = null;
    if (drag?.id === e.pointerId) {
      if (drag.kind === "stroke") engine.cancelStroke();
      drag = null;
      ctl.onOverlay(null);
    }
  };

  function startGesture(t0: number) {
    const pts = [...touches.values()];
    const a = pts[0];
    const b = pts[1];
    if (!a || !b) return;
    const v = engine.view.get();
    gesture = { dist: Math.hypot(b.x - a.x, b.y - a.y) || 1, angle: Math.atan2(b.y - a.y, b.x - a.x), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, zoom: v.zoom, rot: v.rotation, moved: false, max: pts.length, t0 };
  }

  function updateGesture() {
    const g = gesture;
    const pts = [...touches.values()];
    const a = pts[0];
    const b = pts[1];
    if (!g || !a || !b) return;
    g.max = Math.max(g.max, pts.length);
    const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    if (Math.abs(dist - g.dist) > TAP_SLOP || Math.abs(cx - g.cx) > TAP_SLOP || Math.abs(cy - g.cy) > TAP_SLOP) g.moved = true;
    if (!g.moved) return;
    const r = canvas.getBoundingClientRect();
    const v = engine.view.get();
    engine.view.set({ zoom: Math.min(64, Math.max(0.02, g.zoom * (dist / g.dist))), rotation: g.rot + ((angle - g.angle) * 180) / Math.PI, panX: v.panX + (cx - g.cx), panY: v.panY + (cy - g.cy) });
    void r;
    g.cx = cx;
    g.cy = cy;
    g.zoom = engine.view.get().zoom;
    g.dist = dist;
    g.rot = engine.view.get().rotation;
    g.angle = angle;
  }

  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const s = local(e);
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0025), s);
    else {
      const v = engine.view.get();
      engine.view.set({ panX: v.panX - e.deltaX, panY: v.panY - e.deltaY });
    }
  };

  const keyDown = (e: KeyboardEvent) => {
    if (isEditableTarget(e.target)) return;
    if (e.key === " ") space = true;
    if (e.key.toLowerCase() === "r" && !e.ctrlKey && !e.metaKey) rotKey = true;
    if (e.key === "Alt") alt = true;
  };
  const keyUp = (e: KeyboardEvent) => {
    if (e.key === " ") space = false;
    if (e.key.toLowerCase() === "r") rotKey = false;
    if (e.key === "Alt") alt = false;
  };
  const blur = () => {
    space = rotKey = alt = false;
  };
  const leave = () => ctl.onHover?.(null);

  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", cancel);
  canvas.addEventListener("pointerleave", leave);
  canvas.addEventListener("wheel", wheel, { passive: false });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("keydown", keyDown);
  window.addEventListener("keyup", keyUp);
  window.addEventListener("blur", blur);
  return () => {
    canvas.removeEventListener("pointerdown", down);
    canvas.removeEventListener("pointermove", move);
    canvas.removeEventListener("pointerup", up);
    canvas.removeEventListener("pointercancel", cancel);
    canvas.removeEventListener("pointerleave", leave);
    canvas.removeEventListener("wheel", wheel);
    window.removeEventListener("keydown", keyDown);
    window.removeEventListener("keyup", keyUp);
    window.removeEventListener("blur", blur);
  };
}

function rectOf(a: Point, b: Point, square: boolean): Rect {
  let w = b.x - a.x;
  let h = b.y - a.y;
  if (square) {
    const m = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * m;
    h = Math.sign(h || 1) * m;
  }
  return { x: Math.min(a.x, a.x + w), y: Math.min(a.y, a.y + h), w: Math.abs(w), h: Math.abs(h) };
}
