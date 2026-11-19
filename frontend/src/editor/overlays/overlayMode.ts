/** Which preview tool is armed (Phase 21 SPEC §B4): crop handles for a clip, or the key-colour eyedropper. */
import { create } from "zustand";

export interface PickTarget {
  clipId: string;
  /** The chroma key effect whose colour is being picked. */
  postId: string;
  /** The effect's colour parameter. */
  param: string;
}

interface OverlayMode {
  /** The clip whose crop edges are shown on the preview. */
  cropClipId: string | null;
  pick: PickTarget | null;
  /** Why the last pick failed (shown beside the Pick button), or null. */
  pickError: string | null;
  setCrop(clipId: string | null): void;
  startPick(t: PickTarget): void;
  endPick(error?: string | null): void;
}

export const useOverlayMode = create<OverlayMode>((set) => ({
  cropClipId: null,
  pick: null,
  pickError: null,
  setCrop: (cropClipId) => set({ cropClipId }),
  startPick: (pick) => set({ pick, pickError: null }),
  endPick: (error = null) => set({ pick: null, pickError: error }),
}));
