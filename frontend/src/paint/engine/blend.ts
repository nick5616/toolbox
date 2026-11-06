// Blend maths (W3C compositing and blending) on premultiplied RGBA8. This is
// the reference; shaders.ts mirrors it in GLSL.

const sat = (r: number, g: number, b: number) => Math.max(r, g, b) - Math.min(r, g, b);
const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;

function clipColor(c: [number, number, number]): void {
  const l = lum(c[0], c[1], c[2]);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  if (n < 0) for (let i = 0; i < 3; i++) c[i] = l + (((c[i] as number) - l) * l) / (l - n);
  if (x > 1) for (let i = 0; i < 3; i++) c[i] = l + (((c[i] as number) - l) * (1 - l)) / (x - l);
}

function setLum(r: number, g: number, b: number, l: number, out: [number, number, number]): void {
  const d = l - lum(r, g, b);
  out[0] = r + d;
  out[1] = g + d;
  out[2] = b + d;
  clipColor(out);
}

function setSat(r: number, g: number, b: number, s: number, out: [number, number, number]): void {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx > mn) {
    out[0] = ((r - mn) * s) / (mx - mn);
    out[1] = ((g - mn) * s) / (mx - mn);
    out[2] = ((b - mn) * s) / (mx - mn);
  } else {
    out[0] = out[1] = out[2] = 0;
  }
}

function softLight(cb: number, cs: number): number {
  if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
  const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
  return cb + (2 * cs - 1) * (d - cb);
}

function hardLight(cb: number, cs: number): number {
  return cs <= 0.5 ? cb * 2 * cs : cb + (2 * cs - 1) - cb * (2 * cs - 1);
}

/** Separable B(cb, cs) for modes 1..11 (index into BLEND_MODES). */
export function blendChannel(mode: number, cb: number, cs: number): number {
  switch (mode) {
    case 1:
      return cb * cs;
    case 2:
      return cb + cs - cb * cs;
    case 3:
      return hardLight(cs, cb); // overlay
    case 4:
      return Math.min(1, cb + cs);
    case 5:
      return Math.min(cb, cs);
    case 6:
      return Math.max(cb, cs);
    case 7:
      return cb === 0 ? 0 : cs >= 1 ? 1 : Math.min(1, cb / (1 - cs));
    case 8:
      return cb >= 1 ? 1 : cs <= 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs);
    case 9:
      return softLight(cb, cs);
    case 10:
      return hardLight(cb, cs);
    case 11:
      return Math.abs(cb - cs);
    default:
      return cs;
  }
}

const tmp: [number, number, number] = [0, 0, 0];
const tmp2: [number, number, number] = [0, 0, 0];

/** B(cb, cs) for any mode, into out (straight colours 0..1). */
export function blendRGB(mode: number, br: number, bg: number, bb: number, sr: number, sg: number, sb: number, out: [number, number, number]): void {
  if (mode < 12) {
    out[0] = blendChannel(mode, br, sr);
    out[1] = blendChannel(mode, bg, sg);
    out[2] = blendChannel(mode, bb, sb);
    return;
  }
  switch (mode) {
    case 12: // hue: hue of source, sat and lum of backdrop
      setSat(sr, sg, sb, sat(br, bg, bb), tmp2);
      setLum(tmp2[0], tmp2[1], tmp2[2], lum(br, bg, bb), out);
      return;
    case 13: // saturation: sat of source
      setSat(br, bg, bb, sat(sr, sg, sb), tmp2);
      setLum(tmp2[0], tmp2[1], tmp2[2], lum(br, bg, bb), out);
      return;
    case 14: // color: hue+sat of source, lum of backdrop
      setLum(sr, sg, sb, lum(br, bg, bb), out);
      return;
    default: // luminosity
      setLum(br, bg, bb, lum(sr, sg, sb), out);
  }
}

/**
 * dst(premult bytes at i) = blend(dst, src) where src is premultiplied floats
 * 0..1 that already include opacity and masks. atop keeps the destination alpha.
 */
export function blendInto(d: Uint8ClampedArray, i: number, sr: number, sg: number, sb: number, sa: number, mode: number, atop: boolean): void {
  if (sa <= 0) return;
  const da = (d[i + 3] as number) / 255;
  const dr = (d[i] as number) / 255;
  const dg = (d[i + 1] as number) / 255;
  const db = (d[i + 2] as number) / 255;
  if (mode === 0 && !atop) {
    const k = 1 - sa;
    d[i] = Math.round((sr + dr * k) * 255);
    d[i + 1] = Math.round((sg + dg * k) * 255);
    d[i + 2] = Math.round((sb + db * k) * 255);
    d[i + 3] = Math.round((sa + da * k) * 255);
    return;
  }
  // Straight colours.
  const csr = sr / sa;
  const csg = sg / sa;
  const csb = sb / sa;
  if (da <= 0) {
    if (atop) return;
    d[i] = Math.round(sr * 255);
    d[i + 1] = Math.round(sg * 255);
    d[i + 2] = Math.round(sb * 255);
    d[i + 3] = Math.round(sa * 255);
    return;
  }
  const cbr = dr / da;
  const cbg = dg / da;
  const cbb = db / da;
  blendRGB(mode, cbr, cbg, cbb, csr, csg, csb, tmp);
  const t0 = tmp[0];
  const t1 = tmp[1];
  const t2 = tmp[2];
  const ao = atop ? da : sa + da * (1 - sa);
  const k0 = atop ? 0 : sa * (1 - da);
  const k1 = sa * da;
  const k2 = (1 - sa) * da;
  d[i] = Math.round((k0 * csr + k1 * t0 + k2 * cbr) * 255);
  d[i + 1] = Math.round((k0 * csg + k1 * t1 + k2 * cbg) * 255);
  d[i + 2] = Math.round((k0 * csb + k1 * t2 + k2 * cbb) * 255);
  d[i + 3] = Math.round(ao * 255);
}
