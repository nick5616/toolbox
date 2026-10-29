export const HASH_ALGOS = ["md5", "sha1", "sha256", "sha512", "crc32"] as const;
export type HashAlgo = (typeof HASH_ALGOS)[number];

export const ALGO_LABEL: Record<HashAlgo, string> = {
  md5: "MD5",
  sha1: "SHA-1",
  sha256: "SHA-256",
  sha512: "SHA-512",
  crc32: "CRC32",
};

/** Normalises a pasted digest: trims, drops spaces/colons and an "algo:" prefix, lower-cases. */
export function normalizeDigest(s: string): string {
  return s
    .trim()
    .replace(/^[a-z0-9-]+:(?=[0-9a-f]{8})/i, "")
    .replace(/[\s:]/g, "")
    .toLowerCase();
}

/** The algorithm whose value equals the compare field, if any. */
export function matchingAlgo(hashes: Readonly<Record<string, string>>, compare: string): string | null {
  const c = normalizeDigest(compare);
  if (!c) return null;
  for (const [algo, hex] of Object.entries(hashes)) if (hex.toLowerCase() === c) return algo;
  return null;
}

export interface HashedFile {
  path: string;
  size: number;
  hashes: Record<string, string>;
}

/** Parses the hash job's result JSON; null when it isn't the expected shape. */
export function parseHashResult(json: string | undefined | null): HashedFile[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as { files?: unknown };
    if (!Array.isArray(v.files)) return null;
    return v.files.map((f: unknown) => {
      const o = f as { path?: unknown; size?: unknown; hashes?: unknown };
      return {
        path: typeof o.path === "string" ? o.path : "",
        size: typeof o.size === "number" ? o.size : 0,
        hashes: typeof o.hashes === "object" && o.hashes !== null ? (o.hashes as Record<string, string>) : {},
      };
    });
  } catch {
    return null;
  }
}
