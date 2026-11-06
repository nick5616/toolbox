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
import { deleteClips, duplicateClips, insertClipAt, laneMarkersMs, sliceAtMarkers, splitAt, type InsertMode, type SourceFacts } from "./ops";

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
  return commit(splitAt(doc, splitTargets(doc, selection, playheadMs), playheadMs));
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
  // Markers: the lanes' own Delete handler (lanes/LanesPanel.tsx) removes or hides them.
  return false;
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
export function insertSources(paths: readonly string[], trackId: string, atMs: number, mode: InsertMode, markers: readonly Marker[]): number {
  const doc = currentDoc();
  if (!doc) return 0;
  const st = useEditStudio.getState();
  const markersMs = laneMarkersMs(markers, st.activeLane);
  let next = doc;
  let at = atMs;
  const added: string[] = [];
  for (const path of paths) {
    const info = st.sources[path]?.info;
    const kind = info?.kind === "image" ? "image" : info?.kind === "video" ? "video" : null;
    if (!kind) continue;
    const ins = insertClipAt(next, trackId, { kind, path, durationMs: info?.durationMs ?? 0 }, at, mode, { markersMs });
    if (!ins) break;
    next = ins.project;
    added.push(ins.clip.id);
    at = ins.clip.endMs;
  }
  if (!added.length) {
    toast({ title: "No room there", description: "Pick a gap on an unlocked video track, inside the edit.", tone: "warn" });
    return 0;
  }
  commit(next);
  st.select({ kind: "clips", ids: added });
  return added.length;
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
