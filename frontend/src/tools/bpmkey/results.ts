import type { BpmKeyResult, KeyCandidate } from "@/lib/api";

export const MODULE_ID = "bpm-key";
export const MAX_ROWS = 200;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseCandidates(v: unknown): KeyCandidate[] {
  if (!Array.isArray(v)) return [];
  const out: KeyCandidate[] = [];
  for (const c of v as unknown[]) {
    if (typeof c !== "object" || c === null) continue;
    const r = c as Record<string, unknown>;
    if (typeof r.key === "string" && typeof r.camelot === "string") {
      out.push({ key: r.key, camelot: r.camelot, r: num(r.r) ?? 0 });
    }
  }
  return out;
}

/** Parses a bpm-key job's resultJson; null when missing or malformed. */
export function parseBpmKeyResult(json: string | null | undefined): BpmKeyResult | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    const r = v as Record<string, unknown>;
    const bpm = num(r.bpm);
    if (bpm === null || typeof r.key !== "string") return null;
    return {
      bpm,
      bpmCandidates: Array.isArray(r.bpmCandidates)
        ? (r.bpmCandidates as unknown[]).filter((x): x is number => num(x) !== null)
        : [],
      key: r.key,
      camelot: typeof r.camelot === "string" ? r.camelot : "",
      confidence: num(r.confidence) ?? 0,
      alternatives: parseCandidates(r.alternatives),
      durationSec: num(r.durationSec) ?? 0,
      truncated: r.truncated === true,
    };
  } catch {
    return null;
  }
}

export interface BpmRow {
  id: string;
  file: string;
  at: number;
  result: BpmKeyResult;
}

export const bpmText = (r: BpmKeyResult): string => r.bpm.toFixed(1);
export const confidenceText = (r: BpmKeyResult): string => r.confidence.toFixed(2);
