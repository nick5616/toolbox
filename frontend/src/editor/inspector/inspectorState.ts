/** Small state helpers the Inspector and the overlays share: document edits, the clip time, the selected mask. */
import { create } from "zustand";
import type { EditClip, EditTrack } from "@/lib/api";
import { findClip, withClip, withTrack, type NormalProject } from "@/editor/doc";
import { useEditStudio } from "@/editor/store";

/** Applies `fn` to the current document through the store (undoable; same non-empty `key` within 800 ms = one step). */
export function editDoc(fn: (p: NormalProject) => NormalProject, key = ""): void {
  const st = useEditStudio.getState();
  const cur = st.history?.present;
  if (cur) st.edit(fn(cur), key);
}

export function patchClip(id: string, patch: Partial<EditClip>, key = ""): void {
  editDoc((p) => withClip(p, id, patch), key);
}

export function patchTrack(id: string, patch: Partial<EditTrack>, key = ""): void {
  editDoc((p) => withTrack(p, id, patch), key);
}

/** The clip with this ID in the current document. */
export function currentClip(id: string): EditClip | null {
  const p = useEditStudio.getState().history?.present;
  return p ? (findClip(p, id)?.clip ?? null) : null;
}

/**
 * The playhead in a clip's time (rounded ms). Re-renders on every playhead
 * change only while `live` (a param of the clip has keys) and playback is
 * stopped; otherwise it is constant 0.
 */
export function useClipTime(startMs: number, live: boolean): number {
  return useEditStudio((s) => (live && !s.playing ? Math.round(s.playheadMs - startMs) : 0));
}

/** The playhead in a clip's time, read now (for overlays). */
export function clipTimeNow(clip: Pick<EditClip, "startMs">): number {
  return Math.round(useEditStudio.getState().playheadMs - clip.startMs);
}

/** The mask whose handles show on the preview. Valid only while its clip is the selected one. */
interface MaskSel {
  clipId: string | null;
  maskId: string | null;
  select(clipId: string | null, maskId: string | null): void;
}

export const useMaskSelection = create<MaskSel>((set) => ({
  clipId: null,
  maskId: null,
  select: (clipId, maskId) => set({ clipId, maskId }),
}));

/** Song's "Change range…": shows Setup's range picker in place of the timeline. */
export function openRangePicker(): void {
  useEditStudio.getState().setSetupOpen(true);
}
