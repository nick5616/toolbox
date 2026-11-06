// Generates the bundled brush tips and grains (Phase 19, SPEC 1.3.1).
//
//   cd frontend && npm run brushgen
//
// Runs in plain Node (type stripping, no browser, no dependencies) and writes
// PNGs into src/paint/brushes/library/{tips,grains}/ plus library/manifest.json.
// Everything is procedural and seeded, so the output is reproducible byte for
// byte and the licence is ours.
//
// Conventions (also documented in library/index.ts):
//  - Tips are grayscale+alpha PNGs, luminance = alpha = coverage, white = paint.
//    Elongated tips point RIGHT (+x), the direction of travel, unless their
//    name says otherwise (grass, flame, rain and flat are drawn upright).
//  - Grains are opaque grayscale, 512 px, seamlessly tileable; bright = paint
//    passes, dark = the paper's pits.
import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "src", "paint", "brushes", "library");

// ---------- PNG ----------
function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/** channels 1 = gray, 2 = gray+alpha; 8-bit; rows use the Sub filter. */
function encodePng(w: number, h: number, channels: 1 | 2, px: Uint8Array): Buffer {
  const stride = w * channels;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 1;
    for (let i = 0; i < stride; i++) {
      const cur = px[y * stride + i] ?? 0;
      const left = i >= channels ? (px[y * stride + i - channels] ?? 0) : 0;
      raw[y * (stride + 1) + 1 + i] = (cur - left) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : 4;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

// ---------- maths ----------
const clamp = (v: number, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Value noise on a lattice that wraps at (px, py) cells, so it tiles. */
function vnoise(x: number, y: number, px: number, py: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(mod(x0, px), mod(y0, py), seed);
  const b = hash2(mod(x0 + 1, px), mod(y0, py), seed);
  const c = hash2(mod(x0, px), mod(y0 + 1, py), seed);
  const d = hash2(mod(x0 + 1, px), mod(y0 + 1, py), seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** fBm over u,v in 0..1 that tiles when the periods are integers. */
function fbm(u: number, v: number, period: number, oct: number, seed: number, px = 1, py = 1): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let fx = period * px;
  let fy = period * py;
  for (let o = 0; o < oct; o++) {
    sum += amp * vnoise(u * fx, v * fy, fx, fy, seed + o * 31);
    norm += amp;
    amp *= 0.5;
    fx *= 2;
    fy *= 2;
  }
  return sum / norm;
}

// ---------- tips ----------
type Mask = (x: number, y: number) => number; // x,y in -1..1 (y down) -> coverage 0..1

function renderTip(n: number, fn: Mask): Uint8Array {
  const out = new Uint8Array(n * n * 2);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) / n) * 2 - 1;
      const y = ((j + 0.5) / n) * 2 - 1;
      const v = Math.round(clamp(fn(x, y)) * 255);
      const o = (j * n + i) * 2;
      out[o] = v;
      out[o + 1] = v;
    }
  }
  return out;
}

/** Anti-aliased coverage from a signed distance (negative inside), for an n px tip. */
const aaFor = (n: number) => {
  const px = 2 / n;
  return (d: number) => clamp(0.5 - d / px);
};

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): [number, number] {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1));
  return [Math.hypot(px - ax - dx * t, py - ay - dy * t), t];
}

interface TipDef {
  name: string;
  size: number;
  draw: (n: number) => Mask;
}

const TIPS: TipDef[] = [];
const tip = (name: string, size: number, draw: (n: number) => Mask) => TIPS.push({ name, size, draw });

tip("soft-round", 256, () => (x, y) => {
  const r = Math.hypot(x, y);
  const t = clamp(1 - r / 0.98);
  return t * t * (3 - 2 * t) * (0.6 + 0.4 * t);
});

tip("hard-round", 256, (n) => {
  const aa = aaFor(n);
  return (x, y) => aa(Math.hypot(x, y) - 0.96);
});

tip("square", 256, (n) => {
  const aa = aaFor(n);
  return (x, y) => aa(Math.max(Math.abs(x), Math.abs(y)) - 0.94);
});

tip("chalk", 256, () => (x, y) => {
  const u = x * 0.5 + 0.5;
  const v = y * 0.5 + 0.5;
  const r = Math.hypot(x, y) + (fbm(u, v, 5, 4, 11) - 0.5) * 0.45;
  const body = 1 - smooth(0.62, 0.9, r);
  const speck = fbm(u, v, 60, 2, 12);
  return body * smooth(0.28, 0.5, speck + 0.18 * (1 - r));
});

tip("charcoal", 256, () => (x, y) => {
  const u = x * 0.5 + 0.5;
  const v = y * 0.5 + 0.5;
  const r = Math.hypot(x * 0.95, y) + (fbm(u, v, 4, 4, 21) - 0.5) * 0.55;
  const body = 1 - smooth(0.55, 0.9, r);
  const streak = fbm(u, v, 3, 3, 22, 1, 14) * 0.65 + fbm(u, v, 48, 1, 23) * 0.35;
  return body * smooth(0.3, 0.55, streak);
});

tip("pencil-grain", 128, () => (x, y) => {
  const u = x * 0.5 + 0.5;
  const v = y * 0.5 + 0.5;
  const r = Math.hypot(x, y);
  const body = 1 - smooth(0.35, 0.95, r);
  const g = hash2(Math.floor(u * 128), Math.floor(v * 128), 31) * 0.6 + fbm(u, v, 40, 2, 32) * 0.4;
  return body * smooth(0.2, 0.55, g + body * 0.25);
});

tip("bristle", 256, () => {
  const strands = Array.from({ length: 28 }, (_, i) => mulberry32(41 + i)());
  return (x, y) => {
    const r = Math.hypot(x, y);
    const disc = 1 - smooth(0.82, 0.98, r);
    const col = clamp(Math.floor(((x + 1) / 2) * 28), 0, 27);
    const a = 0.35 + 0.65 * (strands[col] ?? 0.5);
    const wob = vnoise(y * 6 + col * 3.1, col * 1.7, 1000, 1000, 42);
    const edge = smooth(0, 0.18, 1 - Math.abs(((x + 1) / 2) * 28 - col - 0.5) * 2 + 0.05);
    return disc * a * (0.6 + 0.4 * wob) * edge;
  };
});

// Upright: wide across y, narrow along x, streaks run with the stroke (x).
tip("flat", 256, (n) => {
  const aa = aaFor(n);
  return (x, y) => {
    const d = Math.max(Math.abs(x) - 0.32, Math.abs(y) - 0.94);
    const band = vnoise(((y + 1) / 2) * 46, 0.5, 1000, 1000, 51);
    const along = vnoise(((x + 1) / 2) * 6, ((y + 1) / 2) * 46, 1000, 1000, 52);
    return aa(d) * (0.55 + 0.3 * band + 0.15 * along);
  };
});

function dots(name: string, count: number, rMin: number, rMax: number, seed: number, soft = 0) {
  tip(name, 256, (n) => {
    const rnd = mulberry32(seed);
    const ds = Array.from({ length: count }, () => {
      const a = rnd() * Math.PI * 2;
      const rr = Math.sqrt(rnd()) * 0.88;
      return { x: Math.cos(a) * rr, y: Math.sin(a) * rr, r: rMin + (rMax - rMin) * rnd() ** 2 };
    });
    const aa = aaFor(n);
    return (x, y) => {
      let v = 0;
      for (const d of ds) {
        const dist = Math.hypot(x - d.x, y - d.y) - d.r;
        v = Math.max(v, soft ? clamp(1 - (dist + d.r) / (d.r * (1 + soft))) : aa(dist));
      }
      return v;
    };
  });
}
dots("spatter", 46, 0.02, 0.15, 61);
dots("stipple", 150, 0.022, 0.05, 62);
dots("snow", 18, 0.05, 0.16, 63, 1.2);

tip("sponge", 256, () => (x, y) => {
  const u = x * 0.5 + 0.5;
  const v = y * 0.5 + 0.5;
  const r = Math.hypot(x, y) + (fbm(u, v, 6, 3, 71) - 0.5) * 0.3;
  const body = 1 - smooth(0.7, 0.95, r);
  const holes = fbm(u, v, 7, 3, 72) * 0.7 + fbm(u, v, 22, 2, 73) * 0.3;
  return body * smooth(0.4, 0.52, holes);
});

// Leaves: stem at -x, tip at +x.
function leaf(name: string, halfWidth: (t: number) => number, curve: (t: number) => number, veins: number) {
  tip(name, 256, (n) => {
    const aa = aaFor(n);
    return (x, y) => {
      const t = (x + 0.92) / 1.84;
      const yy = y - curve(t);
      let v = 0;
      if (t >= 0 && t <= 1) {
        const w = halfWidth(t);
        v = aa((Math.abs(yy) - w) * 0.85);
        let vein = aa(Math.abs(yy) - 0.014);
        for (let k = 1; k <= veins; k++) {
          const tk = 0.12 + (0.7 * k) / (veins + 1);
          const ax = tk * 1.84 - 0.92;
          const wk = halfWidth(tk + 0.2);
          for (const s of [-1, 1]) {
            const [d] = segDist(x, yy, ax, 0, ax + 0.72 * wk, s * wk * 0.95);
            vein = Math.max(vein, aa(d - 0.008) * 0.8);
          }
        }
        v *= clamp(0.82 + 0.12 * (1 - Math.abs(yy) / (w + 1e-3)) - vein * 0.32);
      }
      const [sd] = segDist(x, yy, -0.98, 0, -0.9, 0);
      return Math.max(v, aa(sd - 0.022) * 0.9);
    };
  });
}
leaf("leaf-oak", (t) => 0.52 * Math.sin(Math.PI * Math.pow(t, 0.85)) * (0.68 + 0.32 * Math.cos(2 * Math.PI * 3.5 * t + 0.6)), () => 0, 5);
leaf("leaf-round", (t) => 0.5 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.78)), 0.75) * (1 - 0.15 * t), (t) => 0.03 * Math.sin(Math.PI * t), 4);
leaf("leaf-willow", (t) => 0.1 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 0.9), (t) => 0.14 * Math.sin(Math.PI * t) - 0.04, 0);

tip("leaf-maple", 256, (n) => {
  const aa = aaFor(n);
  const lobes: Array<[number, number, number]> = [
    [0, 0.7, 14],
    [0.95, 0.62, 12],
    [-0.95, 0.62, 12],
    [2.0, 0.4, 14],
    [-2.0, 0.4, 14],
  ];
  return (x, y) => {
    const cx = -0.12;
    const th = Math.atan2(y, x - cx);
    const r = Math.hypot(y, x - cx);
    let f = 0.12;
    for (const [a, amp, p] of lobes) f += amp * Math.pow(Math.max(0, Math.cos(th - a)), p);
    f *= 1 + 0.05 * Math.cos(th * 21);
    let v = aa((r - f) * 0.8);
    let vein = 0;
    for (const [a] of lobes) {
      const [d] = segDist(x, y, cx, 0, cx + Math.cos(a) * 0.6, Math.sin(a) * 0.6);
      vein = Math.max(vein, aa(d - 0.012));
    }
    v *= 0.88 - vein * 0.3;
    const [sd] = segDist(x, y, -0.95, 0, cx, 0);
    return Math.max(v, aa(sd - 0.025) * 0.9);
  };
});

// Upright: base at the bottom, tip curling up and right.
tip("grass-blade", 256, (n) => {
  const aa = aaFor(n);
  return (x, y) => {
    const t = (0.96 - y) / 1.92;
    if (t < 0 || t > 1) return 0;
    const cx = 0.28 * t * t - 0.05;
    const w = 0.11 * Math.pow(1 - t, 0.85) + 0.004;
    const d = (Math.abs(x - cx) - w) * 0.9;
    return aa(d) * (0.8 + 0.2 * smooth(0, 0.9, 1 - Math.abs(x - cx) / w));
  };
});

tip("fern-frond", 256, (n) => {
  const aa = aaFor(n);
  const N = 14;
  return (x, y) => {
    const spineY = 0.06 * Math.sin((x + 0.9) * 1.6);
    let v = aa(Math.abs(y - spineY) - 0.012);
    for (let k = 0; k < N; k++) {
      const t = k / N;
      const ax = -0.82 + t * 1.6;
      const ay = 0.06 * Math.sin((ax + 0.9) * 1.6);
      const L = 0.04 + 0.4 * Math.pow(1 - t, 0.75) * Math.min(1, t * 6 + 0.25);
      for (const s of [-1, 1]) {
        const [dd, tt] = segDist(x, y, ax, ay, ax + L * 0.55, ay + s * L);
        v = Math.max(v, aa(dd - 0.032 * (1 - tt * 0.8)) * 0.92);
      }
    }
    return v;
  };
});

tip("pine-needle", 256, (n) => {
  const aa = aaFor(n);
  return (x, y) => {
    let v = 0;
    for (const s of [-1, 0.45]) {
      const [d, t] = segDist(x, y, -0.9, s * 0.02, 0.92, s * 0.2);
      v = Math.max(v, aa(d - 0.03 * (1 - t * 0.85)));
    }
    const [dc] = segDist(x, y, -0.95, 0, -0.84, 0);
    return Math.max(v, aa(dc - 0.045));
  };
});

tip("petal", 256, (n) => {
  const aa = aaFor(n);
  return (x, y) => {
    const ex = (x - 0.05) / 0.88;
    const ey = y / 0.58;
    const k = 1 + 0.35 * (x < 0 ? -x : 0);
    const ell = (Math.hypot(ex, ey * k) - 1) * 0.55;
    const notch = Math.hypot(x - 0.95, y) - 0.2;
    const d = Math.max(ell, -notch);
    const t = (x + 0.9) / 1.8;
    return aa(d) * (0.7 + 0.3 * (1 - smooth(0, 1, t)) + 0.08 * Math.cos(y * 12));
  };
});

tip("cloud-puff", 256, () => {
  const rnd = mulberry32(91);
  const blobs = Array.from({ length: 11 }, () => {
    const a = rnd() * Math.PI * 2;
    const rr = Math.sqrt(rnd()) * 0.45;
    return { x: Math.cos(a) * rr, y: Math.sin(a) * rr * 0.8, r: 0.2 + 0.2 * rnd() };
  });
  return (x, y) => {
    let v = 0;
    for (const b of blobs) v = Math.max(v, clamp(1 - Math.hypot(x - b.x, y - b.y) / b.r) ** 0.8);
    const tex = fbm(x * 0.5 + 0.5, y * 0.5 + 0.5, 6, 4, 92);
    return v * (0.55 + 0.6 * tex) * (1 - smooth(0.75, 0.98, Math.hypot(x, y)));
  };
});

tip("smoke", 256, () => (x, y) => {
  const u = x * 0.5 + 0.5;
  const v = y * 0.5 + 0.5;
  const r = Math.hypot(x, y);
  const t = fbm(u, v, 3, 5, 93);
  return clamp(1 - r / 0.95) ** 1.2 * smooth(0.25, 0.7, t + 0.25);
});

tip("star", 256, (n) => {
  const aa = aaFor(n);
  return (x, y) => {
    const th = Math.atan2(y, x) - Math.PI / 2;
    const r = Math.hypot(x, y);
    const f = 0.95 * (0.2 + 0.8 * Math.pow(Math.abs(Math.cos((5 * th) / 2)), 9));
    return Math.max(aa((r - f) * 0.7), 0.3 * clamp(1 - r / 0.95) ** 2);
  };
});

tip("sparkle", 256, () => (x, y) => {
  const r = Math.hypot(x, y);
  const cross = Math.exp(-Math.abs(x) * 28) * (1 - Math.abs(y)) ** 2 + Math.exp(-Math.abs(y) * 28) * (1 - Math.abs(x)) ** 2;
  return clamp(cross + 0.9 * Math.exp(-r * 9));
});

tip("flare", 256, () => (x, y) => {
  const r = Math.hypot(x, y);
  const core = Math.exp(-r * 8) * 1.1;
  const streak = Math.exp(-Math.abs(y) * 45) * (1 - Math.abs(x)) ** 1.5 * 0.7;
  const vert = Math.exp(-Math.abs(x) * 70) * (1 - Math.abs(y)) ** 2 * 0.35;
  const ring = Math.exp(-(((r - 0.68) / 0.025) ** 2)) * 0.4;
  return clamp(core + streak + vert + ring) * (1 - smooth(0.9, 1, r));
});

tip("pixel-square", 16, () => () => 1);

tip("dither-checker", 16, (n) => (x, y) => {
  const i = Math.floor(((x + 1) / 2) * n);
  const j = Math.floor(((y + 1) / 2) * n);
  return (i + j) % 2 === 0 ? 1 : 0;
});

tip("twig", 256, (n) => {
  const aa = aaFor(n);
  const rnd = mulberry32(95);
  const nubs = Array.from({ length: 7 }, (_, i) => ({ t: 0.12 + i * 0.12 + rnd() * 0.05, s: i % 2 ? 1 : -1, l: 0.15 + 0.2 * rnd() }));
  const spineY = (x: number) => 0.06 * Math.sin(x * 4.2) + 0.03 * Math.sin(x * 11 + 1);
  return (x, y) => {
    const t = (x + 0.95) / 1.9;
    let v = t < 0 || t > 1 ? 0 : aa(Math.abs(y - spineY(x)) - 0.035 * (1 - t * 0.85));
    for (const nb of nubs) {
      const ax = nb.t * 1.9 - 0.95;
      const ay = spineY(ax);
      const [d, tt] = segDist(x, y, ax, ay, ax + nb.l * 0.7, ay + nb.s * nb.l);
      v = Math.max(v, aa(d - 0.018 * (1 - tt * 0.9)));
    }
    return v;
  };
});

tip("bubbles", 256, (n) => {
  const rnd = mulberry32(96);
  const aa = aaFor(n);
  const bs = Array.from({ length: 12 }, () => {
    const a = rnd() * Math.PI * 2;
    const rr = Math.sqrt(rnd()) * 0.7;
    return { x: Math.cos(a) * rr, y: Math.sin(a) * rr, r: 0.08 + 0.2 * rnd() ** 1.5 };
  });
  return (x, y) => {
    let v = 0;
    for (const b of bs) {
      const d = Math.hypot(x - b.x, y - b.y);
      v = Math.max(v, aa(Math.abs(d - b.r) - 0.014) * 0.9, clamp(1 - d / b.r) * 0.22);
      v = Math.max(v, aa(Math.hypot(x - b.x + b.r * 0.4, y - b.y + b.r * 0.4) - b.r * 0.15) * 0.8);
    }
    return v;
  };
});

// Upright streak (rain).
tip("streak", 256, () => (x, y) => {
  const ax = Math.exp(-((x / 0.05) ** 2));
  return ax * smooth(0, 0.35, 1 - Math.abs(y)) * (0.4 + 0.6 * smooth(-1, 0.6, y));
});

// Upright, wavy.
tip("flame", 256, () => (x, y) => {
  const t = (0.95 - y) / 1.9;
  if (t < 0 || t > 1) return 0;
  const wob = 0.12 * Math.sin(t * 7 + 0.5) * t;
  const w = 0.55 * Math.pow(Math.sin(Math.PI * Math.pow(1 - t, 0.9)), 0.8) * (1 - t) ** 0.5;
  const d = Math.abs(x - wob) / (w + 1e-3);
  const tex = fbm(x * 0.5 + 0.5, y * 0.5 + 0.5, 4, 3, 97);
  return clamp(1 - d) ** 0.9 * (0.7 + 0.5 * tex);
});

tip("fibre", 256, (n) => {
  const rnd = mulberry32(98);
  const aa = aaFor(n);
  const fs = Array.from({ length: 22 }, () => ({ x: rnd() * 1.6 - 0.8, y: rnd() * 1.6 - 0.8, a: rnd() * Math.PI, l: 0.2 + 0.4 * rnd(), c: (rnd() - 0.5) * 0.6 }));
  return (x, y) => {
    let v = 0;
    for (const f of fs) {
      const cx = Math.cos(f.a);
      const sy = Math.sin(f.a);
      const mx = f.x + cx * f.l * 0.5 - sy * f.c;
      const my = f.y + sy * f.l * 0.5 + cx * f.c;
      const [d1] = segDist(x, y, f.x, f.y, mx, my);
      const [d2] = segDist(x, y, mx, my, f.x + cx * f.l, f.y + sy * f.l);
      v = Math.max(v, aa(Math.min(d1, d2) - 0.011) * 0.85);
    }
    return v;
  };
});

// ---------- grains (512 px, tileable) ----------
const G = 512;
type GrainFn = (u: number, v: number, i: number, j: number) => number;
const GRAINS: Array<{ name: string; fn: GrainFn }> = [];
const grain = (name: string, fn: GrainFn) => GRAINS.push({ name, fn });

grain("paper", (u, v, i, j) => {
  const fine = fbm(u, v, 64, 2, 101);
  const mid = fbm(u, v, 16, 3, 102);
  const fibre = Math.max(0, fbm(u, v, 8, 1, 103, 12, 1) - 0.62) * 1.5;
  return 0.74 + (fine - 0.5) * 0.35 + (mid - 0.5) * 0.28 + fibre * 0.2 + (hash2(i, j, 104) - 0.5) * 0.08;
});

grain("canvas-weave", (u, v, i, j) => {
  const cell = 16;
  const h = 0.5 + 0.5 * Math.cos((2 * Math.PI * i) / cell);
  const w = 0.5 + 0.5 * Math.cos((2 * Math.PI * j) / cell);
  const over = (Math.floor(i / cell) + Math.floor(j / cell)) % 2 === 0;
  const wob = fbm(u, v, 32, 2, 111);
  return 0.5 + (over ? h : w) * 0.38 + (wob - 0.5) * 0.25 - (over ? 0 : 0.04);
});

grain("rough", (u, v) => {
  const a = fbm(u, v, 12, 5, 121);
  return clamp(0.5 + (a - 0.5) * 1.7 + (fbm(u, v, 96, 1, 122) - 0.5) * 0.3);
});

grain("noise", (_u, _v, i, j) => {
  const a = hash2(i, j, 131) + hash2(i + 1, j, 132) * 0.5 + hash2(i, j + 1, 133) * 0.5;
  return clamp(0.5 + (a / 2 - 0.5) * 1.6);
});

grain("linen", (u, v) => {
  const hor = fbm(u, v, 1, 2, 141, 2, 160);
  const ver = fbm(u, v, 1, 2, 142, 160, 2);
  const slub = fbm(u, v, 10, 3, 143);
  return 0.62 + (hor - 0.5) * 0.4 + (ver - 0.5) * 0.4 + (slub - 0.5) * 0.25;
});

grain("watercolour-bloom", (u, v) => {
  const a = fbm(u, v, 3, 5, 151);
  const ring = Math.exp(-(((a - 0.5) / 0.045) ** 2));
  const ring2 = Math.exp(-(((a - 0.38) / 0.03) ** 2));
  return 0.82 - ring * 0.4 - ring2 * 0.22 + (fbm(u, v, 40, 2, 152) - 0.5) * 0.14 - (a - 0.5) * 0.35;
});

grain("halftone", (_u, _v, i, j) => {
  const p = 16;
  const d = (Math.cos((2 * Math.PI * (i + j)) / p) + Math.cos((2 * Math.PI * (i - j)) / p)) / 2;
  return smooth(-0.1, 0.12, d) * 0.92 + 0.04;
});

grain("crosshatch", (u, v, i, j) => {
  const p = 16;
  const wob = fbm(u, v, 24, 2, 161);
  const a = Math.abs(mod(i + j, p) - p / 2) / (p / 2);
  const b = Math.abs(mod(i - j, p) - p / 2) / (p / 2);
  const k = 0.3 + (wob - 0.5) * 0.25;
  const la = 1 - smooth(0, k, 1 - a);
  const lb = 1 - smooth(0, k, 1 - b);
  return 1 - Math.max(la, lb) * 0.8 + (wob - 0.5) * 0.1;
});

// ---------- main ----------
function clean(dir: string) {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (f.endsWith(".png")) unlinkSync(join(dir, f));
}

function main() {
  clean(join(OUT, "tips"));
  clean(join(OUT, "grains"));
  const manifest: { tips: Array<{ file: string; size: number }>; grains: Array<{ file: string; size: number }> } = { tips: [], grains: [] };
  for (const t of TIPS) {
    const px = renderTip(t.size, t.draw(t.size));
    writeFileSync(join(OUT, "tips", `${t.name}.png`), encodePng(t.size, t.size, 2, px));
    manifest.tips.push({ file: `tips/${t.name}.png`, size: t.size });
  }
  for (const g of GRAINS) {
    const px = new Uint8Array(G * G);
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) px[j * G + i] = Math.round(clamp(g.fn(i / G, j / G, i, j)) * 255);
    writeFileSync(join(OUT, "grains", `${g.name}.png`), encodePng(G, G, 1, px));
    manifest.grains.push({ file: `grains/${g.name}.png`, size: G });
  }
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`brushgen: ${TIPS.length} tips, ${GRAINS.length} grains -> ${OUT}`);
}

main();
