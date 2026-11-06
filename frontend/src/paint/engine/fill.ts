// Flood fill masks for the paint bucket and the magic wand.

/**
 * 0/255 mask of the pixels matching the seed pixel within `tol` (0..1 of the
 * largest channel difference, on premultiplied RGBA). Contiguous = 4-connected.
 * `limit` (a selection) excludes pixels where it is 0.
 */
export function floodMask(px: Uint8ClampedArray, w: number, h: number, sx: number, sy: number, tol: number, contiguous: boolean, limit?: Uint8Array | null): Uint8Array {
  const out = new Uint8Array(w * h);
  const si = (sy * w + sx) * 4;
  const r0 = px[si] as number;
  const g0 = px[si + 1] as number;
  const b0 = px[si + 2] as number;
  const a0 = px[si + 3] as number;
  const t = Math.round(Math.max(0, Math.min(1, tol)) * 255);
  const match = (i: number) => {
    if (limit && limit[i] === 0) return false;
    const o = i * 4;
    return (
      Math.abs((px[o] as number) - r0) <= t &&
      Math.abs((px[o + 1] as number) - g0) <= t &&
      Math.abs((px[o + 2] as number) - b0) <= t &&
      Math.abs((px[o + 3] as number) - a0) <= t
    );
  };
  if (!contiguous) {
    for (let i = 0; i < out.length; i++) if (match(i)) out[i] = 255;
    return out;
  }
  if (!match(sy * w + sx)) return out;
  // Span-based scanline fill with an explicit stack.
  const stack: number[] = [sx, sy];
  while (stack.length) {
    const y = stack.pop() as number;
    let x = stack.pop() as number;
    if (out[y * w + x]) continue;
    let xl = x;
    while (xl > 0 && !out[y * w + xl - 1] && match(y * w + xl - 1)) xl--;
    let xr = x;
    while (xr < w - 1 && !out[y * w + xr + 1] && match(y * w + xr + 1)) xr++;
    for (x = xl; x <= xr; x++) out[y * w + x] = 255;
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      let inSpan = false;
      for (x = xl; x <= xr; x++) {
        const ok = !out[ny * w + x] && match(ny * w + x);
        if (ok && !inSpan) {
          stack.push(x, ny);
          inSpan = true;
        } else if (!ok) {
          inSpan = false;
        }
      }
    }
  }
  return out;
}

/** A 1 px half-strength ring around a mask, so fills tuck under line art. */
export function haloMask(m: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(m);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (m[i]) continue;
      if ((x > 0 && m[i - 1]) || (x < w - 1 && m[i + 1]) || (y > 0 && m[i - w]) || (y < h - 1 && m[i + w])) out[i] = 128;
    }
  }
  return out;
}
