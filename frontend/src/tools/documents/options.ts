import { DocumentFormat, type DocumentsOptions } from "@/lib/api";

export const MODULE_ID = "documents";

/** Mirrors Go's DefaultOptions() (modules/documents). */
export const DEFAULT_DOCUMENT_OPTIONS: DocumentsOptions = {
  to: DocumentFormat.FormatDOCX,
  pageSize: "a4",
  marginMm: 25,
  mainFont: "",
  fontSizePt: 11,
  toc: false,
  numberSections: false,
  referenceDoc: "",
  embedResources: true,
  extractMedia: false,
};

export interface FormatMeta {
  value: DocumentFormat;
  label: string;
  icon: string;
  /** Input extensions (with dot) that mean this format; none = write only. */
  exts: string[];
}

/** Mirrors the table in modules/documents/options.go, in UI order. */
export const FORMATS: FormatMeta[] = [
  { value: DocumentFormat.FormatDOCX, label: "Word (docx)", icon: "file-text", exts: [".docx"] },
  { value: DocumentFormat.FormatPDF, label: "PDF", icon: "file-type", exts: [] },
  { value: DocumentFormat.FormatODT, label: "OpenDocument (odt)", icon: "file-text", exts: [".odt"] },
  { value: DocumentFormat.FormatRTF, label: "Rich Text (rtf)", icon: "file-text", exts: [".rtf"] },
  { value: DocumentFormat.FormatEPUB, label: "EPUB", icon: "book-open", exts: [".epub"] },
  { value: DocumentFormat.FormatHTML, label: "HTML", icon: "globe", exts: [".html", ".htm"] },
  { value: DocumentFormat.FormatMD, label: "Markdown", icon: "file-code", exts: [".md", ".markdown"] },
  { value: DocumentFormat.FormatGFM, label: "Markdown (GitHub)", icon: "file-code", exts: [] },
  { value: DocumentFormat.FormatLaTeX, label: "LaTeX", icon: "file-code", exts: [".tex"] },
  { value: DocumentFormat.FormatTypst, label: "Typst", icon: "file-code", exts: [".typ"] },
  { value: DocumentFormat.FormatIPYNB, label: "Jupyter notebook", icon: "file-json", exts: [".ipynb"] },
  { value: DocumentFormat.FormatPPTX, label: "PowerPoint (pptx)", icon: "presentation", exts: [] },
  { value: DocumentFormat.FormatTXT, label: "Plain text", icon: "file-text", exts: [".txt"] },
];

export const formatMeta = (f: DocumentFormat): FormatMeta | undefined => FORMATS.find((m) => m.value === f);

export const extOf = (path: string): string => {
  const base = path.split(/[\\/]/).pop() ?? path;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i).toLowerCase() : "";
};

export const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

export const isPdfPath = (p: string): boolean => extOf(p) === ".pdf";

/** The format a file is read as, from its extension (undefined = not a readable document). */
export function sourceFormat(path: string): FormatMeta | undefined {
  const e = extOf(path);
  return FORMATS.find((m) => m.exts.includes(e));
}

/** Which Advanced settings apply to a target (mirrors modules/documents/args.go). */
export interface Applicable {
  layout: boolean; // page size, margins, font, font size
  toc: boolean; // table of contents + numbered sections
  referenceDoc: boolean;
  embed: boolean;
  extractMedia: boolean;
}

const TOC_TARGETS = new Set<DocumentFormat>([
  DocumentFormat.FormatPDF,
  DocumentFormat.FormatTypst,
  DocumentFormat.FormatDOCX,
  DocumentFormat.FormatODT,
  DocumentFormat.FormatHTML,
  DocumentFormat.FormatEPUB,
  DocumentFormat.FormatLaTeX,
]);

export function applicable(to: DocumentFormat): Applicable {
  return {
    layout: to === DocumentFormat.FormatPDF || to === DocumentFormat.FormatTypst,
    toc: TOC_TARGETS.has(to),
    referenceDoc: to === DocumentFormat.FormatDOCX || to === DocumentFormat.FormatODT,
    embed: to === DocumentFormat.FormatHTML,
    extractMedia: to === DocumentFormat.FormatMD || to === DocumentFormat.FormatGFM || to === DocumentFormat.FormatHTML,
  };
}

/** Per-path message when a file can't be converted to `to` (same format, or PowerPoint). */
export function inputProblems(paths: readonly string[], to: DocumentFormat): Record<string, string> {
  const out: Record<string, string> = {};
  const target = formatMeta(to);
  for (const p of paths) {
    if (extOf(p) === ".pptx") out[p] = "PowerPoint files can't be read, only written";
    else if (sourceFormat(p)?.value === to) out[p] = `This is already a ${target?.label ?? "document of this kind"} file`;
  }
  return out;
}

/** A target is disabled when every input is already in that format. */
export function disabledTargets(paths: readonly string[]): Set<DocumentFormat> {
  const out = new Set<DocumentFormat>();
  if (paths.length === 0) return out;
  for (const m of FORMATS) {
    if (paths.every((p) => sourceFormat(p)?.value === m.value)) out.add(m.value);
  }
  return out;
}

/** `sanitize` for useModuleOptions. */
export function sanitizeDocumentOptions(raw: unknown, defaults: DocumentsOptions): DocumentsOptions {
  const out: DocumentsOptions = { ...defaults };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.to === "string" && FORMATS.some((m) => m.value === r.to)) out.to = r.to as DocumentFormat;
  if (r.pageSize === "a4" || r.pageSize === "letter") out.pageSize = r.pageSize;
  if (typeof r.marginMm === "number" && r.marginMm >= 10 && r.marginMm <= 50) out.marginMm = Math.round(r.marginMm);
  if (typeof r.mainFont === "string") out.mainFont = r.mainFont;
  if (typeof r.fontSizePt === "number" && r.fontSizePt >= 9 && r.fontSizePt <= 16) out.fontSizePt = Math.round(r.fontSizePt);
  if (typeof r.toc === "boolean") out.toc = r.toc;
  if (typeof r.numberSections === "boolean") out.numberSections = r.numberSections;
  if (typeof r.referenceDoc === "string") out.referenceDoc = r.referenceDoc;
  if (typeof r.embedResources === "boolean") out.embedResources = r.embedResources;
  if (typeof r.extractMedia === "boolean") out.extractMedia = r.extractMedia;
  return out;
}

/** The parts of the Advanced click-in's one-line summary, for the chosen target. */
export function advancedSummaryParts(o: DocumentsOptions): Array<string | false> {
  const a = applicable(o.to);
  return [
    a.layout && `${o.pageSize === "letter" ? "Letter" : "A4"}, ${o.marginMm} mm margins, ${o.fontSizePt} pt`,
    a.layout && o.mainFont !== "" && o.mainFont,
    a.toc && o.toc && "contents",
    a.toc && o.numberSections && "numbered",
    a.referenceDoc && (o.referenceDoc !== "" ? `styles from ${baseName(o.referenceDoc)}` : "default styles"),
    a.embed && (o.embedResources ? "embedded images" : "linked images"),
    a.extractMedia && o.extractMedia && "extract media",
  ];
}
