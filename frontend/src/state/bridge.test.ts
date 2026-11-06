import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  HELLO_INTERVAL_MS,
  PATCH_INTERVAL_MS,
  hostBridge,
  replicaBridge,
  resetBridgeStatusesForTest,
  useBridgeStatus,
  type BridgeSpec,
  type BridgeStatus,
  type BridgeTransport,
} from "./bridge";
import { useWindows } from "./windows";
import { renderHook } from "@testing-library/react";

interface S {
  count: number;
  name: string;
  secret: number;
  inc: (by: number) => void;
  hidden: () => void;
}
type V = { count: number; name: string };

/** An in-memory relay: every endpoint hears every other endpoint (or the one addressed). Payloads are JSON round-tripped. */
class Hub {
  endpoints = new Map<string, Set<(p: unknown, from: string) => void>>();
  sent: { from: string; to: string; payload: unknown }[] = [];
  endpoint(key: string): BridgeTransport {
    return {
      send: (payload, to = "") => {
        const wire = JSON.parse(JSON.stringify(payload)) as unknown;
        this.sent.push({ from: key, to, payload: wire });
        for (const [k, subs] of this.endpoints) {
          if (k === key || (to && to !== k)) continue;
          for (const cb of [...subs]) cb(wire, key);
        }
      },
      on: (cb) => {
        const set = this.endpoints.get(key) ?? new Set();
        set.add(cb);
        this.endpoints.set(key, set);
        return () => set.delete(cb);
      },
    };
  }
}

const spec: BridgeSpec<S, V> = {
  name: "test",
  pick: (s) => ({ count: s.count, name: s.name }),
  apply: (store, v) => store.setState(v),
  actions: ["inc"],
};

function makeStore(): StoreApi<S> {
  const store = createStore<S>((set) => ({
    count: 0,
    name: "a",
    secret: 1,
    inc: (by) => set((s) => ({ count: s.count + by })),
    hidden: () => set({ secret: 99 }),
  }));
  return store;
}

const patches = (hub: Hub) => hub.sent.filter((m) => (m.payload as { t: string }).t === "patch");

describe("store bridge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useWindows.setState({ open: [] });
    resetBridgeStatusesForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a snapshot on hello and patches only changed keys, coalesced", () => {
    const hub = new Hub();
    const host = makeStore();
    host.setState({ count: 5 });
    const dispose = hostBridge(host, spec, hub.endpoint("main"));
    const r1 = makeStore();
    const statuses: BridgeStatus[] = [];
    replicaBridge(r1, spec, { transport: hub.endpoint("part:a"), onStatus: (s) => statuses.push(s) });
    expect(r1.getState().count).toBe(5);
    expect(statuses).toEqual(["connecting", "live"]);

    host.setState({ count: 6 });
    host.setState({ count: 7 });
    host.setState({ secret: 2 }); // not picked
    expect(patches(hub)).toHaveLength(0);
    vi.advanceTimersByTime(PATCH_INTERVAL_MS);
    expect(patches(hub)).toHaveLength(1);
    expect(patches(hub)[0]?.payload).toMatchObject({ t: "patch", values: { count: 7 } });
    expect(Object.keys((patches(hub)[0]?.payload as { values: object }).values)).toEqual(["count"]);
    expect(r1.getState().count).toBe(7);
    expect(r1.getState().secret).toBe(1);
    dispose();
  });

  it("sends nothing while no replica has said hello", () => {
    const hub = new Hub();
    const host = makeStore();
    hostBridge(host, spec, hub.endpoint("main"));
    host.setState({ count: 1 });
    vi.advanceTimersByTime(100);
    expect(hub.sent).toHaveLength(0);
    // a late replica still gets the current values in its snapshot
    host.setState({ count: 2 });
    const r = makeStore();
    replicaBridge(r, spec, { transport: hub.endpoint("part:a") });
    expect(r.getState().count).toBe(2);
    vi.advanceTimersByTime(100);
    expect(patches(hub)).toHaveLength(0);
  });

  it("keeps forwarding when two replicas overlap on one store and the first is disposed late (StrictMode)", () => {
    const hub = new Hub();
    const host = makeStore();
    hostBridge(host, spec, hub.endpoint("main"));
    const r = makeStore();
    const realInc = r.getState().inc;
    const d1 = replicaBridge(r, spec, { transport: hub.endpoint("part:a") });
    const d2 = replicaBridge(r, spec, { transport: hub.endpoint("part:a") });
    d1(); // the first connect resolves after the remount
    r.getState().inc(2);
    expect(host.getState().count).toBe(2);
    expect(r.getState().count).toBe(0);
    d2();
    expect(r.getState().inc).toBe(realInc);
  });

  it("keeps two replicas in sync and forwards actions to the host", () => {
    const hub = new Hub();
    const host = makeStore();
    hostBridge(host, spec, hub.endpoint("main"));
    const r1 = makeStore();
    const r2 = makeStore();
    replicaBridge(r1, spec, { transport: hub.endpoint("part:a") });
    replicaBridge(r2, spec, { transport: hub.endpoint("part:b") });

    r1.getState().inc(3); // forwarded: runs on the host
    expect(r1.getState().count).toBe(0);
    expect(host.getState().count).toBe(3);
    vi.advanceTimersByTime(PATCH_INTERVAL_MS);
    expect(r1.getState().count).toBe(3);
    expect(r2.getState().count).toBe(3);

    host.setState({ name: "z" });
    vi.advanceTimersByTime(PATCH_INTERVAL_MS);
    expect(r1.getState().name).toBe("z");
    expect(r2.getState().name).toBe("z");
  });

  it("runs only listed actions on the host", () => {
    const hub = new Hub();
    const host = makeStore();
    hostBridge(host, spec, hub.endpoint("main"));
    const rogue = hub.endpoint("part:evil");
    rogue.send({ t: "call", action: "hidden", args: [] });
    rogue.send({ t: "call", action: "nope", args: [] });
    rogue.send({ t: "call", action: "inc", args: [2] });
    expect(host.getState().secret).toBe(1);
    expect(host.getState().count).toBe(2);
  });

  it("retries hello every 2 s until a host answers, then stops", () => {
    const hub = new Hub();
    const r = makeStore();
    const dispose = replicaBridge(r, spec, { transport: hub.endpoint("part:a") });
    const hellos = () => hub.sent.filter((m) => (m.payload as { t: string }).t === "hello").length;
    expect(hellos()).toBe(1);
    vi.advanceTimersByTime(HELLO_INTERVAL_MS);
    expect(hellos()).toBe(2);
    const host = makeStore();
    hostBridge(host, spec, hub.endpoint("main"));
    vi.advanceTimersByTime(HELLO_INTERVAL_MS);
    expect(hellos()).toBe(3);
    expect(r.getState().count).toBe(0);
    vi.advanceTimersByTime(HELLO_INTERVAL_MS * 3);
    expect(hellos()).toBe(3);
    dispose();
  });

  it("reports lost on bye and recovers when a host returns; dispose restores actions", () => {
    const hub = new Hub();
    const host = makeStore();
    const stopHost = hostBridge(host, spec, hub.endpoint("main"));
    const r = makeStore();
    const original = r.getState().inc;
    const seen: BridgeStatus[] = [];
    const dispose = replicaBridge(r, spec, { transport: hub.endpoint("part:a"), onStatus: (s) => seen.push(s) });
    expect(r.getState().inc).not.toBe(original);
    stopHost();
    expect(seen.at(-1)).toBe("lost");
    const host2 = makeStore();
    host2.setState({ count: 9 });
    hostBridge(host2, spec, hub.endpoint("main"));
    vi.advanceTimersByTime(HELLO_INTERVAL_MS);
    expect(seen.at(-1)).toBe("live");
    expect(r.getState().count).toBe(9);
    dispose();
    expect(r.getState().inc).toBe(original);
  });

  it("drops replicas whose window closed", () => {
    const hub = new Hub();
    const host = makeStore();
    hostBridge(host, spec, hub.endpoint("main"));
    useWindows.setState({ open: ["part:a"] });
    const r = makeStore();
    replicaBridge(r, spec, { transport: hub.endpoint("part:a") });
    host.setState({ count: 1 });
    vi.advanceTimersByTime(PATCH_INTERVAL_MS);
    expect(patches(hub)).toHaveLength(1);
    useWindows.setState({ open: [] });
    host.setState({ count: 2 });
    vi.advanceTimersByTime(100);
    expect(patches(hub)).toHaveLength(1);
  });

  it("ignores stale patches and exposes status through the hook", () => {
    const hub = new Hub();
    const r = makeStore();
    const dispose = replicaBridge(r, spec, { transport: hub.endpoint("part:a") });
    const hook = renderHook(() => useBridgeStatus("test"));
    expect(hook.result.current).toBe("connecting");
    const rogue = hub.endpoint("main");
    rogue.send({ t: "patch", seq: 1, values: { count: 4 } }); // before a snapshot: ignored
    expect(r.getState().count).toBe(0);
    rogue.send({ t: "snap", seq: 5, values: { count: 1, name: "x" } });
    hook.rerender();
    expect(hook.result.current).toBe("live");
    rogue.send({ t: "patch", seq: 5, values: { count: 100 } });
    expect(r.getState().count).toBe(1);
    rogue.send({ t: "patch", seq: 6, values: { count: 2 } });
    expect(r.getState().count).toBe(2);
    dispose();
    hook.rerender();
    expect(hook.result.current).toBe("none");
  });
});
