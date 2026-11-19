/** Pure helpers of the Export dialog: output size, duration, and the pre-submit checks (§14.10). */
import type { EditClip, EditMatteRequest, EditMatteState, EditSourceState, EditExportSettings } from "@/lib/api";
import type { NormalProject } from "@/viz/edit/defaults";
import { editLength, sizeFor } from "@/viz/edit/types";
import { clipSourceSpan } from "@/editor/doc";

export const EXPORT_HEIGHTS = [720, 1080, 1440, 2160] as const;
export type ExportHeight = (typeof EXPORT_HEIGHTS)[number];

/** The height to show: the project's when it's one of the sizes, else 1080. */
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

// ---- export settings (Phase 21 SPEC §B6) ----

export const EXPORT_FPS = [0, 24, 25, 30, 60] as const;
export const EXPORT_CODECS = ["h264", "h265"] as const;
export const EXPORT_QUALITIES = ["draft", "good", "best"] as const;
export const EXPORT_AUDIO_KBPS = [128, 192, 320] as const;

export type ExportCodec = (typeof EXPORT_CODECS)[number];
export type ExportQuality = (typeof EXPORT_QUALITIES)[number];

/** H.264, good, project fps, 192 kb/s, whole edit (what a project without `export` means). */
export const DEFAULT_EXPORT: EditExportSettings = { fps: 0, codec: "h264", quality: "good", audioKbps: 192, inMs: 0, outMs: 0 };

const oneOf = <T extends string | number>(list: readonly T[], v: unknown, def: T): T => (list.includes(v as T) ? (v as T) : def);

/** Settings with every field one of its allowed values (anything else falls back to the default). */
export function normalizeExportSettings(e: Partial<EditExportSettings> | null | undefined): EditExportSettings {
  const inMs = Math.max(0, Math.round(e?.inMs ?? 0));
  const outMs = Math.max(0, Math.round(e?.outMs ?? 0));
  return {
    fps: oneOf(EXPORT_FPS, e?.fps, 0),
    codec: oneOf(EXPORT_CODECS, e?.codec, "h264"),
    quality: oneOf(EXPORT_QUALITIES, e?.quality, "good"),
    audioKbps: oneOf(EXPORT_AUDIO_KBPS, e?.audioKbps, 192),
    inMs: outMs > inMs ? inMs : 0,
    outMs: outMs > inMs ? outMs : 0,
  };
}

/** The In–Out range as the editor's store holds it (E3 adds `rangeInMs`/`rangeOutMs`); null when none is set. */
export function storeRange(s: unknown): { inMs: number; outMs: number } | null {
  const r = s as { rangeInMs?: number | null; rangeOutMs?: number | null };
  const a = r.rangeInMs;
  const b = r.rangeOutMs;
  if (typeof a !== "number" || typeof b !== "number" || !(b > a)) return null;
  return { inMs: a, outMs: b };
}

/** Video bit rate (kb/s) the encoder aims for at a size, frame rate, codec and quality (an estimate, not a promise). */
export function estimateVideoKbps(width: number, height: number, fps: number, codec: ExportCodec, quality: ExportQuality): number {
  const base = { draft: 2500, good: 6000, best: 12000 }[quality];
  const px = (width * height) / (1080 * 1920);
  const kbps = base * px * (Math.max(1, fps) / 30) ** 0.7;
  return codec === "h265" ? kbps * 0.65 : kbps;
}

/** The size of the file the export will roughly make, in bytes. */
export function estimateExportBytes(o: { aspect: string; height: number; fps: number; codec: ExportCodec; quality: ExportQuality; audioKbps: number; lengthMs: number }): number {
  const { width, height } = sizeFor(o.aspect, o.height);
  const kbps = estimateVideoKbps(width, height, o.fps, o.codec, o.quality) + o.audioKbps;
  return Math.round(((kbps * 1000) / 8) * (Math.max(0, o.lengthMs) / 1000));
}

/** "18 MB", "1.2 GB", "640 KB". */
export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e7) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}
