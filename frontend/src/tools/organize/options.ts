import { OrganizeDupAction, OrganizeDupMode, OrganizeGroupBy, type OrganizeOptions, type OrganizePreviewFolder } from "@/lib/api";

export const MODULE_ID = "organize";

/** Mirrors Go's DefaultOptions() (modules/organize). */
export const DEFAULT_ORGANIZE_OPTIONS: OrganizeOptions = {
  groupBy: OrganizeGroupBy.GroupDate,
  pattern: "{yyyy}/{mm}/{type}",
  duplicates: OrganizeDupMode.DupExact,
  similarity: 90,
  dupAction: OrganizeDupAction.ActionFolder,
  destination: "",
  runName: "",
};

export const MIN_SIMILARITY = 70;
export const MAX_SIMILARITY = 99;

export const GROUP_OPTIONS = [
  { value: OrganizeGroupBy.GroupDate, label: "Date taken", tip: "Folders by year and month, from the photo's date (or the file's modified date)" },
  { value: OrganizeGroupBy.GroupType, label: "Type", tip: "Photos, Videos, Audio, Documents and Other" },
  { value: OrganizeGroupBy.GroupCamera, label: "Camera", tip: "One folder per camera make and model" },
  { value: OrganizeGroupBy.GroupPattern, label: "Pattern", tip: "Your own folder layout, like {yyyy}/{mm}/{type}" },
] as const;

export const DUPLICATE_OPTIONS = [
  { value: OrganizeDupMode.DupOff, label: "Off", tip: "Copy everything, even identical files" },
  { value: OrganizeDupMode.DupExact, label: "Exact", tip: "Files with identical content" },
  { value: OrganizeDupMode.DupSimilar, label: "Look-alike", tip: "Identical files, and photos that look the same (resized or re-saved)" },
] as const;

export const ACTION_OPTIONS = [
  { value: OrganizeDupAction.ActionFolder, label: "Put in a Duplicates folder" },
  { value: OrganizeDupAction.ActionSkip, label: "Leave them out" },
];

/** The pattern tokens, for the hint text. */
export const PATTERN_TOKENS = ["{yyyy}", "{mm}", "{dd}", "{type}", "{camera}", "{ext}"];
const TOKEN_NAMES = new Set(["yyyy", "mm", "dd", "type", "camera", "ext"]);

/** "" when the pattern is usable, else the reason (mirrors Go's validatePattern). */
export function patternProblem(p: string): string {
  if (p.trim() === "") return "Write a folder pattern, like {yyyy}/{mm}";
  for (const m of p.matchAll(/\{([^{}]*)\}/g)) {
    const name = m[1] ?? "";
    if (!TOKEN_NAMES.has(name)) return `{${name}} isn't something the pattern can use. Use ${PATTERN_TOKENS.join(" ")}`;
  }
  if (/[{}]/.test(p.replace(/\{[^{}]*\}/g, ""))) return "Unmatched { or } in the pattern";
  if (/^[\\/]/.test(p) || p.includes(":")) return "The pattern is a path inside the result folder, not a full path";
  const segs = p.split(/[\\/]/).map((s) => s.trim()).filter(Boolean);
  if (segs.length === 0) return "Write a folder pattern, like {yyyy}/{mm}";
  if (segs.length > 6) return "Use at most 6 folder levels";
  if (segs.some((s) => s === "." || s === "..")) return "A pattern can't use . or ..";
  return "";
}

export const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

/** `sanitize` for useModuleOptions and the step editor. Never throws. */
export function sanitizeOrganizeOptions(raw: unknown, defaults: OrganizeOptions = DEFAULT_ORGANIZE_OPTIONS): OrganizeOptions {
  const out: OrganizeOptions = { ...defaults };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  const groups: string[] = GROUP_OPTIONS.map((g) => g.value);
  if (typeof r.groupBy === "string" && groups.includes(r.groupBy)) out.groupBy = r.groupBy as OrganizeGroupBy;
  if (typeof r.pattern === "string") out.pattern = r.pattern;
  const dups: string[] = DUPLICATE_OPTIONS.map((d) => d.value);
  if (typeof r.duplicates === "string" && dups.includes(r.duplicates)) out.duplicates = r.duplicates as OrganizeDupMode;
  if (typeof r.similarity === "number" && Number.isInteger(r.similarity) && r.similarity >= MIN_SIMILARITY && r.similarity <= MAX_SIMILARITY) out.similarity = r.similarity;
  if (r.dupAction === OrganizeDupAction.ActionFolder || r.dupAction === OrganizeDupAction.ActionSkip) out.dupAction = r.dupAction;
  if (typeof r.destination === "string") out.destination = r.destination;
  if (typeof r.runName === "string") out.runName = r.runName;
  return out;
}

/** One line for the step card and the Advanced click-in. */
export function describeOptions(o: OrganizeOptions): string {
  const group =
    o.groupBy === OrganizeGroupBy.GroupType ? "By type" : o.groupBy === OrganizeGroupBy.GroupCamera ? "By camera" : o.groupBy === OrganizeGroupBy.GroupPattern ? `Pattern ${o.pattern}` : "By date taken";
  return [group, duplicatesText(o)].filter(Boolean).join(" · ");
}

export function duplicatesText(o: OrganizeOptions): string {
  if (o.duplicates === OrganizeDupMode.DupOff) return "duplicates not checked";
  const what = o.duplicates === OrganizeDupMode.DupExact ? "exact duplicates" : `look-alikes (${o.similarity}%)`;
  return `${what} ${o.dupAction === OrganizeDupAction.ActionSkip ? "left out" : "set aside"}`;
}

/** Parts of the Advanced click-in's one-line summary. */
export function advancedSummaryParts(o: OrganizeOptions): Array<string | false> {
  return [
    o.groupBy === OrganizeGroupBy.GroupPattern && o.pattern,
    duplicatesText(o),
    o.destination !== "" && `to ${baseName(o.destination)}`,
  ];
}

export interface TreeRow {
  /** Full path of the folder, "" = the result folder itself. */
  path: string;
  /** Last segment ("(result folder)" for the root). */
  name: string;
  depth: number;
  /** Files directly in or below this folder. */
  count: number;
}

/** Turns the flat planned folders into indented rows with counts that include sub-folders. */
export function buildTree(folders: readonly OrganizePreviewFolder[]): TreeRow[] {
  const counts = new Map<string, number>();
  for (const f of folders) {
    const segs = f.path === "" ? [] : f.path.split("/");
    for (let i = 0; i <= segs.length; i++) {
      const p = segs.slice(0, i).join("/");
      counts.set(p, (counts.get(p) ?? 0) + f.count);
    }
  }
  const paths = [...counts.keys()].filter((p) => p !== "").sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rows: TreeRow[] = paths.map((p) => {
    const segs = p.split("/");
    return { path: p, name: segs[segs.length - 1] ?? p, depth: segs.length, count: counts.get(p) ?? 0 };
  });
  const rootOnly = folders.filter((f) => f.path === "").reduce((n, f) => n + f.count, 0);
  return rootOnly > 0 ? [{ path: "", name: "Result folder", depth: 0, count: rootOnly }, ...rows] : rows;
}

/** The job result the Organizer reports (Go's Summary). */
export interface OrganizeSummary {
  root: string;
  report: string;
  copied: number;
  duplicates: number;
  skipped: number;
  failed: number;
  folders: number;
}

export function parseSummary(json: string): OrganizeSummary | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== "object" || v === null) return null;
    const r = v as Record<string, unknown>;
    const n = (x: unknown) => (typeof x === "number" ? x : 0);
    if (typeof r.root !== "string") return null;
    return {
      root: r.root,
      report: typeof r.report === "string" ? r.report : "",
      copied: n(r.copied),
      duplicates: n(r.duplicates),
      skipped: n(r.skipped),
      failed: n(r.failed),
      folders: n(r.folders),
    };
  } catch {
    return null;
  }
}

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif"]);

/** Whether FilesService.ImageThumb is worth asking for. */
export function isThumbable(path: string): boolean {
  const base = baseName(path);
  const i = base.lastIndexOf(".");
  return i > 0 && IMAGE_EXTS.has(base.slice(i).toLowerCase());
}
