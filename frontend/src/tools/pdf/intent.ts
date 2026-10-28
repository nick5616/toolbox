import { create } from "zustand";
import type { PdfAction } from "@/lib/api";

/** Palette → PDF view handoff: an action to preselect (consumed by the view). */
interface PdfIntent {
  action: PdfAction | null;
  request: (a: PdfAction) => void;
  clear: () => void;
}

export const usePdfIntent = create<PdfIntent>((set) => ({
  action: null,
  request: (action) => set({ action }),
  clear: () => set({ action: null }),
}));
