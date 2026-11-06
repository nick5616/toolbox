/**
 * Undo history across whole-tool pop-outs (and Bring back). Each window is its
 * own JS context, so a tool that moves to another window would start with an
 * empty history. A tool registers a `HistoryAdapter` (how to read and install
 * the history of its open document); the window giving the tool up parks
 * `{docId, past, future, at}` in module state and the window that opens the
 * same document within a minute takes it once and installs it around the
 * document it loaded. A different document or a stale park is ignored and
 * cleared. Replicas (part windows) never park or take.
 *
 * - Main window: parks when the tool is popped out (`parkForPopOut`, called by
 *   `runBeforePopOut`).
 * - Tool window: parks (debounced) after every change, so Bring back and
 *   closing the window both leave the latest history behind.
 */
import { SettingsService } from "@/lib/api";
import { currentWindow } from "@/lib/windows";

export const PARK_MAX_AGE_MS = 60_000;
/** The parked JSON never exceeds this; the oldest undo steps are dropped first. */
export const PARK_MAX_BYTES = 4 * 1024 * 1024;
export const PARK_DEBOUNCE_MS = 400;
/** A park that was just taken stays available this long so a StrictMode re-open on the same page still finds it. */
export const RETAKE_MS = 3000;

export interface HistorySteps {
  past: unknown[];
  future: unknown[];
}

export interface HistoryAdapter {
  /** The id of the open document (null when none). */
  docId(): string | null;
  /** The open document's undo and redo steps (null when none). */
  read(): HistorySteps | null;
  /** Installs steps around the document that is open now. */
  write(steps: HistorySteps): void;
  /** Calls `cb` whenever the history changed; returns the unsubscribe. */
  subscribe(cb: () => void): () => void;
}

interface Parked {
  v: 1;
  moduleId: string;
  docId: string;
  at: number;
  past: unknown[];
  future: unknown[];
}

interface Entry {
  adapter: HistoryAdapter;
  moduleIds: string[];
}

const adapters = new Map<string, Entry>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const taken = new Map<string, { rec: Parked; takenAt: number }>();

export const parkKey = (adapterId: string): string => `${adapterId}.parked-history`;

/** Registers a tool's history under `id`; `moduleIds` are the tools whose pop-out parks it. Re-registering replaces. */
export function registerHistory(id: string, moduleIds: string[], adapter: HistoryAdapter): void {
  adapters.set(id, { adapter, moduleIds });
  adapter.subscribe(() => {
    if (currentWindow().kind !== "tool") return;
    clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        void park(id);
      }, PARK_DEBOUNCE_MS),
    );
  });
}

const size = (v: unknown): number => JSON.stringify(v).length;

/** Drops the oldest past steps (then the farthest redo steps) until the JSON fits; null when even the rest can't. */
export function capSteps(steps: HistorySteps, maxBytes = PARK_MAX_BYTES): HistorySteps | null {
  const past = steps.past;
  const future = [...steps.future];
  const pastSizes = past.map(size);
  const futureSizes = future.map(size);
  let total = 200 + pastSizes.reduce((a, b) => a + b + 1, 0) + futureSizes.reduce((a, b) => a + b + 1, 0);
  let dropPast = 0;
  while (total > maxBytes && dropPast < past.length) total -= (pastSizes[dropPast++] ?? 0) + 1;
  while (total > maxBytes && future.length > 0) {
    future.pop();
    total -= (futureSizes.pop() ?? 0) + 1;
  }
  return total > maxBytes ? null : { past: past.slice(dropPast), future };
}

/** Writes the history of adapter `id` into module state (an empty record when there is nothing to keep; nothing in a replica). */
export async function park(id: string, now: number = Date.now()): Promise<void> {
  const kind = currentWindow().kind;
  if (kind !== "main" && kind !== "tool") return;
  const e = adapters.get(id);
  if (!e) return;
  const docId = e.adapter.docId();
  const steps = e.adapter.read();
  if (!docId || !steps) return;
  let json = "";
  if (steps.past.length > 0 || steps.future.length > 0) {
    const capped = capSteps(steps);
    if (capped) {
      const rec: Parked = { v: 1, moduleId: id, docId, at: now, ...capped };
      json = JSON.stringify(rec);
    }
  }
  await SettingsService.SetModuleState(parkKey(id), json).catch(() => undefined);
}

/** Parks every history that belongs to `moduleId` (called before its tool pops out). */
export async function parkForPopOut(moduleId: string): Promise<void> {
  for (const [id, e] of adapters) {
    if (e.moduleIds.includes(moduleId)) await park(id);
  }
}

function isParked(v: unknown): v is Parked {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Partial<Parked>;
  return p.v === 1 && typeof p.docId === "string" && typeof p.at === "number" && Array.isArray(p.past) && Array.isArray(p.future);
}

/**
 * Call right after a document was opened: installs the history parked for the
 * same document (taken once; a different or stale one is cleared and ignored).
 * Resolves true when a history was installed.
 */
export async function adoptParkedHistory(id: string, docId: string, now: number = Date.now()): Promise<boolean> {
  const kind = currentWindow().kind;
  if (kind !== "main" && kind !== "tool") return false;
  const e = adapters.get(id);
  if (!e || !docId) return false;
  let rec: Parked | null = null;
  const again = taken.get(id);
  if (again && now - again.takenAt < RETAKE_MS) rec = again.rec;
  else {
    taken.delete(id);
    let raw = "";
    try {
      raw = await SettingsService.ModuleState(parkKey(id));
    } catch {
      return false;
    }
    if (!raw) return false;
    await SettingsService.SetModuleState(parkKey(id), "").catch(() => undefined);
    try {
      const parsed: unknown = JSON.parse(raw);
      rec = isParked(parsed) ? parsed : null;
    } catch {
      rec = null;
    }
    if (rec) taken.set(id, { rec, takenAt: now });
  }
  if (!rec || rec.docId !== docId || now - rec.at > PARK_MAX_AGE_MS) {
    taken.delete(id); // a different or stale park is dropped for good
    return false;
  }
  if (e.adapter.docId() !== docId) return false;
  const cur = e.adapter.read();
  if (!cur || cur.past.length > 0 || cur.future.length > 0) return false; // the user already edited
  e.adapter.write({ past: rec.past, future: rec.future });
  return true;
}

/** Test hook. */
export function resetParkedHistoryForTest(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  taken.clear();
}
