import { base64ToBytes } from "./base64.logic";

export type ClaimStatus = "ok" | "expired" | "not-yet-valid";

export interface TimeClaim {
  name: "exp" | "iat" | "nbf";
  seconds: number;
  local: string;
  status: ClaimStatus;
}

export interface DecodedJwt {
  headerText: string;
  payloadText: string;
  signature: string;
  claims: TimeClaim[];
}

function decodePart(part: string, what: string): { text: string; value: unknown } {
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(base64ToBytes(part));
  } catch {
    throw new Error(`The ${what} isn't valid Base64URL text`);
  }
  try {
    const value = JSON.parse(raw) as unknown;
    return { text: JSON.stringify(value, null, 2), value };
  } catch {
    throw new Error(`The ${what} isn't valid JSON`);
  }
}

export function claimStatus(name: TimeClaim["name"], seconds: number, nowMs: number): ClaimStatus {
  const now = nowMs / 1000;
  if (name === "exp") return seconds <= now ? "expired" : "ok";
  if (name === "nbf") return seconds > now ? "not-yet-valid" : "ok";
  return "ok";
}

/** Decodes a JWT. It never verifies the signature. */
export function decodeJwt(token: string, nowMs: number): DecodedJwt {
  const t = token.trim().replace(/^Bearer\s+/i, "");
  const parts = t.split(".");
  if (parts.length !== 3) throw new Error("A JWT has three dot-separated parts (header.payload.signature)");
  const h = decodePart(parts[0] ?? "", "header");
  const p = decodePart(parts[1] ?? "", "payload");
  const claims: TimeClaim[] = [];
  if (typeof p.value === "object" && p.value !== null && !Array.isArray(p.value)) {
    for (const name of ["iat", "nbf", "exp"] as const) {
      const v = (p.value as Record<string, unknown>)[name];
      if (typeof v === "number" && Number.isFinite(v)) {
        const d = new Date(v * 1000);
        claims.push({
          name,
          seconds: v,
          local: Number.isNaN(d.getTime()) ? "out of range" : d.toLocaleString(),
          status: claimStatus(name, v, nowMs),
        });
      }
    }
  }
  return { headerText: h.text, payloadText: p.text, signature: parts[2] ?? "", claims };
}
