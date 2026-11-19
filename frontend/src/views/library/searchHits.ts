import type { LibraryProject, MediaText, SearchStatus } from "@/lib/api";
import { fromOutput, type HitInfo, type LibItem } from "./items";
import { baseOf } from "./items";
import { hitKey, type HitView } from "@/state/search";

/** The pure parts of Smart search's Library UI: snippets, badges, strengths, hit items and the status line. */

const MARK_OPEN = "\u0002";
const MARK_CLOSE = "\u0003";

export interface SnippetPart {
  text: string;
  bold: boolean;
}

/**
 * Splits a snippet at the `\u0002…\u0003` markers into plain and bold parts.
 * The result is only ever rendered as React text (never as HTML), so anything
 * the file said stays text. Stray or unbalanced markers are dropped.
 */
export function splitSnippet(s: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let bold = false;
  let buf = "";
  const flush = () => {
    if (buf) parts.push({ text: buf, bold });
    buf = "";
  };
  for (const ch of s) {
    if (ch === MARK_OPEN) {
      flush();
      bold = true;
    } else if (ch === MARK_CLOSE) {
      flush();
      bold = false;
    } else buf += ch;
  }
  flush();
  return parts;
}

/** Splits free text around the (case-insensitive) search words, for highlighting in the text panel. */
export function highlightParts(text: string, query: string): SnippetPart[] {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((w) => w.length > 0).sort((a, b) => b.length - a.length);
  if (words.length === 0 || text === "") return [{ text, bold: false }];
  const lower = text.toLowerCase();
  // Lower-casing can change length for a few scripts; fall back to no highlight then.
  if (lower.length !== text.length) return [{ text, bold: false }];
  const parts: SnippetPart[] = [];
  let i = 0;
  let plain = "";
  while (i < text.length) {
    const w = words.find((x) => lower.startsWith(x, i));
    if (w) {
      if (plain) parts.push({ text: plain, bold: false });
      plain = "";
      parts.push({ text: text.slice(i, i + w.length), bold: true });
      i += w.length;
    } else {
      plain += text[i];
      i++;
    }
  }
  if (plain) parts.push({ text: plain, bold: false });
  return parts;
}

export interface StrengthInfo {
  /** "strong" | "good" | "maybe" for concept/text hits; "" for label and name hits (no dot). */
  level: "strong" | "good" | "maybe" | "";
  label: string;
  tip: string;
}

export function strengthInfo(h: Pick<HitInfo, "strength" | "score">): StrengthInfo {
  const pct = `${Math.round(h.score * 100)}%`;
  switch (h.strength) {
    case "strong":
      return { level: "strong", label: "Strong", tip: `Strong match (${pct})` };
    case "good":
      return { level: "good", label: "Good", tip: `Good match (${pct})` };
    case "maybe":
      return { level: "maybe", label: "Maybe", tip: `Possible match (${pct})` };
    default:
      return { level: "", label: "", tip: "" };
  }
}

export interface SourceInfo {
  via: string;
  icon: string;
  tip: string;
}

/** Where a text hit was found: picture text, a document, speech. Concept/label/name hits have no source icon. */
export function sourceIcons(via: readonly string[]): SourceInfo[] {
  const out: SourceInfo[] = [];
  const seen = new Set<string>();
  for (const v of via) {
    let info: SourceInfo | null = null;
    if (v === "ocr") info = { via: "ocr", icon: "scan-text", tip: "Found in the text of the picture" };
    else if (v === "pdf" || v === "doc") info = { via: "doc", icon: "file-text", tip: "Found in the text of the document" };
    else if (v === "speech") info = { via: "speech", icon: "mic", tip: "Found in what is said" };
    else if (v === "subs") info = { via: "speech", icon: "captions", tip: "Found in the subtitles" };
    else if (v === "caption") info = { via: "caption", icon: "sparkles", tip: "Found in the caption Toolbox wrote" };
    if (info && !seen.has(info.via)) {
      seen.add(info.via);
      out.push(info);
    }
  }
  return out;
}

/** `m:ss` (or `h:mm:ss`) for a position in ms. */
export function formatMoment(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export interface PosBadge {
  text: string;
  tip: string;
}

/** The time badge for video/audio hits and "p. N" for pages (Pos is 0-based). "" when the hit has no position. */
export function posBadge(kind: string, ext: string, pos: number): PosBadge | null {
  if (pos < 0) return null;
  if (ext === "pdf" || ext === "pptx" || ext === "odp" || kind === "document") {
    const slides = ext === "pptx" || ext === "odp";
    return { text: slides ? `slide ${pos + 1}` : `p. ${pos + 1}`, tip: slides ? `Slide ${pos + 1}` : `Page ${pos + 1}` };
  }
  if (kind === "video" || kind === "audio") return { text: formatMoment(pos), tip: `At ${formatMoment(pos)}` };
  return null;
}

/** The hit as the Library's item type. Projects have no output: they carry their id. */
export function hitToItem(h: HitView, projects: readonly LibraryProject[]): LibItem {
  const info: HitInfo = {
    strength: h.strength,
    score: h.score,
    via: h.via,
    snippet: h.snippet,
    pos: h.pos,
    moments: h.moments,
    projectId: h.source === "project" ? h.projectId : "",
  };
  if (h.output) return { ...fromOutput(h.output), hit: info };
  if (h.source === "project") {
    const p = projects.find((x) => x.id === h.projectId);
    return {
      key: hitKey(h),
      path: h.path,
      name: p?.name ?? "Project",
      kind: h.kind,
      sizeBytes: 0,
      at: p?.updatedAt ?? 0,
      moduleId: p?.moduleId ?? "",
      outputId: "",
      registered: false,
      missing: false,
      isDir: false,
      rel: "",
      hit: info,
    };
  }
  return {
    key: hitKey(h),
    path: h.path,
    name: baseOf(h.path),
    kind: h.kind,
    sizeBytes: 0,
    at: 0,
    moduleId: "",
    outputId: "",
    registered: false,
    missing: false,
    isDir: false,
    rel: "",
    hit: info,
  };
}

/** A transcript line's `[m:ss]` stamp. */
export function stamp(ms: number): string {
  return `[${formatMoment(ms)}]`;
}

/** The text of a source's chunks as one block, with `[m:ss]` on speech lines. */
export function textBlock(chunks: readonly MediaText[], stamps: boolean): string {
  return chunks.map((c) => (stamps && c.pos >= 0 ? `${stamp(c.pos)} ${c.text}` : c.text)).join("\n");
}

export const SOURCE_TITLES: Record<string, string> = {
  ocr: "Text in the picture",
  pdf: "Text of the document",
  doc: "Text of the document",
  speech: "What is said",
  subs: "Subtitles",
  caption: "Caption",
};

export type StatusTone = "idle" | "busy" | "paused" | "waiting" | "problem" | "off";

export interface StatusLine {
  text: string;
  tone: StatusTone;
  /** "resume" shows a Resume action inside the line. */
  action?: "resume" | "failures";
}

const num = (n: number): string => n.toLocaleString("en-US");

/** The one-line status (SPEC §1.1) for a status snapshot. Not-installed has its own gate. */
export function statusLine(s: SearchStatus): StatusLine {
  if (!s.installed) return { text: "Not installed", tone: "off" };
  if (!s.enabled) return { text: "Indexing is off", tone: "off" };
  if (s.paused) return { text: "Paused", tone: "paused", action: "resume" };
  if (s.waiting) return { text: "Waiting for your jobs to finish", tone: "waiting" };
  if (s.stage === "pictures" && s.pending > 0) return { text: `Indexing pictures ${num(s.done)} of ${num(s.total)}`, tone: "busy" };
  if (s.stage === "text" && s.pending > 0) return { text: `Reading text ${num(s.done)} of ${num(s.total)}`, tone: "busy" };
  if (s.stage === "speech" && s.speechPending > 0) {
    const cur = s.current ? ` (${baseOf(s.current)})` : "";
    return { text: `Transcribing ${num(s.speechDone)} of ${num(s.speechDone + s.speechPending)}${cur}`, tone: "busy" };
  }
  if (s.pending > 0) return { text: `Indexing ${num(s.done)} of ${num(s.total)}`, tone: "busy" };
  if (s.failed > 0) return { text: `${num(s.failed)} ${s.failed === 1 ? "file" : "files"} couldn't be indexed`, tone: "problem", action: "failures" };
  return { text: `Up to date · ${num(s.total)} ${s.total === 1 ? "file" : "files"}`, tone: "idle" };
}
