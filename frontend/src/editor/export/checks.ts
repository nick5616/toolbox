/** Pure helpers of the Export dialog: output size, duration, and the pre-submit checks (§14.10). */
import type { EditClip, EditMatteRequest, EditMatteState, EditSourceState } from "@/lib/api";
import type { NormalProject } from "@/viz/edit/defaults";
import { editLength, sizeFor } from "@/viz/edit/types";
import { clipSourceSpan } from "@/editor/doc";

export const EXPORT_HEIGHTS = [720, 1080, 1440] as const;
export type ExportHeight = (typeof EXPORT_HEIGHTS)[number];

/** The height to show: the project's when it's one of the three, else 1080. */
export function normalizeHeight(h: number): ExportHeight {
  return (EXPORT_HEIGHTS as readonly number[]).includes(h) ? (h as ExportHeight) : 1080;
}

/** "1080 × 1920". */
export function sizeLabel(aspect: string, short: number): string {
  const { width, height } = sizeFor(aspect, short);
  return `${width} × ${height}`;
}

/** "2:05" or "0:30" for a length in ms. */
export function formatLength(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Visible picture clips (video, photo) on non-muted video tracks, in track order. */
export function exportClips(p: NormalProject): EditClip[] {
  const d = editLength(p);
  const off = (p.cutOffsetFrames * 1000) / p.fps;
  const out: EditClip[] = [];
  for (const t of p.tracks) {
    if (t.muted || t.kind !== "video") continue;
    for (const c of t.clips) {
      if (c.startMs + off >= d || c.endMs + off <= 0) continue;
      out.push(c);
    }
  }
  return out;
}

export interface MissingFile {
  path: string;
  reason: string;
}

export interface ExportChecks {
  /** Visible clips that have a picture file. */
  clipCount: number;
  /** Sources still being prepared. */
  preparing: string[];
  /** Sources with no edit copy yet (not preparing; the export makes them itself). */
  unprepared: string[];
  missing: MissingFile[];
  /** Clips whose cut-out is not ready or out of date. */
  badMattes: EditClip[];
}

export const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

/** What stands in the way of an export, from the cached source and matte states. */
export function exportChecks(p: NormalProject, sources: Record<string, EditSourceState>, mattes: Record<string, EditMatteState>): ExportChecks {
  const clips = exportClips(p);
  const preparing = new Set<string>();
  const unprepared = new Set<string>();
  const missing = new Map<string, string>();
  const badMattes: EditClip[] = [];
  let clipCount = 0;
  for (const c of clips) {
    if (c.kind === "video" || c.kind === "image") {
      clipCount++;
      const s = sources[c.path];
      const err = s?.error || s?.info?.error;
      if (err) {
        missing.set(c.path, err);
      } else if (s?.preparing) {
        preparing.add(c.path);
      } else if (!s || (c.kind === "video" ? !s.preview : !s.image)) {
        unprepared.add(c.path);
      }
      if (c.matte && !mattes[c.matte.id]?.ready) badMattes.push(c);
    } else if (c.kind === "color") {
      clipCount++;
    }
  }
  return { clipCount, preparing: [...preparing], unprepared: [...unprepared], missing: [...missing].map(([path, reason]) => ({ path, reason })), badMattes };
}

/** The matte job request that rebuilds a clip's cut-out (same shape the Cut-out section submits). */
export function rebuildRequest(c: EditClip, fps: number): EditMatteRequest | null {
  const m = c.matte;
  if (!m || !c.path) return null;
  const image = m.mode === "image";
  const span = image ? { fromMs: 0, toMs: 0 } : clipSourceSpan(c, fps);
  return { clipId: c.id, matteId: m.id, mode: m.mode, path: c.path, fromMs: span.fromMs, toMs: span.toMs, clicks: m.clicks ?? [], preview: false };
}

/** The project without the cut-out of the given clips (their effects go back to the whole clip). One document, so one undo step. */
export function withoutCutouts(p: NormalProject, clipIds: ReadonlySet<string>): NormalProject {
  return {
    ...p,
    tracks: p.tracks.map((t) =>
      t.clips.some((c) => clipIds.has(c.id))
        ? { ...t, clips: t.clips.map((c) => (clipIds.has(c.id) ? { ...c, matte: null, fxTarget: "clip", auto: false } : c)) }
        : t,
    ),
  };
}
