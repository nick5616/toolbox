/**
 * Selection-level edit actions shared by the keyboard, the palette and the
 * clip menu (Phase 9 SPEC §14.5, §14.11). They read the store, call the pure
 * ops and record one history entry.
 */
import type { EditSourceState } from "@/lib/api";
import { toast } from "@/components";
import type { NormalProject } from "@/viz/edit/defaults";
import type { Marker } from "@/viz/edit/types";
import { splitSubject } from "../matte/split";
import { useEditStudio, type Selection } from "@/editor/store";
import { editLength } from "@/viz/edit/types";
import { addTrack, deleteClips, duplicateClips, insertClipAt, laneMarkersMs, sliceAtMarkers, splitAt, withLinked, type DropMode, type InsertMode, type SourceFacts } from "./ops";
import { canDetachAudio, closeGap, copyClips, detachAudio, editPoints, insertAudioClipAt, pasteClips, rippleDelete, toggleLink } from "./edit";
import { addRulerMarker, rulerMarkers } from "./markers";
import { neighbourKey } from "./keyframes";
import { useTimelineStore } from "./timelineStore";
import { seekTo } from "../transport/player";

export function currentDoc(): NormalProject | null {
  return useEditStudio.getState().history?.present ?? null;
}

/** Records `next` (one undo step); false when there was nothing to do. */
export function commit(next: NormalProject | null, key = ""): boolean {
  if (!next) return false;
  useEditStudio.getState().edit(next, key);
  return true;
}

/**
 * A drag records its edits under one coalescing key, but history only merges
 * edits less than 800 ms apart: a pause mid-drag would make two undo steps.
 * At the end of a drag this folds everything since `startPast` (the history's
 * past length when the drag began, with `base` as the document it began from)
 * into one entry. The document itself is untouched.
 */
export function collapseDrag(startPast: number, base: NormalProject): void {
  const h = useEditStudio.getState().history;
  if (!h || h.past.length <= startPast + 1 || h.past[startPast] !== base) return;
  useEditStudio.setState({ history: { ...h, past: h.past.slice(0, startPast + 1) } });
}

export function selectedClipIds(sel: Selection): string[] {
  return sel?.kind === "clips" ? [...sel.ids] : [];
}

/** Source facts for cycleSources from the store's source states. */
export function sourceFacts(sources: Readonly<Record<string, EditSourceState | undefined>>): Record<string, SourceFacts> {
  const out: Record<string, SourceFacts> = {};
  for (const [path, s] of Object.entries(sources)) if (s) out[path] = { kind: s.info.kind, durationMs: s.info.durationMs };
  return out;
}

/**
 * The clips an action works on: the selected clips, else (for split) the clips
 * under the playhead on the selected track / the first unlocked video track.
 */
export function splitTargets(doc: NormalProject, sel: Selection, playheadMs: number): string[] {
  const ids = selectedClipIds(sel);
  if (ids.length) return ids;
  const track =
    sel?.kind === "track" ? doc.tracks.find((t) => t.id === sel.id) : doc.tracks.find((t) => t.kind === "video" && !t.locked);
  return track ? track.clips.filter((c) => c.startMs < playheadMs && playheadMs < c.endMs).map((c) => c.id) : [];
}

export function splitAtPlayhead(): boolean {
  const doc = currentDoc();
  if (!doc) return false;
  const { selection, playheadMs } = useEditStudio.getState();
  // With nothing selected the clips under the playhead split together with their links.
  return commit(splitAt(doc, splitTargets(doc, selection, playheadMs), playheadMs, { linked: selectedClipIds(selection).length === 0 }));
}

/** Slices the selected clips (or the selected range) at the active lane's markers. */
export function sliceSelection(markers: readonly Marker[], cycleSources: boolean): boolean {
  const doc = currentDoc();
  if (!doc) return false;
  const st = useEditStudio.getState();
  const ms = laneMarkersMs(markers, st.activeLane);
  const ids = selectedClipIds(st.selection);
  const target = ids.length ? ids : st.selection?.kind === "range" ? { fromMs: st.selection.fromMs, toMs: st.selection.toMs } : null;
  if (!target) {
    toast({ title: "Select clips or a range first", tone: "warn" });
    return false;
  }
  const out = sliceAtMarkers(doc, target, ms, cycleSources, { sources: sourceFacts(st.sources) });
  if (!out) toast({ title: `No ${st.activeLane} markers inside the selection`, tone: "warn" });
  return commit(out);
}

export function deleteSelection(): boolean {
  const doc = currentDoc();
  if (!doc) return false;
  const sel = useEditStudio.getState().selection;
  if (sel?.kind === "clips") {
    const ok = commit(deleteClips(doc, sel.ids));
    if (ok) useEditStudio.getState().select(null);
    return ok;
  }
  // A selected gap closes (Delete on the empty stretch between clips).
  const gap = useTimelineStore.getState().gap;
  if (gap && sel?.kind !== "markers") return closeSelectedGap();
  // Markers: the lanes' own Delete handler (lanes/LanesPanel.tsx) removes or hides them.
  return false;
}

/** Closes the selected gap (the clips after it on the track move left). */
export function closeSelectedGap(): boolean {
  const doc = currentDoc();
  const gap = useTimelineStore.getState().gap;
  if (!doc || !gap) return false;
  const ok = commit(closeGap(doc, gap));
  if (ok) useTimelineStore.getState().selectGap(null);
  else toast({ title: "Nothing to close there", description: "The track is locked, or no clips come after the gap.", tone: "warn" });
  return ok;
}

/** Shift+Delete: deletes the selected clips and closes the space they leave. */
export function rippleDeleteSelection(): boolean {
  const doc = currentDoc();
  const sel = useEditStudio.getState().selection;
  if (!doc || sel?.kind !== "clips") return false;
  const ok = commit(rippleDelete(doc, sel.ids));
  if (ok) useEditStudio.getState().select(null);
  return ok;
}

/** Ctrl+C / Ctrl+X: the selected clips go on the clipboard (cut also deletes them). */
export function copySelection(cut: boolean): boolean {
  const doc = currentDoc();
  const sel = useEditStudio.getState().selection;
  if (!doc || sel?.kind !== "clips") return false;
  const data = copyClips(doc, sel.ids);
  if (!data) return false;
  useTimelineStore.getState().setClipboard(data);
  if (cut) return deleteSelection();
  return true;
}

/** Ctrl+V / Ctrl+Shift+V: pastes at the playhead on the selected track (else where the clips came from). */
export function pasteAtPlayhead(mode: DropMode): boolean {
  const doc = currentDoc();
  const data = useTimelineStore.getState().clipboard;
  if (!doc || !data) {
    toast({ title: "Nothing to paste", description: "Copy clips first (Ctrl+C).", tone: "warn" });
    return false;
  }
  const st = useEditStudio.getState();
  const target = st.selection?.kind === "track" ? st.selection.id : undefined;
  const res = pasteClips(doc, data, st.playheadMs, target, mode);
  if (!res.ok) {
    const why = res.reason === "locked" ? "That track is locked. Unlock it to paste there." : "Those clips don't fit that track (video clips go on video tracks, audio on audio tracks).";
    toast({ title: "Couldn't paste", description: why, tone: "warn" });
    return false;
  }
  commit(res.project);
  st.select({ kind: "clips", ids: res.ids });
  return true;
}

/** Ctrl+L: links the selected clips, or unlinks them when any is linked. */
export function toggleLinkSelection(): boolean {
  const doc = currentDoc();
  const sel = useEditStudio.getState().selection;
  if (!doc || sel?.kind !== "clips") return false;
  const out = toggleLink(doc, sel.ids);
  if (!out) toast({ title: "Select two or more clips to link", description: "They must be on unlocked tracks.", tone: "warn" });
  return commit(out);
}

/** Detach audio of the selected video clips: each gets an audio clip on the first free audio track. */
export function detachAudioOfSelection(): boolean {
  const doc = currentDoc();
  const st = useEditStudio.getState();
  if (!doc || st.selection?.kind !== "clips") return false;
  let next = doc;
  const audioIds: string[] = [];
  let silent = 0;
  for (const id of st.selection.ids) {
    const path = next.tracks.flatMap((t) => t.clips).find((c) => c.id === id)?.path ?? "";
    if (st.sources[path] && !st.sources[path]?.info.hasAudio) {
      silent++;
      continue;
    }
    if (!canDetachAudio(next, id)) continue;
    const r = detachAudio(next, id);
    if (r) {
      next = r.project;
      audioIds.push(r.audioId);
    }
  }
  if (!audioIds.length) {
    toast({ title: silent ? "That clip has no sound" : "Nothing to detach", description: silent ? undefined : "Pick a video clip that isn't linked yet and make sure an audio track can take it.", tone: "warn" });
    return false;
  }
  commit(next);
  // Both sides are linked: selecting the video clip alone leaves the audio clip ready to move.
  return true;
}

/** The selection a click on `clipId` makes: the clip with its linked partners (Alt: only that clip). */
export function clickSelection(doc: NormalProject, clipId: string, alt: boolean): string[] {
  return alt ? [clipId] : withLinked(doc, [clipId]);
}

/** M in the Video Editor: a marker at the playhead. */
export function addMarkerAtPlayhead(): boolean {
  const doc = currentDoc();
  if (!doc) return false;
  const r = addRulerMarker(doc, useEditStudio.getState().playheadMs);
  if (!r) return false;
  commit(r.project);
  useEditStudio.getState().select({ kind: "markers", ids: [r.id] });
  return true;
}

/** [ and ] in the Video Editor: the custom markers' timeline times. */
export function customMarkerTimes(doc: NormalProject): number[] {
  return rulerMarkers(doc).map((m) => m.ms);
}

/** Alt+[ / Alt+]: the playhead jumps to the previous or next keyframe of the selected clip. */
export function jumpToKeyframe(dir: -1 | 1): boolean {
  const doc = currentDoc();
  const st = useEditStudio.getState();
  if (!doc || st.selection?.kind !== "clips") return false;
  const sel = new Set(st.selection.ids);
  let best: number | null = null;
  for (const c of doc.tracks.flatMap((t) => t.clips)) {
    if (!sel.has(c.id)) continue;
    const k = neighbourKey(c, st.playheadMs, dir);
    if (k === null) continue;
    if (best === null || (dir > 0 ? k < best : k > best)) best = k;
  }
  if (best === null) return false;
  seekTo(best);
  return true;
}

/** ↑ / ↓: the previous or next edit point of any track. */
export function jumpToEditPoint(dir: -1 | 1): boolean {
  const doc = currentDoc();
  if (!doc) return false;
  const t = useEditStudio.getState().playheadMs;
  const points = editPoints(doc);
  const to = dir > 0 ? points.find((p) => p > t + 0.5) : points.slice().reverse().find((p) => p < t - 0.5);
  if (to === undefined) return false;
  seekTo(to);
  return true;
}

/** Razor: cuts the clip (and its links) at ms; `allTracks` cuts every unlocked track there. */
export function razorCut(clipId: string | null, ms: number, allTracks: boolean): boolean {
  const doc = currentDoc();
  if (!doc) return false;
  const t = Math.round(ms);
  const ids = allTracks
    ? doc.tracks.filter((tr) => !tr.locked).flatMap((tr) => tr.clips.filter((c) => c.startMs < t && t < c.endMs).map((c) => c.id))
    : clipId
      ? [clipId]
      : [];
  return commit(splitAt(doc, ids, t, { linked: true }));
}

/** The end of the edit, for I (the range's default end). */
export function editEndMs(): number {
  const doc = currentDoc();
  return doc ? editLength(doc) : 0;
}

/** Removes custom markers; hides derived ones. */
export function deleteMarkers(doc: NormalProject, ids: readonly string[]): NormalProject | null {
  const set = new Set(ids);
  const custom = doc.markers.custom.filter((m) => !set.has(m.id));
  const customIds = new Set(doc.markers.custom.map((m) => m.id));
  const hide = ids.filter((id) => !customIds.has(id) && !doc.markers.hidden.includes(id));
  if (custom.length === doc.markers.custom.length && !hide.length) return null;
  return { ...doc, markers: { ...doc.markers, custom, hidden: [...doc.markers.hidden, ...hide].slice(0, 5000) } };
}

export function duplicateSelection(): boolean {
  const doc = currentDoc();
  const sel = useEditStudio.getState().selection;
  if (!doc || sel?.kind !== "clips") return false;
  return commit(duplicateClips(doc, sel.ids));
}

/**
 * Puts source files on a video track one after the other from atMs (photos
 * and videos only; each lands after the previous). Selects what it added.
 * Returns the number of clips added.
 */
export function insertSources(paths: readonly string[], trackId: string, atMs: number, mode: InsertMode, markers: readonly Marker[], drop?: DropMode): number {
  const doc = currentDoc();
  if (!doc) return 0;
  const r = insertInto(doc, paths, trackId, atMs, mode, markers, drop);
  if (!r.ids.length) {
    const audio = doc.tracks.find((t) => t.id === trackId)?.kind === "audio";
    toast({ title: "No room there", description: audio ? "Pick a gap on an unlocked audio track, and drop sound files or videos with sound." : "Pick a gap on an unlocked video track, inside the edit.", tone: "warn" });
    return 0;
  }
  commit(r.project);
  useEditStudio.getState().select({ kind: "clips", ids: r.ids });
  return r.ids.length;
}

/** The sources one after the other from atMs on a track (video/photo on video tracks; sound on audio tracks). Pure over `doc`. */
function insertInto(doc: NormalProject, paths: readonly string[], trackId: string, atMs: number, mode: InsertMode, markers: readonly Marker[], drop?: DropMode): { project: NormalProject; ids: string[] } {
  const st = useEditStudio.getState();
  const markersMs = laneMarkersMs(markers, st.activeLane);
  const audioTrack = doc.tracks.find((t) => t.id === trackId)?.kind === "audio";
  let next = doc;
  let at = atMs;
  const ids: string[] = [];
  for (const path of paths) {
    const info = st.sources[path]?.info;
    if (audioTrack) {
      // Sound files, and videos (their own sound).
      if (!info || (info.kind !== "audio" && !(info.kind === "video" && info.hasAudio))) continue;
      const ins = insertAudioClipAt(next, trackId, { path, durationMs: info.durationMs }, at, drop);
      if (!ins) break;
      next = ins.project;
      ids.push(ins.clip.id);
      at = ins.clip.endMs;
      continue;
    }
    const kind = info?.kind === "image" ? "image" : info?.kind === "video" ? "video" : null;
    if (!kind) continue;
    const ins = insertClipAt(next, trackId, { kind, path, durationMs: info?.durationMs ?? 0 }, at, mode, { markersMs, ...(drop ? { drop } : {}) });
    if (!ins) break;
    next = ins.project;
    ids.push(ins.clip.id);
    at = ins.clip.endMs;
  }
  return { project: next, ids };
}

/**
 * A drop outside every track row makes a track for the sources: audio files get
 * an audio track (at the bottom), anything else a video track (on top). One undo step.
 */
export function dropOnNewTrack(paths: readonly string[], atMs: number, mode: InsertMode, markers: readonly Marker[], drop?: DropMode): number {
  const doc = currentDoc();
  if (!doc) return 0;
  const st = useEditStudio.getState();
  const audioOnly = paths.length > 0 && paths.every((p) => st.sources[p]?.info.kind === "audio");
  const withTrack = addTrack(doc, audioOnly ? "audio" : "video");
  if (!withTrack) {
    toast({ title: "An edit can have at most 8 tracks", tone: "warn" });
    return 0;
  }
  const created = audioOnly ? withTrack.tracks[0] : withTrack.tracks[withTrack.tracks.length - 1];
  if (!created) return 0;
  const r = insertInto(withTrack, paths, created.id, atMs, mode, markers, drop);
  if (!r.ids.length) {
    toast({ title: "Couldn't place those files", description: "Drop video, photos or sound files.", tone: "warn" });
    return 0;
  }
  commit(r.project);
  st.select({ kind: "clips", ids: r.ids });
  return r.ids.length;
}

/** The track a double-click inserts into: the selected video track, else the first unlocked one. */
export function insertionTrack(doc: NormalProject, sel: Selection): string | null {
  const picked = sel?.kind === "track" ? doc.tracks.find((t) => t.id === sel.id) : undefined;
  const t = picked && picked.kind === "video" && !picked.locked ? picked : doc.tracks.find((x) => x.kind === "video" && !x.locked);
  return t?.id ?? null;
}

/** Inserts sources at the playhead (double-click in the Sources panel). */
export function insertAtPlayhead(paths: readonly string[], markers: readonly Marker[]): number {
  const doc = currentDoc();
  if (!doc) return 0;
  const st = useEditStudio.getState();
  const track = insertionTrack(doc, st.selection);
  if (!track) {
    toast({ title: "No unlocked video track", tone: "warn" });
    return 0;
  }
  return insertSources(paths, track, st.playheadMs, "source", markers);
}

/** Split subject for the selected clip (a WP-ES7 operation on a clip with a ready matte). */
export function splitSubjectOfSelection(): boolean {
  const doc = currentDoc();
  const ids = selectedClipIds(useEditStudio.getState().selection);
  if (!doc || ids.length !== 1) {
    toast({ title: "Select one clip with a cut-out", tone: "warn" });
    return false;
  }
  const out = splitSubject(doc, ids[0] as string);
  if (!out) toast({ title: "That clip needs a ready cut-out (and room for another track)", tone: "warn" });
  return commit(out);
}
