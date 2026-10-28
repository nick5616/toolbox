import { BgModel, BgOutput, type BgRemoveOptions } from "@/lib/api";
import { basename, num, parseJson, str } from "../image/common";
import type { ResultItem } from "../image/ResultCards";
import type { JobView } from "@/state/jobs";

/** Mirrors Go's DefaultOptions() (modules/bgremove). */
export const DEFAULT_BG_OPTIONS: BgRemoveOptions = {
  model: BgModel.ModelBalanced,
  output: BgOutput.OutputTransparent,
  color: "#ffffff",
  crop: false,
  padding: 24,
  cleanEdges: true,
  refine: false,
};

function oneOf<T extends string>(enumObj: Record<string, T>, v: unknown): T | undefined {
  return typeof v === "string" && v !== "" && Object.values(enumObj).includes(v as T) ? (v as T) : undefined;
}

/** `sanitize` for useModuleOptions: keeps only valid fields over defaults. */
export function sanitizeBgOptions(raw: unknown, defaults: BgRemoveOptions): BgRemoveOptions {
  const out: BgRemoveOptions = { ...defaults };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  out.model = oneOf(BgModel, r.model) ?? out.model;
  out.output = oneOf(BgOutput, r.output) ?? out.output;
  if (typeof r.color === "string" && /^#[0-9a-fA-F]{6}$/.test(r.color)) out.color = r.color.toLowerCase();
  if (typeof r.crop === "boolean") out.crop = r.crop;
  if (typeof r.padding === "number" && r.padding >= 0 && r.padding <= 500) out.padding = Math.round(r.padding);
  if (typeof r.cleanEdges === "boolean") out.cleanEdges = r.cleanEdges;
  if (typeof r.refine === "boolean") out.refine = r.refine;
  return out;
}

/** Options as submitted: the colour only matters (and is only sent meaningfully) for the colour output. */
export function submitOptions(o: BgRemoveOptions): BgRemoveOptions {
  return o.output === BgOutput.OutputColor ? o : { ...o, color: DEFAULT_BG_OPTIONS.color };
}

/** Result card for a finished job; null when the result is missing. */
export function toResultItem(job: JobView): ResultItem | null {
  const r = parseJson(job.resultJson);
  const output = r ? str(r.output) : "";
  const original = job.inputs[0];
  if (!r || !output || !original) return null;
  const w = num(r.width);
  const h = num(r.height);
  const cov = num(r.subjectCoverage);
  const meta = [w && h ? `${w}×${h}` : "", cov > 0 ? `subject ${Math.round(cov * 100)}%` : "no clear subject"]
    .filter(Boolean)
    .join(" · ");
  const out = job.outputs.find((o) => o.path === output);
  return {
    id: job.id,
    original,
    output,
    outputId: out?.id,
    missing: out?.missing,
    title: basename(output),
    meta,
    aspect: w > 0 && h > 0 ? w / h : 4 / 3,
    checkerboard: str(parseJson(job.optionsJson)?.output) === BgOutput.OutputTransparent,
    afterLabel: "Cutout",
  };
}
