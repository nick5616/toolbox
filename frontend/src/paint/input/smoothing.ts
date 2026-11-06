// Input smoothing (SPEC §1.2): motion filtering, stabilisation (pulled string)
// and StreamLine (lagged spring). All three step per input sample, never by
// wall time, so a replay gives the same path. The hot path allocates nothing.

import type { InputPoint } from "../engine/types";
import type { Smoothing } from "../brushes/schema";

/** A smoothed point. Mutable and reused by the stroke path. */
export interface Sample {
  x: number;
  y: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  twist: number;
  t: number;
  /** px per ms along the path (0 at the first sample). */
  speed: number;
}

export function newSample(): Sample {
  return { x: 0, y: 0, pressure: 0, tiltX: 0, tiltY: 0, twist: 0, t: 0, speed: 0 };
}

const MAX_WINDOW = 8;
const MAX_STRING = 60; // px of stabilisation at 1.0
const FLUSH_STEPS = 80;

export class Smoother {
  private readonly s: Smoothing;
  private n = 0;
  // Motion-filter ring.
  private readonly rx = new Float64Array(MAX_WINDOW);
  private readonly ry = new Float64Array(MAX_WINDOW);
  private readonly rp = new Float64Array(MAX_WINDOW);
  private ri = 0;
  private rc = 0;
  private mx = 0;
  private my = 0;
  // Stabiliser (the "brush" on the string).
  private bx = 0;
  private by = 0;
  // Streamline spring.
  private sx = 0;
  private sy = 0;
  private sp = 0;
  // Last raw sample, for attributes the filters don't touch.
  private last: InputPoint | null = null;
  private lastOutT = 0;
  private lastOutX = 0;
  private lastOutY = 0;
  private tx = 0;
  private ty = 0;
  private readonly out = newSample();

  constructor(s: Smoothing) {
    this.s = s;
  }

  /** The configured amounts. */
  get settings(): Smoothing {
    return this.s;
  }

  copyFrom(o: Smoother): void {
    this.n = o.n;
    this.rx.set(o.rx);
    this.ry.set(o.ry);
    this.rp.set(o.rp);
    this.ri = o.ri;
    this.rc = o.rc;
    this.mx = o.mx;
    this.my = o.my;
    this.bx = o.bx;
    this.by = o.by;
    this.sx = o.sx;
    this.sy = o.sy;
    this.sp = o.sp;
    this.last = o.last;
    this.lastOutT = o.lastOutT;
    this.lastOutX = o.lastOutX;
    this.lastOutY = o.lastOutY;
    this.tx = o.tx;
    this.ty = o.ty;
  }

  /** Feed one raw point; emit() is called with the smoothed sample (reused: copy what you keep). */
  push(p: InputPoint, emit: (s: Sample) => void): void {
    this.last = p;
    const mf = this.s.motionFilter;
    const win = 1 + Math.round(mf * (MAX_WINDOW - 1));
    // 1. motion filter: window average + dead zone.
    this.rx[this.ri] = p.x;
    this.ry[this.ri] = p.y;
    this.rp[this.ri] = p.pressure;
    this.ri = (this.ri + 1) % MAX_WINDOW;
    if (this.rc < MAX_WINDOW) this.rc++;
    const cnt = Math.min(win, this.rc);
    let ax = 0;
    let ay = 0;
    let ap = 0;
    for (let k = 1; k <= cnt; k++) {
      const idx = (this.ri - k + MAX_WINDOW) % MAX_WINDOW;
      ax += this.rx[idx] as number;
      ay += this.ry[idx] as number;
      ap += this.rp[idx] as number;
    }
    ax /= cnt;
    ay /= cnt;
    ap /= cnt;
    if (this.n > 0 && mf > 0) {
      const dd = Math.hypot(ax - this.mx, ay - this.my);
      if (dd < mf * 1.2) {
        ax = this.mx;
        ay = this.my;
      }
    }
    this.mx = ax;
    this.my = ay;
    this.tx = ax;
    this.ty = ay;
    // 2. stabilisation: the brush trails on a string of fixed length.
    const len = this.s.stabilisation * MAX_STRING;
    if (this.n === 0) {
      this.bx = ax;
      this.by = ay;
      this.sx = ax;
      this.sy = ay;
      this.sp = ap;
    } else {
      const dx = ax - this.bx;
      const dy = ay - this.by;
      const d = Math.hypot(dx, dy);
      if (d > len) {
        const k = (d - len) / d;
        this.bx += dx * k;
        this.by += dy * k;
      }
      // 3. streamline: a lagged spring toward the string end.
      const f = 1 - this.s.streamline * 0.88;
      this.sx += (this.bx - this.sx) * f;
      this.sy += (this.by - this.sy) * f;
      this.sp += (ap - this.sp) * Math.max(0.35, f);
    }
    this.n++;
    this.emitSample(p, emit);
  }

  /** The stroke ended: let the lag catch up so the line reaches where the pen lifted. */
  flush(emit: (s: Sample) => void): void {
    const p = this.last;
    if (!p || this.n === 0) return;
    this.bx = this.tx;
    this.by = this.ty;
    const f = 1 - this.s.streamline * 0.88;
    for (let i = 0; i < FLUSH_STEPS; i++) {
      if (Math.hypot(this.bx - this.sx, this.by - this.sy) < 0.25) break;
      this.sx += (this.bx - this.sx) * f;
      this.sy += (this.by - this.sy) * f;
      this.emitSample(p, emit, true);
    }
  }

  private emitSample(p: InputPoint, emit: (s: Sample) => void, flushing = false): void {
    const o = this.out;
    o.x = this.sx;
    o.y = this.sy;
    o.pressure = this.sp;
    o.tiltX = p.tiltX;
    o.tiltY = p.tiltY;
    o.twist = p.twist;
    o.t = p.t;
    if (this.n <= 1) {
      o.speed = 0;
    } else {
      const dt = flushing ? 8 : Math.max(1, p.t - this.lastOutT);
      o.speed = Math.hypot(o.x - this.lastOutX, o.y - this.lastOutY) / dt;
    }
    this.lastOutT = p.t;
    this.lastOutX = o.x;
    this.lastOutY = o.y;
    emit(o);
  }
}
