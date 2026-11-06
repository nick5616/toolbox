/**
 * Embed sessions (Phase 11, SPEC §4.1): when a file tool is embedded in
 * another tool, the jobs it submitted since it was opened are "this session":
 * the Active list shows only those, and results list them first. `submitJobs`
 * records the ids it gets back; a standalone tool ignores all of this.
 */
import { useMemo } from "react";
import { create } from "zustand";
import { useEmbed, type EmbedContextValue } from "@/lib/embed";
import { useOrderedJobs, type JobView } from "@/state/jobs";

interface Submitted {
  id: string;
  at: number;
}

interface SubmittedState {
  subs: Submitted[];
  add: (ids: string[]) => void;
}

const MAX_KEPT = 200;

const useSubmitted = create<SubmittedState>((set) => ({
  subs: [],
  add: (ids) => {
    if (ids.length === 0) return;
    const at = Date.now();
    set((s) => ({ subs: [...s.subs, ...ids.map((id) => ({ id, at }))].slice(-MAX_KEPT) }));
  },
}));

/** Remembers job ids a tool just submitted (called by `submitJobs`). */
export function recordSubmitted(ids: string[]): void {
  useSubmitted.getState().add(ids);
}

const starts = new WeakMap<EmbedContextValue, number>();

function sessionStart(embed: EmbedContextValue): number {
  let t = starts.get(embed);
  if (t === undefined) {
    t = Date.now();
    starts.set(embed, t);
  }
  return t;
}

/** Ids of the jobs submitted from this embed session, or null when the tool isn't embedded. */
export function useSessionJobIds(): ReadonlySet<string> | null {
  const embed = useEmbed();
  const subs = useSubmitted((s) => s.subs);
  return useMemo(() => {
    if (!embed) return null;
    const from = sessionStart(embed);
    return new Set(subs.filter((s) => s.at >= from).map((s) => s.id));
  }, [embed, subs]);
}

/** Stable partition: jobs in `ids` first, each group keeping its order. `ids` null = unchanged. */
export function sessionFirst<T extends { id: string }>(jobs: readonly T[], ids: ReadonlySet<string> | null): T[] {
  if (!ids || ids.size === 0) return [...jobs];
  return [...jobs.filter((j) => ids.has(j.id)), ...jobs.filter((j) => !ids.has(j.id))];
}

/**
 * `useOrderedJobs(moduleId)` for tool result lists: embedded, the jobs
 * submitted from this embed session come first. Standalone it's identical.
 */
export function useToolJobs(moduleId: string): JobView[] {
  const jobs = useOrderedJobs(moduleId);
  const ids = useSessionJobIds();
  return useMemo(() => (ids ? sessionFirst(jobs, ids) : jobs), [jobs, ids]);
}
