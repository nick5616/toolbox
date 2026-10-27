// Mirrors modules/downloader/validate.go (ParseTimecode / validateTrim). Keep in sync.

const DIGITS = /^[0-9]+$/;

export const TIMECODE_FORMAT_MESSAGE = "Use a time like 1:05 or 1:02:03.5";

/**
 * Parses SS[.fff], M:SS[.fff], MM:SS[.fff] or H:MM:SS[.fff] into seconds.
 * Non-leading minutes and seconds must be two digits and < 60. Returns null when invalid.
 */
export function parseTimecode(input: string): number | null {
  const s = input.trim();
  if (s === "") return null;
  const parts = s.split(":");
  if (parts.length > 3) return null;
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? "";
    const last = i === parts.length - 1;
    const leading = i === 0;
    let whole = p;
    let frac = "";
    if (last) {
      const dot = p.indexOf(".");
      if (dot >= 0) {
        whole = p.slice(0, dot);
        frac = p.slice(dot + 1);
        if (frac === "" || !DIGITS.test(frac)) return null;
      }
    }
    if (whole === "" || !DIGITS.test(whole) || whole.length > 9) return null;
    if (!leading && whole.length !== 2) return null;
    const n = Number.parseInt(whole, 10);
    if (!leading && n >= 60) return null;
    total = total * 60 + n;
    if (frac !== "") total += Number.parseFloat(`0.${frac}`);
  }
  return total;
}

export interface TrimErrors {
  trimStart?: string;
  trimEnd?: string;
}

/** Same rules and messages as Go's validateTrim. Returns {} when valid or trim is off. */
export function validateTrim(enabled: boolean, start: string, end: string): TrimErrors {
  const out: TrimErrors = {};
  if (!enabled) return out;
  const st = start.trim();
  const en = end.trim();
  if (st === "" && en === "") {
    out.trimStart = "Set a start or an end time";
    return out;
  }
  let s = 0;
  let e = 0;
  let sOK = false;
  let eOK = false;
  if (st !== "") {
    const v = parseTimecode(st);
    if (v === null) out.trimStart = TIMECODE_FORMAT_MESSAGE;
    else {
      s = v;
      sOK = true;
    }
  } else {
    sOK = true; // start defaults to 0
  }
  if (en !== "") {
    const v = parseTimecode(en);
    if (v === null) out.trimEnd = TIMECODE_FORMAT_MESSAGE;
    else {
      e = v;
      eOK = true;
    }
  }
  if (sOK && eOK && e <= s) out.trimEnd = "End must be after start";
  return out;
}
