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
  /** The friction dialog was closed without cancelling: the countdown keeps running in the engine. */
  frictionHidden: boolean;
  setFrictionHidden: (hidden: boolean) => void;
  setState: (s: FocusState) => void;
  addBlocked: (e: FocusBlockEvent) => void;
  load: () => Promise<void>;
}

export const useFocus = create<FocusStore>((set) => ({
  loaded: false,
  state: EMPTY_FOCUS_STATE,
  blocked: [],
  frictionHidden: false,
  setFrictionHidden: (hidden) => set({ frictionHidden: hidden }),
  setState: (s) => set((st) => ({ state: normalizeFocusState(s), frictionHidden: s.friction ? st.frictionHidden : false })),
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

let subscribers = 0;
let teardown: Array<() => void> = [];

/**
 * Subscribes the store to `focus:changed` / `focus:blocked` and loads the state.
 * Reference-counted: one underlying listener while any subscriber is alive; the
 * returned function only decrements. Every window may call it.
 */
export function subscribeFocus(): () => void {
  const s = useFocus.getState;
  if (subscribers === 0) {
    teardown = [on("focus:changed", (v) => s().setState(v)), on("focus:blocked", (e) => s().addBlocked(e))];
  }
  subscribers++;
  void s()
    .load()
    .catch(() => undefined);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    subscribers--;
    if (subscribers === 0) {
      for (const u of teardown) u();
      teardown = [];
    }
  };
}
