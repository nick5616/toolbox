// Undo history of a document (at least 100 steps), shared by the Video Editor and Edit Studio.
export const HISTORY_LIMIT = 200;
const COALESCE_MS = 800;

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  lastKey: string;
  lastAt: number;
}

export function newHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], lastKey: "", lastAt: 0 };
}

/**
 * Records `next`. Changes with the same non-empty `key` made within 800 ms of
 * each other (a slider drag, typing) share one undo step.
 */
export function pushHistory<T>(h: History<T>, next: T, key = "", now = Date.now()): History<T> {
  if (Object.is(next, h.present)) return h;
  if (key !== "" && key === h.lastKey && now - h.lastAt < COALESCE_MS) {
    return { ...h, present: next, future: [], lastAt: now };
  }
  const past = [...h.past, h.present];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { past, present: next, future: [], lastKey: key, lastAt: now };
}

export function undo<T>(h: History<T>): History<T> {
  const prev = h.past[h.past.length - 1];
  if (prev === undefined) return h;
  return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future], lastKey: "", lastAt: 0 };
}

export function redo<T>(h: History<T>): History<T> {
  const next = h.future[0];
  if (next === undefined) return h;
  return { past: [...h.past, h.present], present: next, future: h.future.slice(1), lastKey: "", lastAt: 0 };
}
