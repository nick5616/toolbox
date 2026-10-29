export interface Base64Options {
  urlSafe: boolean;
  padding: boolean;
}

/** Applies the URL-safe / padding toggles to standard padded Base64. */
export function reshapeBase64(standard: string, opts: Base64Options): string {
  let out = standard;
  if (opts.urlSafe) out = out.replace(/\+/g, "-").replace(/\//g, "_");
  if (!opts.padding) out = out.replace(/=+$/, "");
  return out;
}

export function bytesToBase64(bytes: Uint8Array, opts: Base64Options): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return reshapeBase64(btoa(bin), opts);
}

export function encodeText(text: string, opts: Base64Options): string {
  return bytesToBase64(new TextEncoder().encode(text), opts);
}

/** Decodes standard or URL-safe Base64, with or without padding; whitespace is ignored. */
export function base64ToBytes(input: string): Uint8Array {
  let s = input.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (/[^A-Za-z0-9+/]/.test(s)) throw new Error("Not valid Base64: unexpected character");
  if (s.length % 4 === 1) throw new Error("Not valid Base64: incomplete data");
  s += "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function decodeText(input: string): string {
  const bytes = base64ToBytes(input);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Decoded bytes are not valid UTF-8 text");
  }
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  pdf: "application/pdf",
  json: "application/json",
  txt: "text/plain",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  csv: "text/csv",
  xml: "application/xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  woff2: "font/woff2",
  zip: "application/zip",
};

export function mimeForPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const i = base.lastIndexOf(".");
  const ext = i > 0 ? base.slice(i + 1).toLowerCase() : "";
  return MIME[ext] ?? "application/octet-stream";
}

export function toDataUrl(base64: string, mime: string): string {
  return `data:${mime};base64,${base64}`;
}
