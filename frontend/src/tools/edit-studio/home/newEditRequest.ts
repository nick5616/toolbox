/**
 * A request to open the New edit dialog on the projects home, optionally
 * prefilled (handoffs, drops, the palette). ProjectsHome consumes it.
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
  request(r?: NewEditRequest): void;
  clear(): void;
}

export const useNewEditRequest = create<State>((set) => ({
  pending: null,
  request: (r = {}) => set({ pending: r }),
  clear: () => set({ pending: null }),
}));
