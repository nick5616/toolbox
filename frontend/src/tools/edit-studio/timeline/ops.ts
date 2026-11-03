/**
 * Pure timeline edit operations (Phase 9 SPEC §14.5). Every function takes a
 * NormalProject and returns a new one, or null when nothing would change (so
 * the UI skips the history entry). The UI records the result with
 * `store.edit(next, key)`. Times are timeline ms.
 */
import type { EditClip } from "@/lib/api";
import type { NormalProject, NormalTrack } from "@/viz/edit/defaults";
import { interpolateKeys } from "@/viz/edit/params";
import {
  parseEffects,
  parseMasks,
  parseSpeed,
  parseTransform,
  serializeEffects,
  serializeMasks,
  serializeSpeed,
  serializeTransform,
} from "@/viz/edit/schema";
import { editLength, type EditParam, type Key, type Marker, type MarkerLane } from "@/viz/edit/types";
import { clipSourceSpan, findClip, newClip, newId, newTrack, speedAt } from "../doc";

/** Length of a photo, a colour clip or an adjustment clip when nothing else decides it. */
export const DEFAULT_CLIP_MS = 2000;
export const MAX_TRACKS = 8;

/** The shortest a clip may be: one output frame. */
export function minClipMs(fps: number): number {
  return Math.ceil(1000 / Math.max(1, fps));
}

const overlaps = (a: Pick<EditClip, "startMs" | "endMs">, b: Pick<EditClip, "startMs" | "endMs">): boolean => a.startMs < b.endMs && b.startMs < a.endMs;
const byStart = (a: EditClip, b: EditClip): number => a.startMs - b.startMs || a.endMs - b.endMs;
const sortedClips = (t: NormalTrack): EditClip[] => t.clips.slice().sort(byStart);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function hasOverlap(clips: readonly EditClip[]): boolean {
  const s = clips.slice().sort(byStart);
  for (let i = 1; i < s.length; i++) if (overlaps(s[i - 1] as EditClip, s[i] as EditClip)) return true;
  return false;
}

/** The lane's markers as ascending timeline ms. */
export function laneMarkersMs(markers: readonly Marker[], lane: MarkerLane): number[] {
  return markers
    .filter((m) => m.lane === lane)
    .map((m) => m.ms)
    .sort((a, b) => a - b);
}

// ---- keyframe re-basing ----

function shiftParam(p: EditParam, shift: number): EditParam {
  if (typeof p === "number" || !p.keys?.length) return p;
  const keys = p.keys;
  let out: Key[];
  if (shift >= 0) {
    out = keys.filter((k) => k.t >= shift).map((k) => ({ ...k, t: k.t - shift }));
    if (out[0]?.t !== 0) {
      const before = keys.filter((k) => k.t < shift);
      const ease = before[before.length - 1]?.ease ?? "linear";
      out.unshift({ t: 0, v: interpolateKeys(keys, shift), ease });
    }
  } else {
    out = keys.map((k) => ({ ...k, t: k.t - shift }));
  }
  return { ...p, keys: out.slice(0, 64) };
}

/**
 * A clip's field patch after its start moved by `shift` ms (keyframe times are
 * clip-relative, so they move the other way). Empty when no keys are involved.
 */
export function rebaseKeys(c: EditClip, shift: number): Partial<EditClip> {
  const patch: Partial<EditClip> = {};
  if (shift === 0) return patch;
  if (c.transform.includes('"keys"')) {
    const t = parseTransform(c.transform).value;
    patch.transform = serializeTransform({
      x: shiftParam(t.x, shift),
      y: shiftParam(t.y, shift),
      scale: shiftParam(t.scale, shift),
      rotation: shiftParam(t.rotation, shift),
      opacity: shiftParam(t.opacity, shift),
    });
  }
  if (c.speed.includes('"keys"')) patch.speed = serializeSpeed(shiftParam(parseSpeed(c.speed).value, shift));
  if (c.masks.includes('"keys"')) {
    patch.masks = serializeMasks(
      parseMasks(c.masks).value.map((m) => ({
        ...m,
        x: shiftParam(m.x, shift),
        y: shiftParam(m.y, shift),
        w: shiftParam(m.w, shift),
        h: shiftParam(m.h, shift),
        rotation: shiftParam(m.rotation, shift),
      })),
    );
  }
  if (c.effects.includes('"keys"')) {
    patch.effects = serializeEffects(
      parseEffects(c.effects).value.map((fx) => {
        const params: typeof fx.params = {};
        for (const [k, v] of Object.entries(fx.params)) params[k] = typeof v === "object" ? shiftParam(v, shift) : v;
        return { ...fx, params };
      }),
    );
  }
  return patch;
}

// ---- insert ----

export type InsertMode = "fill-next" | "source";

export interface InsertSource {
  kind: "video" | "image" | "color";
  path?: string;
  /** color: "#rrggbb" */
  color?: string;
  /** video: the source's length in ms (0/absent = unknown). */
  durationMs?: number;
}

export interface InsertOptions {
  /** Ascending timeline ms of the active lane's markers (fill-next). */
  markersMs?: readonly number[];
}

export interface Inserted {
  project: NormalProject;
  clip: EditClip;
}

/**
 * Puts a clip on a video track at atMs. `fill-next` spans to the next marker
 * of the active lane (or the source's natural length: the video's length, 2 s
 * for photos and colours); `source` is the natural length. Never overlaps: it
 * is cut to the gap, and a drop on an occupied point lands after the clip
 * under it. Null when the track is locked / not a video track, or no frame fits.
 */
export function insertClipAt(doc: NormalProject, trackId: string, source: InsertSource, atMs: number, mode: InsertMode, opts: InsertOptions = {}): Inserted | null {
  const ti = doc.tracks.findIndex((t) => t.id === trackId);
  const track = doc.tracks[ti];
  if (!track || track.locked || track.kind !== "video") return null;
  const D = editLength(doc);
  const min = minClipMs(doc.fps);
  const clips = sortedClips(track);
  let at = Math.max(0, Math.round(atMs));
  for (const c of clips) if (c.startMs <= at && at < c.endMs) at = c.endMs;
  if (at >= D) return null;
  const next = clips.find((c) => c.startMs >= at);
  const gapEnd = Math.min(next ? next.startMs : Number.POSITIVE_INFINITY, D);
  const srcLen = source.kind === "video" && (source.durationMs ?? 0) > 0 ? (source.durationMs as number) : 0;
  const natural = srcLen || DEFAULT_CLIP_MS;
  let len = natural;
  if (mode === "fill-next") {
    let nextMarker = Number.POSITIVE_INFINITY;
    for (const m of opts.markersMs ?? []) if (m >= at + min && m < nextMarker) nextMarker = m;
    if (Number.isFinite(nextMarker)) len = srcLen ? Math.min(nextMarker - at, srcLen) : nextMarker - at;
  }
  const end = Math.min(at + len, gapEnd);
  if (end - at < min) return null;
  const clip = newClip({
    kind: source.kind,
    path: source.kind === "color" ? "" : (source.path ?? ""),
    color: source.kind === "color" ? (source.color ?? "#000000") : "",
    startMs: at,
    endMs: Math.round(end),
  });
  return { project: setClips(doc, ti, [...track.clips, clip]), clip };
}

export function insertClip(doc: NormalProject, trackId: string, source: InsertSource, atMs: number, mode: InsertMode, opts: InsertOptions = {}): NormalProject | null {
  return insertClipAt(doc, trackId, source, atMs, mode, opts)?.project ?? null;
}

/** An adjustment clip (effects over a time range) on an adjustment track; spans to the next marker or 2 s. */
export function insertAdjustClip(doc: NormalProject, trackId: string, atMs: number, opts: InsertOptions = {}): Inserted | null {
  const ti = doc.tracks.findIndex((t) => t.id === trackId);
  const track = doc.tracks[ti];
  if (!track || track.locked || track.kind !== "adjust") return null;
  const D = editLength(doc);
  const min = minClipMs(doc.fps);
  const clips = sortedClips(track);
  let at = Math.max(0, Math.round(atMs));
  for (const c of clips) if (c.startMs <= at && at < c.endMs) at = c.endMs;
  if (at >= D) return null;
  const next = clips.find((c) => c.startMs >= at);
  let len = DEFAULT_CLIP_MS;
  let nextMarker = Number.POSITIVE_INFINITY;
  for (const m of opts.markersMs ?? []) if (m >= at + min && m < nextMarker) nextMarker = m;
  if (Number.isFinite(nextMarker)) len = nextMarker - at;
  const end = Math.min(at + len, next ? next.startMs : Number.POSITIVE_INFINITY, D);
  if (end - at < min) return null;
  const clip = newClip({ kind: "adjust", startMs: at, endMs: Math.round(end) });
  return { project: setClips(doc, ti, [...track.clips, clip]), clip };
}

function setClips(doc: NormalProject, trackIndex: number, clips: EditClip[]): NormalProject {
  const tracks = doc.tracks.slice();
  tracks[trackIndex] = { ...(tracks[trackIndex] as NormalTrack), clips: clips.slice().sort(byStart) };
  return { ...doc, tracks };
}

// ---- move / duplicate ----

const compatible = (clip: EditClip, t: NormalTrack): boolean => (clip.kind === "adjust") === (t.kind === "adjust");

interface Placement {
  clip: EditClip;
  trackIndex: number;
}

/** Where the clips would land: same relative timing, optionally on another track (the whole group shifts by the same number of tracks). */
function place(doc: NormalProject, ids: readonly string[], deltaMs: number, toTrackId: string | undefined, copy: boolean): { remove: Set<string>; placed: Placement[] } | null {
  const refs = ids.map((id) => findClip(doc, id)).filter((r): r is NonNullable<typeof r> => r !== null);
  if (!refs.length) return null;
  if (!copy && refs.some((r) => r.track.locked)) return null;
  const minStart = Math.min(...refs.map((r) => r.clip.startMs));
  const d = Math.max(Math.round(deltaMs), -minStart);
  let trackDelta = 0;
  if (toTrackId !== undefined) {
    const to = doc.tracks.findIndex((t) => t.id === toTrackId);
    if (to < 0) return null;
    trackDelta = to - (refs[0] as NonNullable<typeof refs[0]>).trackIndex;
  }
  if (d === 0 && trackDelta === 0 && !copy) return null;
  const placed: Placement[] = [];
  for (const r of refs) {
    const ti = r.trackIndex + trackDelta;
    const t = doc.tracks[ti];
    if (!t || t.locked || !compatible(r.clip, t)) return null;
    const c: EditClip = { ...r.clip, startMs: r.clip.startMs + d, endMs: r.clip.endMs + d, auto: false };
    if (copy) c.id = newId("c");
    placed.push({ clip: c, trackIndex: ti });
  }
  return { remove: copy ? new Set() : new Set(refs.map((r) => r.clip.id)), placed };
}

function apply(doc: NormalProject, remove: Set<string>, placed: Placement[]): NormalProject | null {
  const tracks = doc.tracks.map((t, i) => {
    const add = placed.filter((p) => p.trackIndex === i).map((p) => p.clip);
    const keep = remove.size ? t.clips.filter((c) => !remove.has(c.id)) : t.clips;
    if (!add.length && keep === t.clips) return t;
    return { ...t, clips: [...keep, ...add].sort(byStart) };
  });
  for (const t of tracks) if (hasOverlap(t.clips)) return null;
  return { ...doc, tracks };
}

/**
 * Moves clips by deltaMs, keeping their relative timing; with toTrackId the
 * group moves to that track (the first id's track becomes it; the others keep
 * their track offset). Blocked (null) when any clip would overlap another, land
 * on a locked track, or change between video and adjustment tracks. The group
 * never moves before 0.
 */
export function moveClips(doc: NormalProject, ids: readonly string[], deltaMs: number, toTrackId?: string): NormalProject | null {
  const pl = place(doc, ids, deltaMs, toTrackId, false);
  return pl ? apply(doc, pl.remove, pl.placed) : null;
}

/**
 * Copies clips (new IDs) by deltaMs, or, without it, to the right of the
 * selection (further right while something is in the way). Alt-drag passes deltaMs.
 */
export function duplicateClips(doc: NormalProject, ids: readonly string[], deltaMs?: number, toTrackId?: string): NormalProject | null {
  if (deltaMs !== undefined) {
    const pl = place(doc, ids, deltaMs, toTrackId, true);
    return pl ? apply(doc, pl.remove, pl.placed) : null;
  }
  const refs = ids.map((id) => findClip(doc, id)).filter((r): r is NonNullable<typeof r> => r !== null);
  if (!refs.length) return null;
  const span = Math.max(...refs.map((r) => r.clip.endMs)) - Math.min(...refs.map((r) => r.clip.startMs));
  let d = span;
  for (let i = 0; i < 60; i++) {
    const pl = place(doc, ids, d, undefined, true);
    if (!pl) return null;
    const out = apply(doc, pl.remove, pl.placed);
    if (out) return out;
    // Jump past the clip in the way, on the first track that collides.
    let jump = 0;
    for (const p of pl.placed) {
      const t = doc.tracks[p.trackIndex] as NormalTrack;
      for (const c of t.clips) if (overlaps(c, p.clip)) jump = Math.max(jump, c.endMs - p.clip.startMs);
    }
    d += Math.max(jump, 1);
  }
  return null;
}

export function deleteClips(doc: NormalProject, ids: readonly string[]): NormalProject | null {
  const set = new Set(ids);
  let changed = false;
  const tracks = doc.tracks.map((t) => {
    if (t.locked || !t.clips.some((c) => set.has(c.id))) return t;
    changed = true;
    return { ...t, clips: t.clips.filter((c) => !set.has(c.id)) };
  });
  return changed ? { ...doc, tracks } : null;
}

// ---- trim ----

/**
 * Moves one edge of a clip to toMs. The start edge also moves InMs by the
 * source time passed (speed-aware) and re-bases keyframes; limits: ≥ 1 frame,
 * not into a neighbour, InMs ≥ 0, and (end edge, video, sourceMs given) not
 * past the end of the source.
 */
export function trimClip(doc: NormalProject, id: string, edge: "start" | "end", toMs: number, opts: { sourceMs?: number } = {}): NormalProject | null {
  const ref = findClip(doc, id);
  if (!ref || ref.track.locked) return null;
  const c = ref.clip;
  const min = minClipMs(doc.fps);
  const others = ref.track.clips.filter((x) => x.id !== id);
  const target = Math.round(toMs);
  const replace = (patch: Partial<EditClip>): NormalProject => {
    const clips = ref.track.clips.map((x) => (x.id === id ? { ...x, ...patch, auto: false } : x));
    return setClips(doc, ref.trackIndex, clips);
  };
  if (edge === "end") {
    const next = others.filter((x) => x.startMs >= c.endMs).sort(byStart)[0];
    let end = clamp(target, c.startMs + min, next ? next.startMs : Number.POSITIVE_INFINITY);
    const srcMs = opts.sourceMs ?? 0;
    if (c.kind === "video" && srcMs > 0 && end > c.endMs) {
      // Largest end within [old end, wanted end] that still plays inside the source.
      let lo = c.endMs;
      let hi = end;
      if (clipSourceSpan({ ...c, endMs: lo }, doc.fps).toMs > srcMs) hi = lo;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (clipSourceSpan({ ...c, endMs: mid }, doc.fps).toMs <= srcMs) lo = mid;
        else hi = mid;
      }
      end = clipSourceSpan({ ...c, endMs: hi }, doc.fps).toMs <= srcMs ? hi : lo;
    }
    return end === c.endMs ? null : replace({ endMs: end });
  }
  const prev = others.filter((x) => x.endMs <= c.startMs).sort(byStart).pop();
  let start = clamp(target, prev ? prev.endMs : 0, c.endMs - min);
  let inMs = c.inMs;
  if (c.kind === "video") {
    if (start > c.startMs) {
      inMs = c.inMs + (clipSourceSpan({ ...c, endMs: start }, doc.fps).toMs - c.inMs);
      // clipSourceSpan integrates from startMs for (endMs − startMs); here we want [startMs, start).
    } else if (start < c.startMs) {
      const s0 = speedAt(c, 0);
      inMs = c.inMs - s0 * (c.startMs - start);
      if (inMs < 0) {
        inMs = 0;
        if (s0 > 0) start = Math.min(c.startMs, Math.ceil(c.startMs - c.inMs / s0));
      }
    }
  }
  if (start === c.startMs) return null;
  return replace({ startMs: start, inMs: Math.round(inMs), ...rebaseKeys(c, start - c.startMs) });
}

// ---- split / slice ----

/** The two halves of a clip cut at t (timeline ms); null when a half would be shorter than a frame. */
export function splitClip(c: EditClip, t: number, fps: number): [EditClip, EditClip] | null {
  const min = minClipMs(fps);
  if (t - c.startMs < min || c.endMs - t < min) return null;
  const inMs = c.kind === "video" ? Math.round(clipSourceSpan({ ...c, endMs: t }, fps).toMs) : c.inMs;
  const left: EditClip = { ...c, endMs: t, auto: false };
  const right: EditClip = { ...c, id: newId("c"), startMs: t, inMs, in: "", auto: false, ...rebaseKeys(c, t - c.startMs) };
  return [left, right];
}

/** Splits every listed clip that spans tMs (≥ 1 frame each side). The right half gets a new ID; a matte is shared. */
export function splitAt(doc: NormalProject, ids: readonly string[], tMs: number): NormalProject | null {
  const set = new Set(ids);
  const t = Math.round(tMs);
  let changed = false;
  const tracks = doc.tracks.map((tr) => {
    if (tr.locked) return tr;
    const clips: EditClip[] = [];
    for (const c of tr.clips) {
      const halves = set.has(c.id) ? splitClip(c, t, doc.fps) : null;
      if (halves) {
        clips.push(...halves);
        changed = true;
      } else clips.push(c);
    }
    return clips.length === tr.clips.length ? tr : { ...tr, clips: clips.sort(byStart) };
  });
  return changed ? { ...doc, tracks } : null;
}

export interface SourceFacts {
  kind: string;
  durationMs: number;
}

export interface SliceOptions {
  /** Facts about source files (kind, duration), for cycleSources. */
  sources?: Readonly<Record<string, SourceFacts | undefined>>;
}

/**
 * Splits clips at every marker (ascending timeline ms) inside them. The target
 * is a list of clip IDs, or a range (every clip touching it, cut only inside
 * it). With cycleSources, slice k ≥ 1 takes the next source of the project's
 * Sources order after the clip's own; videos continue from that source's
 * cursor (first use 0), wrapping to 0 when the rest is shorter than the slice.
 */
export function sliceAtMarkers(
  doc: NormalProject,
  target: readonly string[] | { fromMs: number; toMs: number },
  markersMs: readonly number[],
  cycleSources: boolean,
  opts: SliceOptions = {},
): NormalProject | null {
  const min = minClipMs(doc.fps);
  const range = Array.isArray(target) ? null : (target as { fromMs: number; toMs: number });
  const idSet = Array.isArray(target) ? new Set<string>(target as readonly string[]) : null;
  const order = doc.sources.map((s) => s.path);
  const info = opts.sources ?? {};
  // Cursor of each source: where its latest clip ends in the source.
  const cursor = new Map<string, number>();
  for (const tr of doc.tracks) {
    for (const c of tr.clips) {
      if (c.kind === "video" && c.path) cursor.set(c.path, Math.max(cursor.get(c.path) ?? 0, clipSourceSpan(c, doc.fps).toMs));
    }
  }
  let changed = false;
  const tracks = doc.tracks.map((tr) => {
    if (tr.locked) return tr;
    const out: EditClip[] = [];
    for (const c of tr.clips) {
      const hit = idSet ? idSet.has(c.id) : range ? overlaps(c, { startMs: range.fromMs, endMs: range.toMs }) : false;
      if (!hit) {
        out.push(c);
        continue;
      }
      const lo = range ? Math.max(c.startMs, range.fromMs) : c.startMs;
      const hi = range ? Math.min(c.endMs, range.toMs) : c.endMs;
      const cuts: number[] = [];
      let last = c.startMs;
      for (const m of [...markersMs].sort((a, b) => a - b)) {
        const mm = Math.round(m);
        if (mm < lo || mm > hi || mm - last < min || c.endMs - mm < min) continue;
        cuts.push(mm);
        last = mm;
      }
      if (!cuts.length) {
        out.push(c);
        continue;
      }
      changed = true;
      let rest: EditClip = c;
      const pieces: EditClip[] = [];
      for (const cut of cuts) {
        const halves = splitClip(rest, cut, doc.fps);
        if (!halves) continue;
        pieces.push(halves[0]);
        rest = halves[1];
      }
      pieces.push(rest);
      if (cycleSources && order.length > 1) {
        const own = order.indexOf(c.path);
        for (let k = 1; k < pieces.length; k++) {
          const piece = pieces[k] as EditClip;
          for (let tries = 0; tries < order.length; tries++) {
            const idx = ((own < 0 ? k - 1 : own + k) + tries) % order.length;
            const path = order[idx] as string;
            const f = info[path];
            if (!f || (f.kind !== "video" && f.kind !== "image")) continue;
            const len = piece.endMs - piece.startMs;
            let inMs = 0;
            if (f.kind === "video") {
              const cur = cursor.get(path) ?? 0;
              inMs = f.durationMs > 0 && cur + len > f.durationMs ? 0 : cur;
              cursor.set(path, inMs + len);
            }
            pieces[k] = { ...piece, kind: f.kind, path, color: "", inMs, speed: "", slow: "", matte: null, fxTarget: "clip" };
            break;
          }
        }
      }
      out.push(...pieces);
    }
    return out.length === tr.clips.length ? tr : { ...tr, clips: out.sort(byStart) };
  });
  return changed ? { ...doc, tracks } : null;
}

// ---- tracks ----

/** Adds a track on top (≤ 8). Names count up per kind ("Video 2", "Adjust 1"). */
export function addTrack(doc: NormalProject, kind: "video" | "adjust", name?: string): NormalProject | null {
  if (doc.tracks.length >= MAX_TRACKS) return null;
  let n = doc.tracks.filter((t) => t.kind === kind).length + 1;
  const label = kind === "video" ? "Video" : "Adjust";
  const names = new Set(doc.tracks.map((t) => t.name));
  while (!name && names.has(`${label} ${n}`)) n++;
  return { ...doc, tracks: [...doc.tracks, { ...newTrack(kind, name?.trim() || `${label} ${n}`), clips: [] }] };
}

/** Removes a track and its clips; at least one track stays. */
export function removeTrack(doc: NormalProject, id: string): NormalProject | null {
  if (doc.tracks.length <= 1 || !doc.tracks.some((t) => t.id === id)) return null;
  return { ...doc, tracks: doc.tracks.filter((t) => t.id !== id) };
}

/** Moves a track to index `to` (0 = bottom). */
export function reorderTrack(doc: NormalProject, id: string, to: number): NormalProject | null {
  const from = doc.tracks.findIndex((t) => t.id === id);
  const dest = clamp(to, 0, doc.tracks.length - 1);
  if (from < 0 || from === dest) return null;
  const tracks = doc.tracks.slice();
  const [t] = tracks.splice(from, 1);
  tracks.splice(dest, 0, t as NormalTrack);
  return { ...doc, tracks };
}

function patchTrack(doc: NormalProject, id: string, patch: Partial<NormalTrack>): NormalProject | null {
  const i = doc.tracks.findIndex((t) => t.id === id);
  const t = doc.tracks[i];
  if (!t) return null;
  if ((Object.keys(patch) as Array<keyof NormalTrack>).every((k) => t[k] === patch[k])) return null;
  const tracks = doc.tracks.slice();
  tracks[i] = { ...t, ...patch };
  return { ...doc, tracks };
}

export const renameTrack = (doc: NormalProject, id: string, name: string): NormalProject | null => (name.trim() ? patchTrack(doc, id, { name: name.trim().slice(0, 40) }) : null);
export const setTrackMuted = (doc: NormalProject, id: string, muted: boolean): NormalProject | null => patchTrack(doc, id, { muted });
export const setTrackLocked = (doc: NormalProject, id: string, locked: boolean): NormalProject | null => patchTrack(doc, id, { locked });

/** Changes a track's kind; only while it has no clips. */
export function setTrackKind(doc: NormalProject, id: string, kind: "video" | "adjust"): NormalProject | null {
  const t = doc.tracks.find((x) => x.id === id);
  if (!t || t.clips.length) return null;
  return patchTrack(doc, id, { kind });
}

// ---- lookups ----

/** Clips (ids) of a track that contain tMs. */
export function clipsAt(doc: NormalProject, trackId: string, tMs: number): EditClip[] {
  const t = doc.tracks.find((x) => x.id === trackId);
  return t ? t.clips.filter((c) => c.startMs <= tMs && tMs < c.endMs) : [];
}

/** Marker time before/after t (strictly), from ascending ms; null when none. */
export function neighbourMarker(markersMs: readonly number[], t: number, dir: -1 | 1): number | null {
  if (dir > 0) {
    for (const m of markersMs) if (m > t + 0.5) return m;
    return null;
  }
  for (let i = markersMs.length - 1; i >= 0; i--) if ((markersMs[i] as number) < t - 0.5) return markersMs[i] as number;
  return null;
}
