export type CaseKind = "camel" | "pascal" | "snake" | "kebab" | "constant" | "title" | "lower" | "upper";

export const CASE_LABEL: Record<CaseKind, string> = {
  camel: "camelCase",
  pascal: "PascalCase",
  snake: "snake_case",
  kebab: "kebab-case",
  constant: "CONSTANT_CASE",
  title: "Title Case",
  lower: "lower case",
  upper: "UPPER CASE",
};

/** Splits identifiers and phrases into words: handles camelCase, XMLHttp, separators and digits. */
export function splitWords(s: string): string[] {
  const spaced = s
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/(\p{L})(\d)/gu, "$1 $2");
  return spaced.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

const cap = (w: string) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w);

export function convertCase(s: string, kind: CaseKind): string {
  if (kind === "lower") return s.toLowerCase();
  if (kind === "upper") return s.toUpperCase();
  const words = splitWords(s);
  switch (kind) {
    case "camel":
      return words.map((w, i) => (i === 0 ? w.toLowerCase() : cap(w))).join("");
    case "pascal":
      return words.map(cap).join("");
    case "snake":
      return words.map((w) => w.toLowerCase()).join("_");
    case "kebab":
      return words.map((w) => w.toLowerCase()).join("-");
    case "constant":
      return words.map((w) => w.toUpperCase()).join("_");
    case "title":
      return words.map(cap).join(" ");
  }
}

export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

export interface TextCounts {
  chars: number;
  words: number;
  lines: number;
  bytes: number;
}

export function countText(s: string): TextCounts {
  const trimmed = s.trim();
  return {
    chars: [...s].length,
    words: trimmed === "" ? 0 : trimmed.split(/\s+/).length,
    lines: s === "" ? 0 : s.split(/\r\n|\r|\n/).length,
    bytes: new TextEncoder().encode(s).length,
  };
}

export type LineOp = "sort-asc" | "sort-desc" | "dedupe" | "trim" | "reverse" | "remove-empty";

export const LINE_OP_LABEL: Record<LineOp, string> = {
  "sort-asc": "Sort A to Z",
  "sort-desc": "Sort Z to A",
  dedupe: "Remove duplicates",
  trim: "Trim each line",
  reverse: "Reverse order",
  "remove-empty": "Remove empty lines",
};

export function lineOp(s: string, op: LineOp): string {
  const lines = s.split(/\r\n|\r|\n/);
  const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  switch (op) {
    case "sort-asc":
      return [...lines].sort(cmp).join("\n");
    case "sort-desc":
      return [...lines].sort((a, b) => cmp(b, a)).join("\n");
    case "dedupe":
      return [...new Set(lines)].join("\n");
    case "trim":
      return lines.map((l) => l.trim()).join("\n");
    case "reverse":
      return [...lines].reverse().join("\n");
    case "remove-empty":
      return lines.filter((l) => l.trim() !== "").join("\n");
  }
}
