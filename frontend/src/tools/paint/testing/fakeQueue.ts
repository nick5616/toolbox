import type { GenerationGroup, PendingRegion, PerceptionQueue } from "@/paint/ai/types";
import type { PaintEngine } from "@/paint/engine/types";

/**
 * An in-memory PerceptionQueue: a submit shows a pending region for ~600 ms,
 * then resolves with a three-generation group. The real queue (P6) calls the
 * AI engine.
 */
export function createFakeQueue(_engine?: PaintEngine): PerceptionQueue {
  const pending = new Map<string, PendingRegion>();
  let groups: GenerationGroup[] = [];
  const subs = new Set<() => void>();
  let n = 0;
  const emit = () => subs.forEach((cb) => cb());
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const makeGroup = (toolId: string, bounds: GenerationGroup["bounds"], seed: number): GenerationGroup => ({
    id: `g${++n}`,
    toolId,
    bounds,
    seed,
    current: 2,
    generations: ["Original", "Pass 1", "Pass 2"].map((label, i) => ({ id: `g${n}-${i}`, label, bounds, thumb: "", history: null })),
  });

  return {
    submit(toolId, bounds, req) {
      const id = `p${++n}`;
      const region: PendingRegion = { id, jobId: "", toolId, bounds, state: "running", progress: 0.3, message: "Working" };
      pending.set(id, region);
      emit();
      return new Promise((resolve, reject) => {
        timers.set(
          id,
          setTimeout(() => {
            timers.delete(id);
            if (!pending.has(id)) return reject(new Error("cancelled"));
            pending.delete(id);
            const g = makeGroup(toolId, bounds, req.seed);
            groups = [g, ...groups].slice(0, 8);
            emit();
            resolve(g);
          }, 600),
        );
      });
    },
    cancel(id) {
      clearTimeout(timers.get(id));
      timers.delete(id);
      if (pending.delete(id)) emit();
    },
    pending: () => [...pending.values()],
    groups: () => groups,
    choose(groupId, index) {
      groups = groups.map((g) => (g.id === groupId ? { ...g, current: index } : g));
      emit();
    },
    async reroll(groupId) {
      const g = groups.find((x) => x.id === groupId);
      if (!g) throw new Error("No such group");
      const next = { ...g, seed: g.seed + 1, generations: [...g.generations, { id: `${g.id}-r${g.generations.length}`, label: `Re-roll ${g.generations.length - 2}`, bounds: g.bounds, thumb: "", history: null }] };
      next.current = next.generations.length - 1;
      groups = groups.map((x) => (x.id === groupId ? next : x));
      emit();
      return next;
    },
    on(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}
