import { create } from "zustand";
import { DepsService, DepState, type DepStatus, type Job } from "@/lib/api";
import { useJobs } from "./jobs";

export type DepView = DepStatus & { requiredBy: string[]; recommendedBy: string[] };

export function normalizeDep(d: DepStatus): DepView {
  return { ...d, requiredBy: d.requiredBy ?? [], recommendedBy: d.recommendedBy ?? [] };
}

interface DepsState {
  list: DepView[];
  byId: Record<string, DepView>;
  checking: boolean;
  /** Counts deps:changed events (bootstrap ignores a List() reply older than an event). */
  gen: number;
  setAll: (list: DepStatus[], fromEvent?: boolean) => void;
  recheck: () => Promise<void>;
  /** Queues the yt-dlp install/update job. */
  updateYtDlp: () => Promise<Job>;
}

export const useDeps = create<DepsState>((set, get) => ({
  list: [],
  byId: {},
  checking: false,
  gen: 0,
  setAll: (list, fromEvent = false) => {
    const views = list.map(normalizeDep);
    set({ list: views, byId: Object.fromEntries(views.map((d) => [d.id, d])), gen: get().gen + (fromEvent ? 1 : 0) });
  },
  recheck: async () => {
    set({ checking: true });
    try {
      get().setAll((await DepsService.Recheck()) ?? []);
    } finally {
      set({ checking: false });
    }
  },
  updateYtDlp: async () => {
    const job = await DepsService.UpdateYtDlp();
    useJobs.getState().upsert(job);
    return job;
  },
}));

export function isOk(d: DepStatus | undefined): boolean {
  return d?.state === DepState.DepOK;
}

/** IDs among `ids` that aren't OK. */
export function missingDeps(byId: Record<string, DepView>, ids: string[]): string[] {
  return ids.filter((id) => !isOk(byId[id]));
}
