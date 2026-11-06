import { CompressGrade, CompressImageFormat, CompressKind, CompressTooSmall, CompressVideoCodec } from "@/lib/api";
import type { CompressEstimate, CompressOptions, CompressTarget } from "@/lib/api";
import { num, parseJson, str } from "@/tools/_kit/image/common";

/** Mirrors Go's DefaultOptions() (modules/compress). */
export const DEFAULT_COMPRESS_OPTIONS: CompressOptions = {
  targetId: "discord",
  targetMb: 20,
  ifTooSmall: CompressTooSmall.TooSmallLower,
  videoCodec: CompressVideoCodec.CodecH264,
  maxHeight: 0,
  keepAudio: true,
  imageFormat: CompressImageFormat.ImageAuto,
  keepMetadata: false,
};

export const CUSTOM_TARGET = "custom";
export const COMPRESS_LIMITS = { targetMb: { min: 0.05, max: 100_000 } } as const;
export const MAX_HEIGHTS = [0, 2160, 1440, 1080, 720, 480, 360] as const;

export const TOO_SMALL_CHOICES = [
  { value: CompressTooSmall.TooSmallLower, label: "Lower the quality" },
  { value: CompressTooSmall.TooSmallSplit, label: "Split into parts" },
] as const;
export const CODEC_CHOICES = [
  { value: CompressVideoCodec.CodecH264, label: "H.264 — plays everywhere" },
  { value: CompressVideoCodec.CodecH265, label: "H.265 — smaller, plays in fewer places" },
] as const;
export const IMAGE_FORMAT_CHOICES = [
  { value: CompressImageFormat.ImageAuto, label: "Auto" },
  { value: CompressImageFormat.ImageJPEG, label: "JPEG" },
  { value: CompressImageFormat.ImageWebP, label: "WebP" },
  { value: CompressImageFormat.ImageKeep, label: "Keep" },
] as const;

export function maxHeightLabel(h: number): string {
  return h === 0 ? "Auto" : `${h}p`;
}

/** The targets of modules/compress/targets.go (id, label), for the step editor and its parameters (the view loads the live list). */
export const STATIC_TARGETS: ReadonlyArray<readonly [id: string, label: string]> = [
  ["discord", "Discord (20 MB)"],
  ["discord-basic", "Discord Nitro Basic (50 MB)"],
  ["discord-nitro", "Discord Nitro (500 MB)"],
  ["whatsapp", "WhatsApp (16 MB)"],
  ["signal", "Signal (100 MB)"],
  ["imessage", "iMessage (100 MB)"],
  ["telegram", "Telegram (2 GB)"],
  ["slack", "Slack (1 GB)"],
  ["mms", "Text message (1 MB)"],
  ["gmail", "Gmail (18 MB)"],
  ["outlook", "Outlook (14 MB)"],
  ["icloud-mail", "iCloud Mail (14 MB)"],
  ["bluesky-image", "Bluesky photo (2 MB)"],
  ["bluesky-video", "Bluesky video (300 MB)"],
  ["x-image", "X photo (5 MB)"],
  ["x-video", "X video (512 MB)"],
  ["mastodon-image", "Mastodon photo (16 MB)"],
  ["mastodon-video", "Mastodon video (99 MB)"],
  ["reddit-image", "Reddit photo (20 MB)"],
  ["github-image", "GitHub image (10 MB)"],
  ["github-video", "GitHub video (10 MB)"],
  ["github-file", "GitHub file (25 MB)"],
  ["floppy", "Floppy disk (1.44 MB)"],
  [CUSTOM_TARGET, "Custom size"],
];

function oneOf<T extends string>(v: unknown, allowed: readonly T[], d: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : d;
}

/** `sanitize` for useModuleOptions and the step editor: valid fields over the defaults. */
export function sanitizeCompressOptions(raw: unknown, defaults: CompressOptions): CompressOptions {
  const out = { ...defaults };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.targetId === "string" && r.targetId.trim() !== "") out.targetId = r.targetId;
  if (typeof r.targetMb === "number" && Number.isFinite(r.targetMb)) {
    out.targetMb = Math.min(COMPRESS_LIMITS.targetMb.max, Math.max(COMPRESS_LIMITS.targetMb.min, r.targetMb));
  }
  out.ifTooSmall = oneOf(r.ifTooSmall, [CompressTooSmall.TooSmallLower, CompressTooSmall.TooSmallSplit], out.ifTooSmall);
  out.videoCodec = oneOf(r.videoCodec, [CompressVideoCodec.CodecH264, CompressVideoCodec.CodecH265], out.videoCodec);
  if (typeof r.maxHeight === "number" && (MAX_HEIGHTS as readonly number[]).includes(r.maxHeight)) out.maxHeight = r.maxHeight;
  if (typeof r.keepAudio === "boolean") out.keepAudio = r.keepAudio;
  out.imageFormat = oneOf(
    r.imageFormat,
    [CompressImageFormat.ImageAuto, CompressImageFormat.ImageJPEG, CompressImageFormat.ImageWebP, CompressImageFormat.ImageKeep],
    out.imageFormat,
  );
  if (typeof r.keepMetadata === "boolean") out.keepMetadata = r.keepMetadata;
  return out;
}

/** Decimal units matching Go's FormatBytes: 512 B, 850 KB, 12.4 MB, 512 MB, 1.25 GB. */
export function formatBytes(n: number): string {
  const trim = (v: number, digits: number) => String(Number(v.toFixed(digits)));
  if (n < 1000) return `${Math.max(0, Math.round(n))} B`;
  if (n < 1_000_000) return `${trim(n / 1000, 0)} KB`;
  if (n < 1_000_000_000) return `${trim(n / 1_000_000, n >= 100_000_000 ? 0 : 1)} MB`;
  return `${trim(n / 1_000_000_000, 2)} GB`;
}

/** "Chat · Discord — 20 MB" for the picker. */
export function targetLabel(t: CompressTarget): string {
  return `${t.group} · ${t.label} — ${formatBytes(t.bytes)}`;
}

export const GRADE_LABELS: Record<string, string> = {
  [CompressGrade.GradeGreat]: "Great",
  [CompressGrade.GradeGood]: "Good",
  [CompressGrade.GradeFair]: "Fair",
  [CompressGrade.GradePoor]: "Poor",
};

export const GRADE_TIPS: Record<string, string> = {
  [CompressGrade.GradeGreat]: "Looks (or sounds) almost the same as the original",
  [CompressGrade.GradeGood]: "A small, hard-to-notice loss of quality",
  [CompressGrade.GradeFair]: "Visibly softer, still fine for sharing",
  [CompressGrade.GradePoor]: "Heavily reduced to fit; consider splitting into parts or a larger target",
};

/** True when a kind can be split into parts. */
export function canSplit(kind: string): boolean {
  return kind === CompressKind.KindVideo || kind === CompressKind.KindAudio;
}

/** The one-line summary of the estimates ("4 files · 2 already fit · 1 can't fit"). */
export function estimateTotals(list: readonly CompressEstimate[]): string {
  const fit = list.filter((e) => e.alreadyFits).length;
  const cant = list.filter((e) => !e.alreadyFits && !e.possible).length;
  const parts = [`${list.length} ${list.length === 1 ? "file" : "files"}`];
  if (fit > 0) parts.push(`${fit} already fit`);
  if (cant > 0) parts.push(`${cant} can't fit`);
  return parts.join(" · ");
}

/** What an estimate row says about the size. */
export function sizeLine(e: Pick<CompressEstimate, "alreadyFits" | "originalBytes" | "limitBytes">): string {
  return e.alreadyFits ? "Already fits" : `${formatBytes(e.originalBytes)} → under ${formatBytes(e.limitBytes)}`;
}

/** What a row says when the file can't get under the limit (empty when it can). */
export function cantFitLine(e: Pick<CompressEstimate, "possible" | "alreadyFits" | "kind" | "problem"> & { note?: string }, ifTooSmall: string): string {
  if (e.possible || e.alreadyFits || e.problem) return "";
  if (ifTooSmall === CompressTooSmall.TooSmallLower && canSplit(e.kind)) return "Can't fit — try Split into parts";
  return e.note ? `Can't fit — ${e.note}` : "Can't fit";
}

/** The Advanced summary parts: "Lower quality · H.264 · auto size". */
export function advancedSummaryParts(o: CompressOptions): string[] {
  return [
    o.ifTooSmall === CompressTooSmall.TooSmallSplit ? "Split into parts" : "Lower quality",
    o.videoCodec === CompressVideoCodec.CodecH265 ? "H.265" : "H.264",
    o.maxHeight === 0 ? "auto size" : `up to ${o.maxHeight}p`,
    !o.keepAudio ? "no sound" : "",
    o.keepMetadata ? "keeps location data" : "",
  ].filter((s) => s !== "");
}

/** One output file of a finished compression. */
export interface CompressedFile {
  path: string;
  /** 1-based part number and the part count. */
  part: number;
  parts: number;
  input: string;
  originalBytes: number;
  /** The largest output of the whole result. */
  finalBytes: number;
  limitBytes: number;
  fits: boolean;
  alreadyFit: boolean;
  plan: string;
  grade: string;
}

/** The outputs of a job's resultJson, one entry per output file (parts in order). */
export function parseCompressResult(json: string | null | undefined): CompressedFile[] {
  const r = parseJson(json);
  if (!r || !Array.isArray(r.outputs)) return [];
  const outputs = r.outputs.filter((o): o is string => typeof o === "string" && o !== "");
  return outputs.map((path, i) => ({
    path,
    part: i + 1,
    parts: outputs.length,
    input: str(r.input),
    originalBytes: num(r.originalBytes),
    finalBytes: num(r.finalBytes),
    limitBytes: num(r.limitBytes),
    fits: r.fits === true,
    alreadyFit: r.alreadyFit === true,
    plan: str(r.plan),
    grade: str(r.grade),
  }));
}

/** Debounce key for estimates. */
export function estimateKey(paths: readonly string[], o: CompressOptions): string {
  return JSON.stringify([paths, o]);
}

/** Fill of the result bar, 0..1 (full = the limit). */
export function fillFraction(finalBytes: number, limitBytes: number): number {
  return limitBytes > 0 ? Math.min(1, Math.max(0, finalBytes / limitBytes)) : 0;
}
