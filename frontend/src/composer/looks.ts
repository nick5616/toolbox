import type { ComposerLook } from "@/lib/api";

// Colour looks as pixel operations (SPEC.md Part B §B5.2): no ctx.filter, so
// the result is identical in WebView2 and WKWebView. A look is one affine RGB
// matrix (3 rows of [r g b offset], offsets in 0..1 units) composed from the
// preset and the four sliders.

/** 3×4 row-major: out = M[:, 0..2]·rgb + M[:, 3]. */
export type ColorMatrix = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

export const IDENTITY: ColorMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

export const LOOK_PRESETS = ["none", "vivid", "warm", "cool", "mono", "fade", "noir"] as const;
export type LookPreset = (typeof LOOK_PRESETS)[number];

const LUMA = [0.2126, 0.7152, 0.0722] as const;

/** Applies b after a: result(x) = b(a(x)). */
export function compose(a: ColorMatrix, b: ColorMatrix): ColorMatrix {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let v = 0;
      for (let k = 0; k < 3; k++) v += (b[r * 4 + k] as number) * (a[k * 4 + c] as number);
      out.push(v);
    }
    let off = b[r * 4 + 3] as number;
    for (let k = 0; k < 3; k++) off += (b[r * 4 + k] as number) * (a[k * 4 + 3] as number);
    out.push(off);
  }
  return [
    out[0], out[1], out[2], out[3], out[4], out[5], out[6], out[7], out[8], out[9], out[10], out[11],
  ] as unknown as ColorMatrix;
}

export function brightnessMatrix(b: number): ColorMatrix {
  const o = b * 0.5;
  return [1, 0, 0, o, 0, 1, 0, o, 0, 0, 1, o];
}

/** c in -1..1; factor 1 + c around mid grey. */
export function contrastMatrix(c: number): ColorMatrix {
  const f = 1 + c;
  const o = 0.5 * (1 - f);
  return [f, 0, 0, o, 0, f, 0, o, 0, 0, f, o];
}

/** s in -1..1; -1 is greyscale, 0 unchanged, 1 doubles saturation. */
export function saturationMatrix(s: number): ColorMatrix {
  const k = 1 + s;
  const m: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) m.push((1 - k) * (LUMA[c] as number) + (r === c ? k : 0));
    m.push(0);
  }
  return m as unknown as ColorMatrix;
}

/** w in -1..1; positive warms (red up, blue down). */
export function warmthMatrix(w: number): ColorMatrix {
  return [1 + 0.2 * w, 0, 0, 0, 0, 1 + 0.03 * w, 0, 0, 0, 0, 1 - 0.2 * w, 0];
}

function chain(...ms: ColorMatrix[]): ColorMatrix {
  return ms.reduce((acc, m) => compose(acc, m), IDENTITY);
}

/** The preset matrices. */
export function presetMatrix(preset: string): ColorMatrix {
  switch (preset) {
    case "vivid":
      return chain(saturationMatrix(0.35), contrastMatrix(0.1));
    case "warm":
      return chain(warmthMatrix(0.6), brightnessMatrix(0.02));
    case "cool":
      return chain(warmthMatrix(-0.6), brightnessMatrix(0.01));
    case "mono":
      return saturationMatrix(-1);
    case "fade":
      return chain(contrastMatrix(-0.18), saturationMatrix(-0.15), brightnessMatrix(0.08));
    case "noir":
      return chain(saturationMatrix(-1), contrastMatrix(0.35), brightnessMatrix(-0.06));
    default:
      return IDENTITY;
  }
}

/** The preset, then brightness, contrast, saturation and warmth. */
export function lookMatrix(look: ComposerLook): ColorMatrix {
  return chain(
    presetMatrix(look.preset),
    brightnessMatrix(look.brightness || 0),
    contrastMatrix(look.contrast || 0),
    saturationMatrix(look.saturation || 0),
    warmthMatrix(look.warmth || 0),
  );
}

export function isIdentityLook(look: ComposerLook | null | undefined): boolean {
  if (!look) return true;
  return (look.preset === "none" || look.preset === "" || !look.preset) && !look.brightness && !look.contrast && !look.saturation && !look.warmth;
}

/** Transforms the RGB of RGBA bytes in place (alpha untouched). */
export function applyMatrix(data: Uint8ClampedArray, m: ColorMatrix): void {
  const [a, b, c, d, e, f, g, h, i, j, k, l] = m;
  const d255 = d * 255;
  const h255 = h * 255;
  const l255 = l * 255;
  for (let p = 0; p + 3 < data.length; p += 4) {
    const r = data[p] as number;
    const gg = data[p + 1] as number;
    const bb = data[p + 2] as number;
    data[p] = a * r + b * gg + c * bb + d255;
    data[p + 1] = e * r + f * gg + g * bb + h255;
    data[p + 2] = i * r + j * gg + k * bb + l255;
  }
}

/** Applies a look to RGBA bytes in place; a no-op for the identity look. */
export function applyLook(data: Uint8ClampedArray, look: ComposerLook): void {
  if (isIdentityLook(look)) return;
  applyMatrix(data, lookMatrix(look));
}
