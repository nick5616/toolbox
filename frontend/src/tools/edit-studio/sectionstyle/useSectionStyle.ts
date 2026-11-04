/** Local UI state for the Section style dialog: open range, last settings per project, cached footage moments. */
import { create } from "zustand";
import { EditStudioService, type EditMoment } from "@/lib/api";
import type { Marker } from "@/viz/edit/types";
import { useEditStudio } from "@/editor/store";
import { DEFAULT_SETTINGS, rangeFromContext, type Range, type StyleSettings } from "./styleLogic";

interface SectionStyleState {
  /** The range the dialog was opened with, or null when closed. */
  range: Range | null;
  /** Last settings by project ID. */
  saved: Record<string, StyleSettings>;
  /** Footage moments by source path; fetched once. */
  moments: Record<string, readonly EditMoment[]>;
  open(range: Range): void;
  close(): void;
  save(projectId: string, s: StyleSettings): void;
  /** Fetches (once) the moments of these videos. Failures count as "no moments". */
  loadMoments(paths: readonly string[], fps: number): Promise<void>;
}

const inflight = new Set<string>();

export const useSectionStyle = create<SectionStyleState>((set, get) => ({
  range: null,
  saved: {},
  moments: {},
  open: (range) => set({ range }),
  close: () => set({ range: null }),
  save: (projectId, s) => set((st) => ({ saved: { ...st.saved, [projectId]: s } })),
  loadMoments: async (paths, fps) => {
    const todo = paths.filter((p) => p && !(p in get().moments) && !inflight.has(p));
    if (todo.length === 0) return;
    todo.forEach((p) => inflight.add(p));
    const got = await Promise.all(
      todo.map(async (p) => {
        try {
          return [p, (await EditStudioService.Moments(p, fps)) ?? []] as const;
        } catch {
          return [p, [] as EditMoment[]] as const;
        } finally {
          inflight.delete(p);
        }
      }),
    );
    set((st) => ({ moments: { ...st.moments, ...Object.fromEntries(got) } }));
  },
}));

export function savedSettings(projectId: string | null): StyleSettings {
  const s = projectId ? useSectionStyle.getState().saved[projectId] : undefined;
  return s ? { ...DEFAULT_SETTINGS, ...s } : { ...DEFAULT_SETTINGS };
}

/** Opens the dialog on the selection, else the section under the playhead, else the whole edit. */
export function openStyleFromContext(markers: readonly Marker[]): void {
  const st = useEditStudio.getState();
  const p = st.history?.present;
  if (!p) return;
  useSectionStyle.getState().open(rangeFromContext(p, markers, st.selection, st.playheadMs));
}
