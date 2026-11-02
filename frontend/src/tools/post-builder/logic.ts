import type { Post, PostIssue, PostLimits, PostSlide, PostSlideSource } from "@/lib/api";

/** A post whose slides are always an array. */
export type PostDoc = Omit<Post, "slides"> & { slides: PostSlide[] };

export type PostFormat = "carousel" | "reel" | "story";

/** Instagram's limits as of SPEC Part B §B0.1; replaced by PostsService.Limits() when it loads. */
export const DEFAULT_LIMITS: PostLimits = {
  maxSlides: 20,
  maxClipMs: 60_000,
  maxReelMs: 180_000,
  maxCaptionChars: 2200,
  maxHashtags: 30,
  maxMentions: 20,
  minWidth: 1080,
  frameWidth: 1080,
  maxAltTextChars: 1000,
};

/**
 * The project id a composition/video slide carries until its editor has saved
 * a project and linked it. PostsService.Save refuses an empty id, and Check
 * reports this one as a missing project, which blocks Export.
 */
export const PENDING_PROJECT = "pending";

export const CAROUSEL_ASPECTS = [
  { value: "4:5", label: "4:5 (1080 × 1350)" },
  { value: "1:1", label: "1:1 (1080 × 1080)" },
  { value: "3:4", label: "3:4 (new — check the app)" },
  { value: "1.91:1", label: "1.91:1 (1080 × 566)" },
] as const;

export const FORMAT_LABELS: Record<PostFormat, string> = { carousel: "Carousel", reel: "Reel", story: "Story" };

export function aspectFor(format: string, current: string): string {
  if (format === "reel" || format === "story") return "9:16";
  return CAROUSEL_ASPECTS.some((a) => a.value === current) ? current : "4:5";
}

export function normalizePost(p: Post): PostDoc {
  return { ...p, slides: (p.slides ?? []).map((s) => ({ ...s })) };
}

export function isPending(s: PostSlide): boolean {
  return (s.kind === "composition" || s.kind === "video") && (s.projectId === "" || s.projectId === PENDING_PROJECT);
}

let counter = 0;
/** A slide id that is unique within a post (the Go side only requires non-empty + unique). */
export function newSlideId(): string {
  counter++;
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
      : Math.random().toString(36).slice(2, 10) + counter.toString(36);
  return `s${rand}`;
}

export function maxClipMs(limits: PostLimits, format: string): number {
  return format === "reel" ? limits.maxReelMs : limits.maxClipMs;
}

/** Slides from probed files: photos and clips only; others are dropped. */
export function slidesFromSources(sources: PostSlideSource[], format: string, limits: PostLimits): { slides: PostSlide[]; skipped: number } {
  const slides: PostSlide[] = [];
  let skipped = 0;
  for (const src of sources) {
    if (src.error || (src.kind !== "photo" && src.kind !== "clip")) {
      skipped++;
      continue;
    }
    const s = blankSlide(src.kind, { path: src.path });
    if (src.kind === "clip") s.outMs = Math.max(1, Math.min(src.durationMs, maxClipMs(limits, format)));
    slides.push(s);
  }
  return { slides, skipped };
}

export function blankSlide(kind: PostSlide["kind"], extra: Partial<PostSlide> = {}): PostSlide {
  return {
    id: newSlideId(),
    kind,
    path: "",
    projectId: "",
    panX: 0,
    panY: 0,
    zoom: 1,
    rotation: 0,
    inMs: 0,
    outMs: 0,
    mute: false,
    altText: "",
    ...extra,
  };
}

/** How many slides can still be added. */
export function roomLeft(doc: PostDoc, limits: PostLimits): number {
  if (doc.format === "reel") return Math.max(0, 1 - doc.slides.length);
  return Math.max(0, limits.maxSlides - doc.slides.length);
}

/** Moves the slide at `from` so it ends up at index `to`. */
export function reorder<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return list.slice();
  const t = Math.min(Math.max(to, 0), list.length - 1);
  const out = list.slice();
  const [item] = out.splice(from, 1);
  out.splice(t, 0, item as T);
  return out;
}

/** The index of the tile whose centre is nearest to y (tile centres top to bottom). */
export function indexAtY(centers: readonly number[], y: number): number {
  let best = 0;
  let bestD = Infinity;
  centers.forEach((c, i) => {
    const d = Math.abs(c - y);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

export function duplicateSlide(s: PostSlide): PostSlide {
  return { ...s, id: newSlideId() };
}

// Same patterns as modules/posts/check.go.
const HASHTAG_RE = /#[\p{L}\p{N}_]+/gu;
const MENTION_RE = /(?:^|[^\p{L}\p{N}_.])@[A-Za-z0-9._]+/gu;

export function countChars(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}
export function countHashtags(text: string): number {
  return text.match(HASHTAG_RE)?.length ?? 0;
}
export function countMentions(text: string): number {
  return text.match(MENTION_RE)?.length ?? 0;
}

export interface CaptionStats {
  chars: number;
  left: number;
  hashtags: number;
  mentions: number;
}
export function captionStats(caption: string, limits: PostLimits): CaptionStats {
  const chars = countChars(caption);
  return { chars, left: limits.maxCaptionChars - chars, hashtags: countHashtags(caption), mentions: countMentions(caption) };
}

/** Issue levels for a slide: the worst one wins. */
export function worstLevel(issues: readonly PostIssue[]): "error" | "warning" | "note" | "" {
  if (issues.some((i) => i.level === "error")) return "error";
  if (issues.some((i) => i.level === "warning")) return "warning";
  if (issues.some((i) => i.level === "note")) return "note";
  return "";
}

export function issuesBySlide(issues: readonly PostIssue[]): Map<string, PostIssue[]> {
  const m = new Map<string, PostIssue[]>();
  for (const i of issues) {
    if (!i.slideId) continue;
    const list = m.get(i.slideId);
    if (list) list.push(i);
    else m.set(i.slideId, [i]);
  }
  return m;
}

export function firstError(issues: readonly PostIssue[]): PostIssue | undefined {
  return issues.find((i) => i.level === "error");
}

/** The post as saved to disk: nothing to strip today, but one place to change it. */
export function docForSave(doc: PostDoc): Post {
  return { ...doc, slides: doc.slides };
}

/** "Instagram truncates a caption after about this many characters in the feed." */
export const PREVIEW_CAPTION_CHARS = 125;

export function truncateCaption(caption: string, max = PREVIEW_CAPTION_CHARS): { text: string; truncated: boolean } {
  const chars = Array.from(caption);
  if (chars.length <= max) return { text: caption, truncated: false };
  return { text: chars.slice(0, max).join("").trimEnd(), truncated: true };
}

export function defaultPostName(format: string, now = new Date()): string {
  const label = FORMAT_LABELS[format as PostFormat] ?? "Post";
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `${label} ${d}`;
}

/** Saved UI state of the tool. */
export interface PostBuilderState {
  lastPostId: string;
  /** Last export folder by post id. */
  exports: Record<string, string>;
}

export function sanitizeState(saved: unknown): PostBuilderState {
  const out: PostBuilderState = { lastPostId: "", exports: {} };
  if (typeof saved !== "object" || saved === null) return out;
  const r = saved as Record<string, unknown>;
  if (typeof r.lastPostId === "string") out.lastPostId = r.lastPostId;
  if (typeof r.exports === "object" && r.exports !== null) {
    for (const [k, v] of Object.entries(r.exports as Record<string, unknown>)) if (typeof v === "string") out.exports[k] = v;
  }
  return out;
}
