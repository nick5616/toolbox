// QuickShape: the host detects a hold at the end of a stroke, asks
// detectShape() what the freehand path was trying to be, and re-strokes the
// snapped path (engine.restroke). The result is a plain Shape with handles, so
// the host can edit it and re-stroke again.

import type { InputPoint, Point } from "../engine/types";

export type Shape =
  | { kind: "line"; a: Point; b: Point }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number; rotation: number }
  | { kind: "rect"; cx: number; cy: number; w: number; h: number; rotation: number }
  | { kind: "polygon"; points: Point[] };

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function pathLength(p: Point[]): number {
  let n = 0;
  for (let i = 1; i < p.length; i++) n += dist(p[i - 1] as Point, p[i] as Point);
  return n;
}

function perpDist(p: Point, a: Point, b: Point): number {
  const l = dist(a, b);
  if (l < 1e-9) return dist(p, a);
  return Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / l;
}

/** Ramer–Douglas–Peucker on an open polyline. */
export function simplify(pts: Point[], eps: number): Point[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop() as [number, number];
    let mx = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist(pts[i] as Point, pts[s] as Point, pts[e] as Point);
      if (d > mx) {
        mx = d;
        idx = i;
      }
    }
    if (idx >= 0 && mx > eps) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function fitEllipse(pts: Point[]): { cx: number; cy: number; rx: number; ry: number; rotation: number; err: number } {
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    sxx += (p.x - cx) ** 2;
    sxy += (p.x - cx) * (p.y - cy);
    syy += (p.y - cy) ** 2;
  }
  const rot = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  let mu = 0;
  let mv = 0;
  for (const p of pts) {
    mu = Math.max(mu, Math.abs((p.x - cx) * cs + (p.y - cy) * sn));
    mv = Math.max(mv, Math.abs(-(p.x - cx) * sn + (p.y - cy) * cs));
  }
  // Radii from the second moments (a uniform ring has variance r²/2 along each axis).
  let su = 0;
  let sv = 0;
  for (const p of pts) {
    su += ((p.x - cx) * cs + (p.y - cy) * sn) ** 2;
    sv += (-(p.x - cx) * sn + (p.y - cy) * cs) ** 2;
  }
  const rx = Math.sqrt((2 * su) / pts.length);
  const ry = Math.sqrt((2 * sv) / pts.length);
  let err = 0;
  for (const p of pts) {
    const u = ((p.x - cx) * cs + (p.y - cy) * sn) / Math.max(1e-6, rx);
    const v = (-(p.x - cx) * sn + (p.y - cy) * cs) / Math.max(1e-6, ry);
    err += Math.abs(Math.hypot(u, v) - 1);
  }
  return { cx, cy, rx, ry, rotation: rot, err: err / pts.length };
}

/** What the freehand path was trying to draw, or null if it isn't clearly a shape. */
export function detectShape(points: Point[]): Shape | null {
  if (points.length < 3) return null;
  const len = pathLength(points);
  if (len < 12) return null;
  const first = points[0] as Point;
  const last = points[points.length - 1] as Point;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  const diag = Math.hypot(x1 - x0, y1 - y0);
  const closed = dist(first, last) < Math.max(10, diag * 0.28) && len > diag * 1.6;
  if (!closed) {
    const dev = points.reduce((m, p) => Math.max(m, perpDist(p, first, last)), 0);
    return dev < Math.max(2.5, dist(first, last) * 0.07) ? { kind: "line", a: { ...first }, b: { ...last } } : null;
  }
  const open = points.slice(0, -1);
  const poly = simplify([...open, first], diag * 0.045).slice(0, -1);
  if (poly.length >= 3 && poly.length <= 8) {
    if (poly.length === 4) {
      const [a, b, c, d] = poly as [Point, Point, Point, Point];
      const ab = Math.atan2(b.y - a.y, b.x - a.x);
      const bc = Math.atan2(c.y - b.y, c.x - b.x);
      let turn = Math.abs(((bc - ab + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      turn = Math.abs(turn - Math.PI / 2);
      const par = Math.abs(dist(a, b) - dist(c, d)) < Math.max(dist(a, b), dist(b, c)) * 0.25 && Math.abs(dist(b, c) - dist(d, a)) < Math.max(dist(a, b), dist(b, c)) * 0.25;
      if (turn < 0.3 && par) {
        const cx = (a.x + b.x + c.x + d.x) / 4;
        const cy = (a.y + b.y + c.y + d.y) / 4;
        return { kind: "rect", cx, cy, w: (dist(a, b) + dist(c, d)) / 2, h: (dist(b, c) + dist(d, a)) / 2, rotation: ab };
      }
    }
    // A ring with few simplified vertices may still be a round shape: prefer the ellipse when it fits.
    const e = fitEllipse(open);
    if (poly.length > 4 && e.err < 0.1) return { kind: "ellipse", cx: e.cx, cy: e.cy, rx: e.rx, ry: e.ry, rotation: e.rotation };
    return { kind: "polygon", points: poly.map((p) => ({ ...p })) };
  }
  const e = fitEllipse(open);
  if (e.err < 0.18) return { kind: "ellipse", cx: e.cx, cy: e.cy, rx: e.rx, ry: e.ry, rotation: e.rotation };
  return null;
}

/** The shape's outline as a dense polyline (closed shapes end where they start). */
export function shapePath(s: Shape, step = 2): Point[] {
  const dense = (pts: Point[], close: boolean): Point[] => {
    const out: Point[] = [];
    const n = close ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i] as Point;
      const b = pts[(i + 1) % pts.length] as Point;
      const k = Math.max(1, Math.ceil(dist(a, b) / step));
      for (let j = 0; j < k; j++) out.push({ x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k });
    }
    out.push({ ...((close ? pts[0] : pts[pts.length - 1]) as Point) });
    return out;
  };
  switch (s.kind) {
    case "line":
      return dense([s.a, s.b], false);
    case "polygon":
      return dense(s.points, true);
    case "rect": {
      const cs = Math.cos(s.rotation);
      const sn = Math.sin(s.rotation);
      const c = (u: number, v: number): Point => ({ x: s.cx + u * cs - v * sn, y: s.cy + u * sn + v * cs });
      return dense([c(-s.w / 2, -s.h / 2), c(s.w / 2, -s.h / 2), c(s.w / 2, s.h / 2), c(-s.w / 2, s.h / 2)], true);
    }
    case "ellipse": {
      const cs = Math.cos(s.rotation);
      const sn = Math.sin(s.rotation);
      const per = Math.PI * (3 * (s.rx + s.ry) - Math.sqrt((3 * s.rx + s.ry) * (s.rx + 3 * s.ry)));
      const n = Math.max(24, Math.ceil(per / step));
      const out: Point[] = [];
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        const u = Math.cos(a) * s.rx;
        const v = Math.sin(a) * s.ry;
        out.push({ x: s.cx + u * cs - v * sn, y: s.cy + u * sn + v * cs });
      }
      return out;
    }
  }
}

/** The shape as engine input points (constant pressure, 8 ms apart). */
export function shapeInputPoints(s: Shape, pressure = 1, step = 2): InputPoint[] {
  return shapePath(s, step).map((p, i) => ({ x: p.x, y: p.y, pressure, tiltX: 0, tiltY: 0, twist: 0, t: i * 8, pointer: "pen" as const }));
}

/** Editing handles: line ends, polygon/rect vertices, ellipse centre + four axis ends. */
export function shapeHandles(s: Shape): Point[] {
  switch (s.kind) {
    case "line":
      return [s.a, s.b];
    case "polygon":
      return s.points;
    case "rect": {
      const p = shapePath(s, 1e9);
      return p.slice(0, 4);
    }
    case "ellipse": {
      const cs = Math.cos(s.rotation);
      const sn = Math.sin(s.rotation);
      return [
        { x: s.cx, y: s.cy },
        { x: s.cx + s.rx * cs, y: s.cy + s.rx * sn },
        { x: s.cx - s.ry * sn, y: s.cy + s.ry * cs },
        { x: s.cx - s.rx * cs, y: s.cy - s.rx * sn },
        { x: s.cx + s.ry * sn, y: s.cy - s.ry * cs },
      ];
    }
  }
}

/** Drag handle i to p. Dragging a rectangle corner turns it into a polygon. */
export function moveHandle(s: Shape, i: number, p: Point): Shape {
  switch (s.kind) {
    case "line":
      return i === 0 ? { ...s, a: { ...p } } : { ...s, b: { ...p } };
    case "polygon":
      return { kind: "polygon", points: s.points.map((q, k) => (k === i ? { ...p } : q)) };
    case "rect": {
      const pts = shapeHandles(s).map((q, k) => (k === i ? { ...p } : q));
      return { kind: "polygon", points: pts };
    }
    case "ellipse": {
      if (i === 0) return { ...s, cx: p.x, cy: p.y };
      const cs = Math.cos(s.rotation);
      const sn = Math.sin(s.rotation);
      const dx = p.x - s.cx;
      const dy = p.y - s.cy;
      const u = Math.abs(dx * cs + dy * sn);
      const v = Math.abs(-dx * sn + dy * cs);
      return i === 1 || i === 3 ? { ...s, rx: Math.max(1, u) } : { ...s, ry: Math.max(1, v) };
    }
  }
}
