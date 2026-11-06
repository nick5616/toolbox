import { create } from "zustand";
import type { Output } from "@/lib/api";

/** The files of a merged "N files saved" toast, shown in a Send to… dialog. */
export interface BatchResults {
  moduleId: string;
  title: string;
  outputs: Output[];
}

interface BatchResultsState {
  current: BatchResults | null;
  show: (b: BatchResults) => void;
  close: () => void;
}

export const useBatchResults = create<BatchResultsState>((set) => ({
  current: null,
  show: (current) => set({ current }),
  close: () => set({ current: null }),
}));
