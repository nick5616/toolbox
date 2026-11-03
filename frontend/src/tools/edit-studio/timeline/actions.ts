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
import { useEditStudio, type Selection } from "../store";
import { deleteClips, duplicateClips, laneMarkersMs, sliceAtMarkers, splitAt, type SourceFacts } from "./ops";

export function currentDoc(): NormalProject | null {
  return useEditStudio.getState().history?.present ?? null;
}

/** Records `next` (one undo step); false when there was nothing to do. */
export function commit(next: NormalProject | null, key = ""): boolean {
  if (!next) return false;
  useEditStudio.getState().edit(next, key);
  return true;
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
  if (sel?.kind === "markers") {
    const ok = commit(deleteMarkers(doc, sel.ids));
    if (ok) useEditStudio.getState().select(null);
    return ok;
  }
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
