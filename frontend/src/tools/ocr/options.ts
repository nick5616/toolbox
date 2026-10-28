import { OcrImageOutput, OcrLanguage, OcrPdfOutput, type OcrOptions } from "@/lib/api";
import type { JobView } from "@/state/jobs";
import { basename, num, parseJson, str } from "../image/common";

/** Mirrors Go's DefaultOptions() (modules/ocr). */
export const DEFAULT_OCR_OPTIONS: OcrOptions = {
  language: OcrLanguage.LangLatin,
  pdfOutput: OcrPdfOutput.PDFSearchable,
  imageOutput: OcrImageOutput.ImageText,
  skipText: true,
};

function oneOf<T extends string>(enumObj: Record<string, T>, v: unknown): T | undefined {
  return typeof v === "string" && v !== "" && Object.values(enumObj).includes(v as T) ? (v as T) : undefined;
}

/** `sanitize` for useModuleOptions: keeps only valid fields over defaults. */
export function sanitizeOcrOptions(raw: unknown, defaults: OcrOptions): OcrOptions {
  const out: OcrOptions = { ...defaults };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  out.language = oneOf(OcrLanguage, r.language) ?? out.language;
  out.pdfOutput = oneOf(OcrPdfOutput, r.pdfOutput) ?? out.pdfOutput;
  out.imageOutput = oneOf(OcrImageOutput, r.imageOutput) ?? out.imageOutput;
  if (typeof r.skipText === "boolean") out.skipText = r.skipText;
  return out;
}

export const FALLBACK_LANGUAGES: Array<{ id: OcrLanguage; label: string; downloadBytes: number }> = [
  { id: OcrLanguage.LangLatin, label: "Latin, Chinese, Japanese", downloadBytes: 0 },
  { id: OcrLanguage.LangCyrillic, label: "Cyrillic", downloadBytes: 13e6 },
  { id: OcrLanguage.LangArabic, label: "Arabic", downloadBytes: 13e6 },
  { id: OcrLanguage.LangKorean, label: "Korean", downloadBytes: 13e6 },
  { id: OcrLanguage.LangGreek, label: "Greek", downloadBytes: 13e6 },
  { id: OcrLanguage.LangThai, label: "Thai", downloadBytes: 13e6 },
  { id: OcrLanguage.LangDevanagari, label: "Devanagari", downloadBytes: 13e6 },
];

export function downloadNote(bytes: number): string {
  return `downloads ~${Math.max(1, Math.round(bytes / 1e6))} MB on first use`;
}

export interface OcrResultItem {
  id: string;
  title: string;
  kind: "image" | "pdf";
  meta: string;
  preview: string;
  files: Array<{ id: string; path: string; name: string; missing: boolean }>;
}

/** Result card data for a finished OCR job; null when the result is missing. */
export function toOcrResult(job: JobView): OcrResultItem | null {
  const r = parseJson(job.resultJson);
  if (!r) return null;
  const kind = str(r.kind) === "pdf" ? "pdf" : "image";
  const chars = num(r.characters);
  const conf = num(r.meanConfidence);
  const parts: string[] = [];
  if (kind === "pdf") {
    const pages = num(r.pages);
    const skipped = num(r.pagesSkipped);
    parts.push(`${pages} ${pages === 1 ? "page" : "pages"}`);
    if (skipped > 0) parts.push(`${skipped} already had text`);
  } else {
    const lines = num(r.lines);
    parts.push(`${lines} ${lines === 1 ? "line" : "lines"}`);
  }
  parts.push(`${chars.toLocaleString("en-US")} characters`);
  if (conf > 0) parts.push(`${Math.round(conf * 100)}% confidence`);

  const outPaths = Array.isArray(r.outputs) ? r.outputs.filter((p): p is string => typeof p === "string") : [];
  const files = (outPaths.length > 0 ? outPaths : job.outputs.map((o) => o.path)).map((path) => {
    const out = job.outputs.find((o) => o.path === path);
    return { id: out?.id ?? "", path, name: basename(path), missing: out?.missing ?? false };
  });
  const input = job.inputs[0];
  return {
    id: job.id,
    title: input ? basename(input) : job.title,
    kind,
    meta: parts.join(" · "),
    preview: kind === "image" ? str(r.preview) : "",
    files,
  };
}
