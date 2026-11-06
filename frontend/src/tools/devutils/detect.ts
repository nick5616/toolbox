/** Which utility a piece of handed-over text belongs to (Phase 11, SPEC §5.7). Pure. */
import type { UtilId } from "./registry";

export interface Detected {
  util: UtilId;
  /** The store key (within the utility) that takes the text. */
  key: string;
}

/** The input field each utility takes handed-over text in. */
export const INPUT_KEY: Partial<Record<UtilId, string>> = {
  json: "input",
  base64: "input",
  url: "url",
  jwt: "token",
  time: "text",
  color: "text",
  text: "text",
};

const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;
const UNIX = /^(\d{9,10}|\d{12,13})$/;
const COLOR = /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|rgba|hsl|hsla|oklch|oklab|hwb|lab|lch)\(\s*[^)]*\))$/i;
const BASE64 = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;

function isJsonLike(s: string): boolean {
  const open = s[0];
  const close = s[s.length - 1];
  if (!((open === "{" && close === "}") || (open === "[" && close === "]"))) return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    // Looks like JSON but has an error: still the right place to see where.
    return s.length > 1 && /["':]/.test(s);
  }
}

function isJwt(s: string): boolean {
  if (!JWT.test(s)) return false;
  const head = s.split(".")[0] ?? "";
  try {
    const json = atob(head.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(head.length / 4) * 4, "="));
    return json.trimStart().startsWith("{");
  } catch {
    return false;
  }
}

/** JSON, JWT, URL, Unix timestamp, colour, Base64; anything else is plain Text. */
export function detectUtil(text: string): Detected {
  const s = text.trim();
  const as = (util: UtilId): Detected => ({ util, key: INPUT_KEY[util] ?? "text" });
  if (s === "") return as("text");
  if (isJwt(s)) return as("jwt");
  if (isJsonLike(s)) return as("json");
  if (URL_RE.test(s)) return as("url");
  if (UNIX.test(s)) return as("time");
  if (COLOR.test(s)) return as("color");
  if (BASE64.test(s) && /[A-Za-z]/.test(s)) return as("base64");
  return as("text");
}
