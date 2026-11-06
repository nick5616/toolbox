import { create } from "zustand";
import { FocusService, type FocusBlockEvent, type FocusSession, type FocusState } from "@/lib/api";
import { on } from "@/lib/events";

export const FOCUS_MODULE_ID = "focus";
export const MAX_BLOCKED_EVENTS = 50;

export const EMPTY_FOCUS_STATE: FocusState = {
  supported: true,
  unsupported: "",
  os: "",
  dryRun: false,
  learn: false,
  session: null,
  last: null,
  stillOpen: null,
  friction: null,
  quitReleased: false,
};

function fixSession(x: FocusSession | null): FocusSession | null {
  if (!x) return null;
  return { ...x, profile: { ...x.profile, rules: x.profile.rules ?? [] }, always: x.always ?? [], extra: x.extra ?? [], launched: x.launched ?? [] };
}

/** Go's nullable slices become arrays (session snapshots included). */
export function normalizeFocusState(s: FocusState): FocusState {
  return { ...s, session: fixSession(s.session), last: fixSession(s.last), stillOpen: s.stillOpen ?? [] };
}

/** True while a session is on (not ended). */
export function isActive(s: FocusState): boolean {
  return s.session != null && s.session.endedAt === 0;
}

export interface FocusStore {
  loaded: boolean;
  state: FocusState;
  /** Recent block events, oldest first (capped). */
  blocked: FocusBlockEvent[];
  setState: (s: FocusState) => void;
  addBlocked: (e: FocusBlockEvent) => void;
  load: () => Promise<void>;
}

export const useFocus = create<FocusStore>((set) => ({
  loaded: false,
  state: EMPTY_FOCUS_STATE,
  blocked: [],
  setState: (s) => set({ state: normalizeFocusState(s) }),
  addBlocked: (e) =>
    set((st) => {
      const next = [...st.blocked, e];
      return { blocked: next.length > MAX_BLOCKED_EVENTS ? next.slice(next.length - MAX_BLOCKED_EVENTS) : next };
    }),
  load: async () => {
    const state = await FocusService.State();
    set({ loaded: true, state: normalizeFocusState(state) });
  },
}));

let unsubscribers: Array<() => void> = [];

/**
 * Subscribes the store to `focus:changed` / `focus:blocked` and loads the state.
 * Idempotent: a second call replaces the first. Every window may call it.
 */
export function subscribeFocus(): () => void {
  for (const u of unsubscribers) u();
  const s = useFocus.getState;
  const subs = [on("focus:changed", (v) => s().setState(v)), on("focus:blocked", (e) => s().addBlocked(e))];
  unsubscribers = subs;
  void s()
    .load()
    .catch(() => undefined);
  return () => {
    for (const u of subs) u();
    unsubscribers = unsubscribers.filter((u) => !subs.includes(u));
  };
}
