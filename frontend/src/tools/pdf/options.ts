import { PdfAction, type PdfOptions, type PdfResult } from "@/lib/api";
import { acceptsPath } from "@/tools/_kit/accepts";

export const MODULE_ID = "pdf";

export const PDF_EXTS = [".pdf"];
export const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"];

export interface ActionMeta {
  id: PdfAction;
  title: string;
  desc: string;
  icon: string;
  /** "pdf" inputs, or "image" inputs. */
  input: "pdf" | "image";
}

export const ACTIONS: readonly ActionMeta[] = [
  { id: PdfAction.ActionMerge, title: "Merge PDFs", desc: "Combine several PDFs into one", icon: "copy", input: "pdf" },
  { id: PdfAction.ActionSplit, title: "Split PDF", desc: "Every N pages or custom ranges", icon: "scissors", input: "pdf" },
  { id: PdfAction.ActionOrganize, title: "Organize pages", desc: "Reorder, rotate and delete pages", icon: "file-text", input: "pdf" },
  { id: PdfAction.ActionCompress, title: "Compress PDF", desc: "Shrink photos and scans", icon: "archive", input: "pdf" },
  { id: PdfAction.ActionImagesToPDF, title: "Images to PDF", desc: "Turn pictures into one PDF", icon: "image", input: "image" },
  { id: PdfAction.ActionPDFToImages, title: "PDF to images", desc: "Render pages as PNG or JPG", icon: "arrow-down-to-line", input: "pdf" },
  { id: PdfAction.ActionProtect, title: "Add password", desc: "Encrypt with AES-256", icon: "lock", input: "pdf" },
  { id: PdfAction.ActionUnlock, title: "Remove password", desc: "Save an unlocked copy", icon: "lock", input: "pdf" },
];

export function actionMeta(a: PdfAction): ActionMeta {
  return ACTIONS.find((m) => m.id === a) ?? (ACTIONS[0] as ActionMeta);
}

/** Non-secret UI state remembered between sessions. */
export interface PdfUiState {
  action: PdfAction;
  splitMode: "every" | "ranges";
  every: number;
  ranges: string;
  level: "small" | "balanced" | "high";
  pageSize: "a4" | "letter" | "fit";
  margin: "none" | "small";
  imageFormat: "png" | "jpg";
  dpi: 72 | 150 | 300;
  pageRange: string;
}

export const DEFAULT_PDF_UI: PdfUiState = {
  action: PdfAction.ActionMerge,
  splitMode: "every",
  every: 1,
  ranges: "",
  level: "balanced",
  pageSize: "a4",
  margin: "small",
  imageFormat: "png",
  dpi: 150,
  pageRange: "",
};

function pick<T extends string | number>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((a) => a === v) ?? fallback;
}

export function sanitizePdfUi(saved: unknown, d: PdfUiState): PdfUiState {
  if (typeof saved !== "object" || saved === null) return d;
  const s = saved as Record<string, unknown>;
  const every = typeof s.every === "number" && Number.isInteger(s.every) && s.every >= 1 ? s.every : d.every;
  return {
    action: pick(s.action, ACTIONS.map((a) => a.id), d.action),
    splitMode: pick(s.splitMode, ["every", "ranges"] as const, d.splitMode),
    every,
    ranges: typeof s.ranges === "string" ? s.ranges : d.ranges,
    level: pick(s.level, ["small", "balanced", "high"] as const, d.level),
    pageSize: pick(s.pageSize, ["a4", "letter", "fit"] as const, d.pageSize),
    margin: pick(s.margin, ["none", "small"] as const, d.margin),
    imageFormat: pick(s.imageFormat, ["png", "jpg"] as const, d.imageFormat),
    dpi: pick(s.dpi, [72, 150, 300] as const, d.dpi),
    pageRange: typeof s.pageRange === "string" ? s.pageRange : d.pageRange,
  };
}

/** Full bound options for an action (passwords are separate Enqueue arguments). */
export function buildOptions(ui: PdfUiState, action: PdfAction, patch: Partial<PdfOptions> = {}): PdfOptions {
  return {
    action,
    splitMode: ui.splitMode,
    every: ui.every,
    ranges: ui.ranges,
    pages: null,
    level: ui.level,
    pageSize: ui.pageSize,
    margin: ui.margin,
    imageFormat: ui.imageFormat,
    dpi: ui.dpi,
    pageRange: ui.pageRange,
    passwordRef: "",
    ...patch,
  };
}

export function isImagePath(p: string): boolean {
  return acceptsPath(IMAGE_EXTS, p);
}
export function isPdfPath(p: string): boolean {
  return acceptsPath(PDF_EXTS, p);
}

/**
 * Chooses the action for the current set of files (SPEC 6.5): stay when the
 * files fit; images go to Images to PDF; several PDFs go to Merge; otherwise
 * the first PDF action that fits.
 */
export function routeAction(current: PdfAction, paths: readonly string[]): PdfAction {
  const pdfs = paths.filter(isPdfPath).length;
  const images = paths.filter(isImagePath).length;
  if (pdfs === 0 && images === 0) return current;
  const meta = actionMeta(current);
  if (pdfs === 0) return PdfAction.ActionImagesToPDF;
  if (meta.input === "image") return pdfs > 1 ? PdfAction.ActionMerge : PdfAction.ActionSplit;
  if (pdfs > 1 && current === PdfAction.ActionOrganize) return PdfAction.ActionMerge;
  return current;
}

export function parsePdfResult(json: string | undefined): PdfResult | null {
  if (!json) return null;
  try {
    const r = JSON.parse(json) as Partial<PdfResult>;
    if (typeof r !== "object" || r === null || typeof r.action !== "string") return null;
    return {
      action: r.action,
      outputs: r.outputs ?? [],
      folder: r.folder ?? "",
      pages: r.pages ?? 0,
      bytesBefore: r.bytesBefore ?? 0,
      bytesAfter: r.bytesAfter ?? 0,
      imagesRecompressed: r.imagesRecompressed ?? 0,
      bookmarksDropped: r.bookmarksDropped ?? false,
    };
  } catch {
    return null;
  }
}

export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}
