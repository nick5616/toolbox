/** A small cache of each source's footage moments (§24.3): one `EditStudioService.Moments` call per file and frame rate. */
import { useEffect } from "react";
import { create } from "zustand";
import { EditStudioService, type EditMoment } from "@/lib/api";
import { toAppError } from "@/lib/errors";

export interface MomentsEntry {
  state: "loading" | "ready" | "error";
  moments: EditMoment[];
  error?: string;
}

interface MomentsState {
  entries: Record<string, MomentsEntry>;
  /** 0..1, scales the pulses the Moments section writes. */
  strength: number;
  setStrength(v: number): void;
  ensure(path: string, fps: number, force?: boolean): void;
}

export const momentsKey = (path: string, fps: number): string => `${path}|${fps}`;

const NONE: MomentsEntry = { state: "loading", moments: [] };

export const useMoments = create<MomentsState>((set, get) => ({
  entries: {},
  strength: 1,
  setStrength: (strength) => set({ strength: Math.max(0, Math.min(1, strength)) }),
  ensure(path, fps, force = false) {
    if (!path) return;
    const key = momentsKey(path, fps);
    const cur = get().entries[key];
    if (cur && !(force && cur.state === "error")) return;
    set((s) => ({ entries: { ...s.entries, [key]: { state: "loading", moments: [] } } }));
    Promise.resolve()
      .then(() => EditStudioService.Moments(path, fps))
      .then(
        (list) => set((s) => ({ entries: { ...s.entries, [key]: { state: "ready", moments: list ?? [] } } })),
        (err: unknown) => set((s) => ({ entries: { ...s.entries, [key]: { state: "error", moments: [], error: toAppError(err).message } } })),
    );
  },
}));

/** The moments of a video file (starts loading on first use). */
export function useFootageMoments(path: string, fps: number): MomentsEntry {
  const entry = useMoments((s) => s.entries[momentsKey(path, fps)]);
  useEffect(() => {
    if (path) useMoments.getState().ensure(path, fps);
  }, [path, fps]);
  return entry ?? NONE;
}
