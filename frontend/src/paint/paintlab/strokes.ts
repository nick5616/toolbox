// The recorded strokes PaintLab replays: closed-form paths (no randomness) at
// a synthetic 120 Hz, so every run feeds the engine identical input.

import type { InputPoint } from "../engine/types";

export const HZ = 120;
const DT = 1000 / HZ;

function mk(x: number, y: number, i: number, pressure: number, tiltX = 0, tiltY = 0): InputPoint {
  return { x, y, pressure, tiltX, tiltY, twist: 0, t: i * DT, pointer: "pen" };
}

/** An S-curve across (x0..x1) with pressure rising, then falling; `speed` px per event. */
export function waveStroke(x0: number, x1: number, cy: number, amp: number, speed = 3): InputPoint[] {
  const n = Math.max(2, Math.round((x1 - x0) / speed));
  const out: InputPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const p = Math.sin(Math.PI * u) ** 0.8;
    out.push(mk(x0 + (x1 - x0) * u, cy + Math.sin(u * Math.PI * 2) * amp, i, 0.08 + 0.92 * p, 25 * Math.sin(u * 6), 15 * Math.cos(u * 4)));
  }
  return out;
}

/** A loop (circle) of radius r. */
export function loopStroke(cx: number, cy: number, r: number, speed = 3): InputPoint[] {
  const n = Math.max(12, Math.round((2 * Math.PI * r) / speed));
  const out: InputPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    out.push(mk(cx + Math.cos(a) * r, cy + Math.sin(a) * r, i, 0.35 + 0.6 * Math.abs(Math.sin(a)), 30 * Math.cos(a), 30 * Math.sin(a)));
  }
  return out;
}

/** A long zig-zag for the frame-time probe: `events` points over the canvas. */
export function probeStroke(w: number, h: number, events: number): InputPoint[] {
  const out: InputPoint[] = [];
  for (let i = 0; i < events; i++) {
    const u = i / (events - 1);
    const x = 80 + (w - 160) * u;
    const y = h / 2 + Math.sin(u * Math.PI * 14) * h * 0.35;
    out.push(mk(x, y, i, 0.3 + 0.7 * Math.abs(Math.sin(u * Math.PI * 9)), 20 * Math.sin(u * 20), 10 * Math.cos(u * 11)));
  }
  return out;
}

/** A straight line with linearly changing pressure; tilt is constant. `speed` is px per event. */
export function lineStroke(x0: number, x1: number, y: number, p0: number, p1: number, speed = 3, tiltX = 0, tiltY = 0): InputPoint[] {
  const n = Math.max(2, Math.round(Math.abs(x1 - x0) / speed));
  const out: InputPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    out.push(mk(x0 + (x1 - x0) * u, y, i, p0 + (p1 - p0) * u, tiltX, tiltY));
  }
  return out;
}

/** A vertical line (used to pre-paint stripes for smudge brushes). */
export function vlineStroke(x: number, y0: number, y1: number, speed = 4): InputPoint[] {
  const n = Math.max(2, Math.round(Math.abs(y1 - y0) / speed));
  const out: InputPoint[] = [];
  for (let i = 0; i <= n; i++) out.push(mk(x, y0 + ((y1 - y0) * i) / n, i, 0.8));
  return out;
}
