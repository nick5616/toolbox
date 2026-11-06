import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ handlers: new Map<string, Set<(v: unknown) => void>>() }));

vi.mock("@/lib/events", () => ({
  on: (name: string, cb: (v: unknown) => void) => {
    const set = h.handlers.get(name) ?? new Set();
    set.add(cb);
    h.handlers.set(name, set);
    return () => set.delete(cb);
  },
}));
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, FocusService: { State: async () => ({ supported: true, session: null, last: null, stillOpen: null, friction: null }) } };
});

import { EMPTY_FOCUS_STATE, subscribeFocus, useFocus } from "./focus";

afterEach(() => useFocus.setState({ state: EMPTY_FOCUS_STATE, loaded: false }));

function emit(name: string, v: unknown) {
  for (const cb of h.handlers.get(name) ?? []) cb(v);
}

describe("subscribeFocus", () => {
  it("is reference-counted: a view leaving doesn't stop the shell's subscription", () => {
    const shell = subscribeFocus();
    const view = subscribeFocus();
    view();
    view(); // idempotent
    emit("focus:changed", { ...EMPTY_FOCUS_STATE, dryRun: true });
    expect(useFocus.getState().state.dryRun).toBe(true);
    shell();
    expect(h.handlers.get("focus:changed")?.size).toBe(0);
    emit("focus:changed", { ...EMPTY_FOCUS_STATE, dryRun: false });
    expect(useFocus.getState().state.dryRun).toBe(true);
  });
});
