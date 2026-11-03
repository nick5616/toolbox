/**
 * Requests that cross the home / editor boundary (handoffs, drops, the
 * palette): open the New edit dialog on the projects home (optionally
 * prefilled), or ask "Use as the song?" inside an open edit.
 */
import { create } from "zustand";

export interface NewEditRequest {
  /** A song to start from. */
  song?: string;
  /** Clips and photos to queue as the new edit's sources. */
  sources?: string[];
}

interface State {
  pending: NewEditRequest | null;
  /** An audio file dropped on an open edit, waiting for "Use as the song?". */
  songReplace: string | null;
  request(r?: NewEditRequest): void;
  clear(): void;
  askSong(path: string | null): void;
}

export const useNewEditRequest = create<State>((set) => ({
  pending: null,
  songReplace: null,
  request: (r = {}) => set({ pending: r }),
  clear: () => set({ pending: null }),
  askSong: (songReplace) => set({ songReplace }),
}));
