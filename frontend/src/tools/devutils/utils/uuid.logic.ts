export type IdKind = "v4" | "v7" | "ulid";

export interface IdDeps {
  now: () => number; // ms
  random: (n: number) => Uint8Array;
}

export const defaultDeps: IdDeps = {
  now: () => Date.now(),
  random: (n) => crypto.getRandomValues(new Uint8Array(n)),
};

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

function format(b: Uint8Array): string {
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function uuidV4(d: IdDeps = defaultDeps): string {
  const b = d.random(16).slice();
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  return format(b);
}

export function uuidV7(d: IdDeps = defaultDeps): string {
  const b = d.random(16).slice();
  let ts = BigInt(d.now());
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  return format(b);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(d: IdDeps = defaultDeps): string {
  let ts = d.now();
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD.charAt(ts % 32) + time;
    ts = Math.floor(ts / 32);
  }
  let n = 0n;
  for (const x of d.random(10)) n = (n << 8n) | BigInt(x);
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand = CROCKFORD.charAt(Number(n & 31n)) + rand;
    n >>= 5n;
  }
  return time + rand;
}

export function clampCount(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(1000, Math.max(1, Math.trunc(n)));
}

export function generateIds(kind: IdKind, count: number, upper: boolean, d: IdDeps = defaultDeps): string[] {
  const n = clampCount(count);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = kind === "v4" ? uuidV4(d) : kind === "v7" ? uuidV7(d) : ulid(d);
    out.push(upper ? id.toUpperCase() : id.toLowerCase());
  }
  return out;
}
