/**
 * Store bridge (Phase 10, SPEC.md §4.5): mirrors a zustand store from a host
 * window into replicas in other windows over `windows:relay`.
 *
 * Protocol on channel `bridge:<name>`:
 * - replica → host `{t:"hello"}` at start and every 2 s until a snapshot arrives;
 * - host → that replica `{t:"snap", seq, values}` (everything `pick` returns);
 * - host → all `{t:"patch", seq, values}` with only the changed keys, at most one per 16 ms,
 *   and none while no replica has said hello;
 * - replica → host `{t:"call", action, args}`: the replica's listed actions are replaced by
 *   forwarders and the host runs them (only listed actions);
 * - host → all `{t:"bye"}` on dispose (replicas report `lost` and keep saying hello, so a
 *   host that comes back is picked up again).
 * Values and args must be JSON-serialisable.
 */
import { create } from "zustand";
import type { StoreApi } from "zustand";
import { relayOn, relaySend } from "@/lib/windows";
import { useWindows } from "./windows";

export interface BridgeSpec<S, V extends Record<string, unknown>> {
  /** Channel is `bridge:<name>`. */
  name: string;
  /** Host: the shared values (each key is compared by reference). */
  pick(state: S): V;
  /** Replica: writes received values into its store. */
  apply(store: StoreApi<S>, values: Partial<V>): void;
  /** Replica calls these → they run on the host. */
  actions: readonly (keyof S & string)[];
}

export interface BridgeTransport {
  send(payload: unknown, to?: string): void;
  on(cb: (payload: unknown, from: string) => void): () => void;
}

export type BridgeStatus = "connecting" | "live" | "lost";

export const PATCH_INTERVAL_MS = 16;
export const HELLO_INTERVAL_MS = 2000;

/** The transport over `DesktopService.Relay`. */
export function relayTransport(name: string): BridgeTransport {
  const channel = `bridge:${name}`;
  return {
    send: (payload, to) => {
      relaySend(channel, payload, to ?? "").catch(() => {
        /* the other window may be gone */
      });
    },
    on: (cb) => relayOn(channel, (m) => cb(m.payload, m.from)),
  };
}

interface Msg {
  t?: unknown;
  seq?: unknown;
  values?: unknown;
  action?: unknown;
  args?: unknown;
}

function asMsg(p: unknown): Msg | null {
  return p && typeof p === "object" ? (p as Msg) : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Starts mirroring `store` to replicas. Returns dispose (says bye). */
export function hostBridge<S, V extends Record<string, unknown>>(
  store: StoreApi<S>,
  spec: BridgeSpec<S, V>,
  transport: BridgeTransport = relayTransport(spec.name),
): () => void {
  const replicas = new Set<string>();
  let last: V = spec.pick(store.getState());
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const next = spec.pick(store.getState());
    const changed: Record<string, unknown> = {};
    let any = false;
    for (const k of Object.keys(next)) {
      if (!Object.is(next[k], last[k])) {
        changed[k] = next[k];
        any = true;
      }
    }
    last = next;
    if (any && replicas.size > 0) {
      seq++;
      transport.send({ t: "patch", seq, values: changed });
    }
  };

  const unsubStore = store.subscribe(() => {
    if (disposed || replicas.size === 0 || timer !== undefined) return;
    timer = setTimeout(flush, PATCH_INTERVAL_MS);
  });

  const offTransport = transport.on((payload, from) => {
    const m = asMsg(payload);
    if (!m || disposed) return;
    if (m.t === "hello") {
      flush(); // bring the other replicas up to date, and `last` to now
      replicas.add(from);
      transport.send({ t: "snap", seq, values: spec.pick(store.getState()) }, from);
    } else if (m.t === "call") {
      const action = m.action;
      if (typeof action !== "string" || !spec.actions.includes(action as keyof S & string)) return;
      const fn = (store.getState() as Record<string, unknown>)[action];
      if (typeof fn !== "function") return;
      const args = Array.isArray(m.args) ? (m.args as unknown[]) : [];
      try {
        (fn as (...a: unknown[]) => unknown)(...args);
      } catch {
        /* an action failing on the host is the host's business */
      }
    }
  });

  // Replicas whose window closed no longer count (so an idle host stops sending patches).
  const unsubWindows = useWindows.subscribe((s) => {
    for (const r of [...replicas]) {
      if ((r.startsWith("tool:") || r.startsWith("part:")) && !s.open.includes(r)) replicas.delete(r);
    }
    if (replicas.size === 0 && timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  });

  return () => {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    unsubStore();
    unsubWindows();
    offTransport();
    transport.send({ t: "bye" });
  };
}

interface StatusState {
  byName: Record<string, BridgeStatus>;
  set: (name: string, s: BridgeStatus | null) => void;
}

const useStatuses = create<StatusState>((set) => ({
  byName: {},
  set: (name, s) =>
    set((st) => {
      const byName = { ...st.byName };
      if (s === null) delete byName[name];
      else byName[name] = s;
      return { byName };
    }),
}));

/** The status of this window's replica of bridge `name` ("none" when it has none). */
export function useBridgeStatus(name: string): BridgeStatus | "none" {
  return useStatuses((s) => s.byName[name] ?? "none");
}

/** Combined status of all of this window's replicas: lost if any is, else connecting if any is, else live; "none" without replicas. */
export function useBridgesStatus(): BridgeStatus | "none" {
  return useStatuses((s) => {
    const all = Object.values(s.byName);
    if (all.length === 0) return "none";
    if (all.includes("lost")) return "lost";
    if (all.includes("connecting")) return "connecting";
    return "live";
  });
}

/** Test hook: clears the status registry. */
export function resetBridgeStatusesForTest(): void {
  useStatuses.setState({ byName: {} });
}

/** Mirrors the host's store into `store`. Returns dispose. */
export function replicaBridge<S, V extends Record<string, unknown>>(
  store: StoreApi<S>,
  spec: BridgeSpec<S, V>,
  opts: { transport?: BridgeTransport; onStatus?(s: BridgeStatus): void } = {},
): () => void {
  const transport = opts.transport ?? relayTransport(spec.name);
  let lastSeq = -1;
  let live = false;
  let disposed = false;

  const setStatus = (s: BridgeStatus): void => {
    if (disposed) return;
    useStatuses.getState().set(spec.name, s);
    opts.onStatus?.(s);
  };

  // Forward the listed actions to the host. Replicas can overlap on one store
  // (React StrictMode runs connect twice and disposes the first one late), so a
  // forwarder remembers the real action it replaced, and dispose only restores
  // actions that are still its own forwarders.
  const originals: Record<string, unknown> = {};
  const forwarders: Record<string, unknown> = {};
  const current = store.getState() as Record<string, unknown>;
  for (const a of spec.actions) {
    const cur = current[a];
    const real = typeof cur === "function" && forwardedFrom.has(cur) ? forwardedFrom.get(cur) : cur;
    originals[a] = real;
    const fwd = (...args: unknown[]) => transport.send({ t: "call", action: a, args });
    forwardedFrom.set(fwd, real);
    forwarders[a] = fwd;
  }
  store.setState(forwarders as Partial<S>);

  const hello = (): void => transport.send({ t: "hello" });
  const off = transport.on((payload) => {
    const m = asMsg(payload);
    if (!m || disposed) return;
    if (m.t === "snap" && isRecord(m.values) && typeof m.seq === "number") {
      spec.apply(store, m.values as Partial<V>);
      lastSeq = m.seq;
      live = true;
      setStatus("live");
    } else if (m.t === "patch" && live && isRecord(m.values) && typeof m.seq === "number") {
      if (m.seq <= lastSeq) return;
      lastSeq = m.seq;
      spec.apply(store, m.values as Partial<V>);
    } else if (m.t === "bye") {
      live = false;
      lastSeq = -1;
      setStatus("lost");
    }
  });

  setStatus("connecting");
  hello();
  const retry = setInterval(() => {
    if (!live) hello();
  }, HELLO_INTERVAL_MS);

  return () => {
    if (disposed) return;
    clearInterval(retry);
    off();
    useStatuses.getState().set(spec.name, null);
    disposed = true;
    const now = store.getState() as Record<string, unknown>;
    const restore: Record<string, unknown> = {};
    for (const a of spec.actions) if (now[a] === forwarders[a]) restore[a] = originals[a];
    if (Object.keys(restore).length) store.setState(restore as Partial<S>);
  };
}

/** Forwarder → the real action it replaced (see replicaBridge). */
const forwardedFrom = new WeakMap<object, unknown>();
