/**
 * The Phase 21 editing operations (SPEC §B2): ripple delete, close gap, ripple
 * trim, roll, slip, the clipboard, links and detached audio, audio clips and
 * edit-point navigation. Pure, like ops.ts: each takes a NormalProject and
 * returns a new one, or null when nothing would change. Times are timeline ms
 * (slip: source ms).
 */
import type { EditClip } from "@/lib/api";
import type { NormalProject, NormalTrack } from "@/viz/edit/defaults";
import { editLength } from "@/viz/edit/types";
import { clipSourceSpan, findClip, newClip, newId } from "@/editor/doc";
import { addTrack, applyPlacement, clipFitsTrack, DEFAULT_CLIP_MS, minClipMs, trimClip, usesSource, type DropMode } from "./ops";

const byStart = (a: EditClip, b: EditClip): number => a.startMs - b.startMs || a.endMs - b.endMs;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function withTrackClips(doc: NormalProject, trackIndex: number, clips: EditClip[]): NormalProject {
  const tracks = doc.tracks.slice();
  tracks[trackIndex] = { ...(tracks[trackIndex] as NormalTrack), clips: clips.slice().sort(byStart) };
  return { ...doc, tracks };
}

/** The document with one clip replaced (same track). */
function replaceClip(doc: NormalProject, trackIndex: number, next: EditClip): NormalProject {
  return withTrackClips(doc, trackIndex, (doc.tracks[trackIndex] as NormalTrack).clips.map((c) => (c.id === next.id ? next : c)));
}

/** A copy of the document where the track holds only this clip (trim limits from neighbours fall away). */
function alone(doc: NormalProject, trackIndex: number, clip: EditClip): NormalProject {
  return withTrackClips(doc, trackIndex, [clip]);
}

// ---- ripple delete and gaps ----

/** Deletes the clips and shifts the later clips of the same tracks left by the time removed. Locked tracks keep their clips. */
export function rippleDelete(doc: NormalProject, ids: readonly string[]): NormalProject | null {
  const set = new Set(ids);
  let changed = false;
  const tracks = doc.tracks.map((t) => {
    if (t.locked) return t;
    const gone = t.clips.filter((c) => set.has(c.id));
    if (!gone.length) return t;
    changed = true;
    const keep = t.clips
      .filter((c) => !set.has(c.id))
      .map((c) => {
        let shift = 0;
        for (const g of gone) if (g.endMs <= c.startMs) shift += g.endMs - g.startMs;
        return shift ? { ...c, startMs: c.startMs - shift, endMs: c.endMs - shift, auto: false } : c;
      });
    return { ...t, clips: keep };
  });
  return changed ? { ...doc, tracks } : null;
}

export interface Gap {
  trackId: string;
  fromMs: number;
  toMs: number;
}

/** The empty stretch of a track around `ms` that has a clip after it (the space before the first clip counts); null inside a clip or past the last one. */
export function gapAt(doc: NormalProject, trackId: string, ms: number): Gap | null {
  const t = doc.tracks.find((x) => x.id === trackId);
  if (!t) return null;
  let prevEnd = 0;
  for (const c of t.clips.slice().sort(byStart)) {
    if (ms < c.startMs) return c.startMs > prevEnd ? { trackId, fromMs: prevEnd, toMs: c.startMs } : null;
    if (ms < c.endMs) return null;
    prevEnd = c.endMs;
  }
  return null;
}

/** Closes a gap: every clip after it on the track moves left by its length. */
export function closeGap(doc: NormalProject, gap: Gap): NormalProject | null {
  const i = doc.tracks.findIndex((t) => t.id === gap.trackId);
  const t = doc.tracks[i];
  const len = gap.toMs - gap.fromMs;
  if (!t || t.locked || len <= 0) return null;
  const later = t.clips.filter((c) => c.startMs >= gap.toMs);
  if (!later.length) return null;
  return withTrackClips(
    doc,
    i,
    t.clips.map((c) => (c.startMs >= gap.toMs ? { ...c, startMs: c.startMs - len, endMs: c.endMs - len, auto: false } : c)),
  );
}

// ---- ripple trim, roll, slip ----

/**
 * Ripple trim: the edge moves to toMs and the clips after it on that track
 * shift by the change in length. The start edge keeps the clip where it is
 * (the head is cut or extended, the clip's `InMs` follows). Limits as trimClip
 * (≥ 1 frame, `InMs` ≥ 0, the source's end), minus the neighbours.
 */
export function rippleTrim(doc: NormalProject, id: string, edge: "start" | "end", toMs: number, opts: { sourceMs?: number } = {}): NormalProject | null {
  const ref = findClip(doc, id);
  if (!ref || ref.track.locked) return null;
  const c = ref.clip;
  const trimmed = trimClip(alone(doc, ref.trackIndex, c), id, edge, toMs, opts);
  const t = trimmed ? findClip(trimmed, id)?.clip : undefined;
  if (!t) return null;
  const before = c.endMs - c.startMs;
  const after = t.endMs - t.startMs;
  const delta = after - before;
  if (delta === 0) return null;
  const next: EditClip = edge === "start" ? { ...t, startMs: c.startMs, endMs: c.startMs + after } : t;
  const clips = (doc.tracks[ref.trackIndex] as NormalTrack).clips.map((x) => {
    if (x.id === id) return next;
    return x.startMs >= c.endMs ? { ...x, startMs: x.startMs + delta, endMs: x.endMs + delta, auto: false } : x;
  });
  return withTrackClips(doc, ref.trackIndex, clips);
}

/** Two clips on one track that touch: the left one's end meets the right one's start (within 1 ms). */
export function touching(doc: NormalProject, leftId: string, rightId: string): boolean {
  const l = findClip(doc, leftId);
  const r = findClip(doc, rightId);
  return !!l && !!r && l.trackIndex === r.trackIndex && Math.abs(l.clip.endMs - r.clip.startMs) <= 1;
}

/** The pair of touching clips whose cut is at (or within `tolMs` of) ms on a track, as [left, right]. */
export function cutAt(doc: NormalProject, trackId: string, ms: number, tolMs: number): [EditClip, EditClip] | null {
  const t = doc.tracks.find((x) => x.id === trackId);
  if (!t) return null;
  const sorted = t.clips.slice().sort(byStart);
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i] as EditClip;
    const b = sorted[i + 1] as EditClip;
    if (Math.abs(a.endMs - b.startMs) <= 1 && Math.abs(a.endMs - ms) <= tolMs) return [a, b];
  }
  return null;
}

/**
 * Roll: the cut between two touching clips moves to toMs; both edges move
 * together, so nothing else shifts. The move stops where either clip runs out
 * (one frame left, the start of its source, the end of the left source).
 */
export function rollEdit(doc: NormalProject, leftId: string, rightId: string, toMs: number, opts: { leftSourceMs?: number } = {}): NormalProject | null {
  const l = findClip(doc, leftId);
  const r = findClip(doc, rightId);
  if (!l || !r || l.track.locked || !touching(doc, leftId, rightId)) return null;
  const b = l.clip.endMs;
  const want = Math.round(toMs);
  const soloL = alone(doc, l.trackIndex, l.clip);
  const soloR = alone(doc, r.trackIndex, r.clip);
  const lEnd = findClip(trimClip(soloL, leftId, "end", want, { sourceMs: opts.leftSourceMs ?? 0 }) ?? soloL, leftId)?.clip.endMs ?? b;
  const rStart = findClip(trimClip(soloR, rightId, "start", want) ?? soloR, rightId)?.clip.startMs ?? r.clip.startMs;
  const t = want > b ? Math.min(lEnd, rStart) : Math.max(lEnd, rStart);
  if (t === b || (want > b ? t < b : t > b)) return null;
  const newL = findClip(trimClip(soloL, leftId, "end", t, { sourceMs: opts.leftSourceMs ?? 0 }) ?? soloL, leftId)?.clip;
  const newR = findClip(trimClip(soloR, rightId, "start", t) ?? soloR, rightId)?.clip;
  if (!newL || !newR || newL.endMs !== t || newR.startMs !== t) return null;
  return replaceClip(replaceClip(doc, l.trackIndex, newL), r.trackIndex, newR);
}

/**
 * Slip: the clip keeps its place and length while `InMs` moves by deltaSrcMs
 * (source ms), within the file (≥ 0, and with `sourceMs`, not past its end).
 */
export function slipClip(doc: NormalProject, id: string, deltaSrcMs: number, opts: { sourceMs?: number } = {}): NormalProject | null {
  const ref = findClip(doc, id);
  if (!ref || ref.track.locked || !usesSource(ref.clip)) return null;
  const c = ref.clip;
  const used = clipSourceSpan(c, doc.fps).toMs - c.inMs;
  const max = (opts.sourceMs ?? 0) > 0 ? Math.max(0, (opts.sourceMs as number) - used) : Number.POSITIVE_INFINITY;
  const inMs = Math.round(clamp(c.inMs + deltaSrcMs, 0, max));
  if (inMs === c.inMs) return null;
  return replaceClip(doc, ref.trackIndex, { ...c, inMs, auto: false });
}

/** The in and out of a clip in its source, for the slip readout (source ms). */
export function sourceRange(doc: NormalProject, c: EditClip): { inMs: number; outMs: number } {
  return { inMs: c.inMs, outMs: clipSourceSpan(c, doc.fps).toMs };
}

// ---- clipboard ----

export interface ClipboardEntry {
  clip: EditClip;
  trackId: string;
}

export interface ClipboardData {
  entries: ClipboardEntry[];
  /** The earliest start among the entries (timeline ms): pastes put it at the playhead. */
  anchorMs: number;
  /** The entry the target track applies to (the earliest). */
  refTrackId: string;
}

/** The clips as the clipboard holds them; null when none exist. */
export function copyClips(doc: NormalProject, ids: readonly string[]): ClipboardData | null {
  const entries: ClipboardEntry[] = [];
  for (const id of ids) {
    const r = findClip(doc, id);
    if (r) entries.push({ clip: r.clip, trackId: r.track.id });
  }
  if (!entries.length) return null;
  const first = entries.slice().sort((a, b) => a.clip.startMs - b.clip.startMs)[0] as ClipboardEntry;
  return { entries, anchorMs: first.clip.startMs, refTrackId: first.trackId };
}

export type PasteResult = { ok: true; project: NormalProject; ids: string[] } | { ok: false; reason: "empty" | "locked" | "incompatible" };

/**
 * Pastes at atMs: the earliest clip goes onto `targetTrackId` (its own track
 * when omitted) and the others keep their track offset. "overwrite" cuts what
 * is under them; "insert" pushes later clips right. Pasted copies of linked
 * clips stay linked to each other.
 */
export function pasteClips(doc: NormalProject, data: ClipboardData, atMs: number, targetTrackId: string | undefined, mode: DropMode): PasteResult {
  if (!data.entries.length) return { ok: false, reason: "empty" };
  const refIndex = doc.tracks.findIndex((t) => t.id === data.refTrackId);
  const toIndex = targetTrackId === undefined ? refIndex : doc.tracks.findIndex((t) => t.id === targetTrackId);
  if (refIndex < 0 || toIndex < 0) return { ok: false, reason: "incompatible" };
  const delta = Math.max(0, Math.round(atMs)) - data.anchorMs;
  const links = new Map<string, string>();
  const placed: Array<{ clip: EditClip; trackIndex: number }> = [];
  for (const e of data.entries) {
    const from = doc.tracks.findIndex((t) => t.id === e.trackId);
    const ti = (from < 0 ? refIndex : from) + (toIndex - refIndex);
    const t = doc.tracks[ti];
    if (!t) return { ok: false, reason: "incompatible" };
    if (t.locked) return { ok: false, reason: "locked" };
    if (!clipFitsTrack(e.clip, t)) return { ok: false, reason: "incompatible" };
    const clip: EditClip = { ...e.clip, id: newId("c"), startMs: e.clip.startMs + delta, endMs: e.clip.endMs + delta, auto: false };
    if (e.clip.link) {
      let n = links.get(e.clip.link);
      if (!n) {
        n = newId("l");
        links.set(e.clip.link, n);
      }
      clip.link = n;
    }
    placed.push({ clip, trackIndex: ti });
  }
  // A link only means something with two members.
  const counts = new Map<string, number>();
  for (const p of placed) if (p.clip.link) counts.set(p.clip.link, (counts.get(p.clip.link) ?? 0) + 1);
  for (const p of placed) if (p.clip.link && (counts.get(p.clip.link) ?? 0) < 2) delete p.clip.link;
  return { ok: true, project: applyPlacement(doc, new Set(), placed, mode), ids: placed.map((p) => p.clip.id) };
}

// ---- links ----

/** Links the clips (two or more, none on a locked track) under a new link ID. */
export function linkClips(doc: NormalProject, ids: readonly string[]): NormalProject | null {
  const set = new Set(ids);
  const hits = doc.tracks.flatMap((t) => t.clips.filter((c) => set.has(c.id)).map((c) => ({ c, locked: t.locked })));
  if (hits.length < 2 || hits.some((h) => h.locked)) return null;
  const link = newId("l");
  return {
    ...doc,
    tracks: doc.tracks.map((t) => (t.clips.some((c) => set.has(c.id)) ? { ...t, clips: t.clips.map((c) => (set.has(c.id) ? { ...c, link } : c)) } : t)),
  };
}

/** Clears the link of the clips. */
export function unlinkClips(doc: NormalProject, ids: readonly string[]): NormalProject | null {
  const set = new Set(ids);
  let changed = false;
  const tracks = doc.tracks.map((t) => {
    if (!t.clips.some((c) => set.has(c.id) && c.link)) return t;
    changed = true;
    return {
      ...t,
      clips: t.clips.map((c) => {
        if (!set.has(c.id) || !c.link) return c;
        const { link: _l, ...rest } = c;
        void _l;
        return rest;
      }),
    };
  });
  return changed ? { ...doc, tracks } : null;
}

/** Ctrl+L: unlinks when any selected clip is linked, else links them. */
export function toggleLink(doc: NormalProject, ids: readonly string[]): NormalProject | null {
  const set = new Set(ids);
  const anyLinked = doc.tracks.some((t) => t.clips.some((c) => set.has(c.id) && c.link));
  return anyLinked ? unlinkClips(doc, ids) : linkClips(doc, ids);
}

/** True when the clip has an audio track's worth of sound to detach (video clips that aren't already linked). */
export function canDetachAudio(doc: NormalProject, id: string, hasAudio = true): boolean {
  const r = findClip(doc, id);
  return !!r && r.clip.kind === "video" && !r.clip.link && !r.track.locked && hasAudio;
}

export interface Detached {
  project: NormalProject;
  audioId: string;
}

/**
 * Detach audio: an audio clip with the same timing, `InMs` and speed goes on
 * the first free audio track (a new one when none has room); the video clip's
 * volume becomes 0 and the two are linked.
 */
export function detachAudio(doc: NormalProject, id: string): Detached | null {
  const r = findClip(doc, id);
  if (!r || r.clip.kind !== "video" || r.clip.link || r.track.locked) return null;
  const v = r.clip;
  const free = (t: NormalTrack): boolean => t.kind === "audio" && !t.locked && !t.clips.some((c) => c.startMs < v.endMs && v.startMs < c.endMs);
  let work = doc;
  let ti = -1;
  // The audio track nearest the video comes first (highest index).
  for (let i = doc.tracks.length - 1; i >= 0; i--) {
    if (free(doc.tracks[i] as NormalTrack)) {
      ti = i;
      break;
    }
  }
  if (ti < 0) {
    const added = addTrack(doc, "audio");
    if (!added) return null;
    work = added;
    ti = 0;
  }
  const link = newId("l");
  const audio = newClip({
    kind: "audio",
    path: v.path,
    startMs: v.startMs,
    endMs: v.endMs,
    inMs: v.inMs,
    speed: v.speed,
    volume: v.volume > 0 ? v.volume : 1,
    link,
  });
  const tracks = work.tracks.map((t, i) => {
    if (i === ti) return { ...t, clips: [...t.clips, audio].sort(byStart) };
    return t.clips.some((c) => c.id === v.id) ? { ...t, clips: t.clips.map((c) => (c.id === v.id ? { ...c, volume: 0, link, auto: false } : c)) } : t;
  });
  return { project: { ...work, tracks }, audioId: audio.id };
}

// ---- audio clips ----

export interface AudioSource {
  path: string;
  durationMs: number;
}

/**
 * Puts an audio clip (the whole file) on an audio track at atMs. With `drop` it
 * overwrites what's under it or inserts; without, it lands after the clip
 * under it and is cut to the gap.
 */
export function insertAudioClipAt(doc: NormalProject, trackId: string, source: AudioSource, atMs: number, drop?: DropMode): { project: NormalProject; clip: EditClip } | null {
  const ti = doc.tracks.findIndex((t) => t.id === trackId);
  const track = doc.tracks[ti];
  if (!track || track.locked || track.kind !== "audio" || source.durationMs <= 0) return null;
  const min = minClipMs(doc.fps);
  let at = Math.max(0, Math.round(atMs));
  const len = Math.max(min, Math.round(source.durationMs) || DEFAULT_CLIP_MS);
  const make = (startMs: number, endMs: number): EditClip => newClip({ kind: "audio", path: source.path, startMs, endMs, volume: 1 });
  if (drop) {
    const clip = make(at, at + len);
    return { project: applyPlacement(doc, new Set(), [{ clip, trackIndex: ti }], drop), clip };
  }
  const sorted = track.clips.slice().sort(byStart);
  for (const c of sorted) if (c.startMs <= at && at < c.endMs) at = c.endMs;
  const next = sorted.find((c) => c.startMs >= at);
  const end = Math.min(at + len, next ? next.startMs : Number.POSITIVE_INFINITY);
  if (end - at < min) return null;
  const clip = make(at, end);
  return { project: withTrackClips(doc, ti, [...track.clips, clip]), clip };
}

// ---- navigation ----

/** Every clip edge on every track, plus 0 and the end of the edit: ascending, deduplicated (for ↑ / ↓). */
export function editPoints(doc: NormalProject): number[] {
  const out = new Set<number>([0]);
  const end = editLength(doc);
  if (end > 0) out.add(end);
  for (const t of doc.tracks) {
    for (const c of t.clips) {
      out.add(c.startMs);
      out.add(c.endMs);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** The id of a track of the right kind to take a source dropped outside the rows: video-like sources on a new top track, audio on a new audio track. */
export function trackForNewSource(doc: NormalProject, kind: "video" | "audio"): NormalProject | null {
  return addTrack(doc, kind === "audio" ? "audio" : "video");
}
