/**
 * Split subject (Phase 9 SPEC §10.7). Wave 0 stub (owned by WP-ES7); the
 * signature is frozen. The timeline's clip menu (WP-ES2) and the Cut-out
 * section call it.
 */
import type { NormalProject } from "@/viz/edit/defaults";

/**
 * Duplicates a clip with a ready matte onto a new video track directly above
 * (same timing, cutout on, effects cleared on the copy). Null when the clip
 * has no matte or there are already 8 tracks.
 */
export function splitSubject(p: NormalProject, clipId: string): NormalProject | null {
  void p;
  void clipId;
  return null;
}
