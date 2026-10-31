import type { Accepts, OutputKind, PipelineCheck, PipelineStep, StepFilter, StepProduct } from "@/lib/api";
import { extOf } from "@/tools/_kit/accepts";

// Step compatibility for the editor (SPEC.md §11.3): which files are
// available at a point of the pipeline, and whether a step type reads them.
// Go's Describe has the final word; this only orders the Add-step menu.

export const FROM_INPUT = "input";
export const FROM_NONE = "none";

/** Lower-case extensions with the dot. */
function norm(exts: readonly string[] | null | undefined): string[] {
  return (exts ?? []).map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase());
}

/** Applies a step's filter to products (roles, kinds, exts; the name filter can't be checked here). */
export function filterProducts(products: readonly StepProduct[], filter: StepFilter | undefined): StepProduct[] {
  const roles = filter?.roles ?? [];
  const kinds = filter?.kinds ?? [];
  const exts = norm(filter?.exts);
  return products
    .filter((p) => roles.length === 0 || roles.includes(p.role))
    .filter((p) => kinds.length === 0 || (p.kind !== "" && kinds.includes(p.kind)))
    .map((p) => (exts.length === 0 ? p : { ...p, exts: norm(p.exts).filter((e) => exts.includes(e)) }))
    .filter((p) => exts.length === 0 || (p.exts ?? []).length > 0);
}

/** True when a step accepting `accepts` can read at least one of `products`. */
export function canRead(accepts: Accepts, products: readonly StepProduct[]): boolean {
  if (products.length === 0) return false;
  if (accepts.any) return true;
  const want = norm(accepts.extensions);
  return products.some((p) => norm(p.exts).some((e) => want.includes(e)));
}

/** Resolved products of the step at index (from Describe), [] when unknown. */
export function stepProducts(check: PipelineCheck | undefined, index: number): StepProduct[] {
  return check?.steps?.[index]?.info.produces ?? [];
}

/** The source a new step at `index` should read: the nearest earlier step it can read, else input / none. */
export function defaultFrom(
  steps: readonly PipelineStep[],
  check: PipelineCheck | undefined,
  index: number,
  accepts: Accepts,
  noFiles: boolean,
): string {
  for (let i = Math.min(index, steps.length) - 1; i >= 0; i--) {
    const s = steps[i];
    if (s && canRead(accepts, stepProducts(check, i))) return s.id;
  }
  if (accepts.urls || accepts.any || (accepts.extensions ?? []).length > 0) return FROM_INPUT;
  return noFiles ? FROM_NONE : FROM_INPUT;
}

/** Whether a step type reads anything available before `index` (the menu's ordering). */
export function compatibleAt(check: PipelineCheck | undefined, index: number, accepts: Accepts): boolean {
  for (let i = 0; i < index; i++) if (canRead(accepts, stepProducts(check, i))) return true;
  return false;
}

/** "audio & video files", "links", "images & PDFs" — what a run takes. */
export function describeAccepts(accepts: Accepts | undefined): string {
  if (!accepts) return "nothing yet";
  const kinds = new Set<string>();
  for (const e of accepts.extensions ?? []) kinds.add(kindLabel(e));
  const parts = [...kinds].filter(Boolean);
  if (accepts.any) parts.splice(0, parts.length, "any files");
  const files = parts.length > 0 ? `${parts.join(" & ")}${accepts.any ? "" : " files"}` : "";
  if (accepts.urls) return files ? `links or ${files}` : "links";
  return files || "nothing yet";
}

const KIND_BY_EXT: Record<string, string> = {};
for (const e of ["mp3", "wav", "flac", "m4a", "aac", "ogg", "opus", "aiff", "aif"]) KIND_BY_EXT[e] = "audio";
for (const e of ["mp4", "mov", "mkv", "webm", "m4v", "avi", "ts", "mts", "m2ts"]) KIND_BY_EXT[e] = "video";
for (const e of ["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "tif", "tiff", "bmp", "dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2"]) KIND_BY_EXT[e] = "image";
KIND_BY_EXT.pdf = "PDF";
for (const e of ["txt", "md", "srt", "vtt", "json", "csv", "lrc"]) KIND_BY_EXT[e] = "text";

function kindLabel(ext: string): string {
  return KIND_BY_EXT[extOf(`x${ext.startsWith(".") ? ext : `.${ext}`}`)] ?? "other";
}

/** OutputKind-ish label of a path, for input lists. */
export function kindOfPath(path: string): OutputKind | string {
  return KIND_BY_EXT[extOf(path)] ?? "other";
}
