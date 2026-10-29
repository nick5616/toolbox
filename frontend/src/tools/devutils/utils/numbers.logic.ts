export type Base = 2 | 8 | 10 | 16;

const DIGITS: Record<Base, RegExp> = {
  2: /^[01]+$/,
  8: /^[0-7]+$/,
  10: /^\d+$/,
  16: /^[0-9a-f]+$/i,
};

/** Parses an integer in `base` (optional sign, 0x/0o/0b prefix, `_` and spaces ignored). */
export function parseBigInt(text: string, base: Base): bigint | null {
  let t = text.trim().replace(/[_\s]/g, "");
  let neg = false;
  if (t.startsWith("-")) {
    neg = true;
    t = t.slice(1);
  } else if (t.startsWith("+")) t = t.slice(1);
  const prefix = base === 16 ? /^0x/i : base === 8 ? /^0o/i : base === 2 ? /^0b/i : null;
  if (prefix) t = t.replace(prefix, "");
  if (!t || !DIGITS[base].test(t)) return null;
  let v: bigint;
  if (base === 10) v = BigInt(t);
  else v = BigInt((base === 16 ? "0x" : base === 8 ? "0o" : "0b") + t);
  return neg ? -v : v;
}

export function formatBigInt(v: bigint, base: Base): string {
  return v.toString(base).toUpperCase();
}

export const WIDTHS = [8, 16, 32, 64] as const;

export function clampWidth(w: number): number {
  if (!Number.isFinite(w)) return 8;
  return Math.min(64, Math.max(8, Math.trunc(w)));
}

export interface TwosComplementView {
  fits: boolean;
  /** Unsigned value of the bit pattern (only meaningful when fits). */
  unsigned: bigint;
  signed: bigint;
  bits: string;
  hex: string;
}

/** The bit pattern of `v` in `width` bits. `fits` is false outside [-2^(w-1), 2^w - 1]. */
export function twosComplement(v: bigint, width: number): TwosComplementView {
  const w = BigInt(clampWidth(width));
  const min = -(1n << (w - 1n));
  const max = (1n << w) - 1n;
  const fits = v >= min && v <= max;
  const unsigned = BigInt.asUintN(Number(w), v);
  const signed = BigInt.asIntN(Number(w), v);
  const bits = unsigned.toString(2).padStart(Number(w), "0");
  const hex = unsigned.toString(16).toUpperCase().padStart(Number(w) / 4, "0");
  return { fits, unsigned, signed, bits, hex };
}

/** Groups a binary string in nibbles for display. */
export function groupBits(bits: string): string {
  return bits.replace(/(.{4})(?=.)/g, "$1 ");
}
