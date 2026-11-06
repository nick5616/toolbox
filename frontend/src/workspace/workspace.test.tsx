import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { create } from "zustand";
import { createStore } from "zustand/vanilla";
import { ClickInHost } from "@/components";
import { setCurrentWindowForTest, parseWindow } from "@/lib/windows";
import { getPart } from "@/parts/registry";
import { hostBridge, resetBridgeStatusesForTest, type BridgeTransport } from "@/state/bridge";
import { defineWorkspace, setWorkspaceTransportForTest } from "./defineWorkspace";
import { fitBar, railFit, WorkspacePanel } from "./components";

/** An in-memory relay: every endpoint hears the others (or the one addressed); payloads are JSON round-tripped. */
class Hub {
  subs = new Map<string, Set<(p: unknown, from: string) => void>>();
  endpoint(key: string): BridgeTransport {
    return {
      send: (payload, to = "") => {
        const wire = JSON.parse(JSON.stringify(payload)) as unknown;
        for (const [k, set] of this.subs) {
          if (k === key || (to && to !== k)) continue;
          for (const cb of [...set]) cb(wire, key);
        }
      },
      on: (cb) => {
        const set = this.subs.get(key) ?? new Set();
        set.add(cb);
        this.subs.set(key, set);
        return () => set.delete(cb);
      },
    };
  }
}

describe("fitBar", () => {
  it.each([
    [["a", "b"], {}, 0, 2],
    [["a", "b"], {}, 300, 2],
    [["a", "b", "c"], {}, 300, 2],
    [["a", "b", "c"], { a: 40, b: 40, c: 40 }, 150, 3],
    [["a", "b", "c"], { a: 200 }, 210, 0],
  ] as const)("%j %j in %i px shows %i", (keys, widths, width, n) => {
    expect(fitBar(keys, widths, width)).toBe(n);
  });
});

describe("railFit", () => {
  it.each([
    [5, 0, 5],
    [5, 400, 5],
    [5, 160, 2],
    [3, 16 + 44 * 3, 3],
  ])("%i items in %i px → %i", (count, height, n) => {
    expect(railFit(count, height)).toBe(n);
  });
});

interface Doc {
  doc: { title: string } | null;
  count: number;
  bump: (by: number) => void;
}

const makeDocStore = () =>
  create<Doc>((set) => ({
    doc: null,
    count: 0,
    bump: (by) => set((s) => ({ count: s.count + by })),
  }));

function Counter() {
  const count = useReplicaStore((s) => s.count);
  return (
    <button type="button" onClick={() => useReplicaStore.getState().bump(1)}>
      count {count}
    </button>
  );
}

const useReplicaStore = makeDocStore();

const bridgeOf = {
  pick: (s: Doc) => ({ doc: s.doc, count: s.count }),
  apply: (store: { setState: (v: Partial<Doc>) => void }, v: Partial<{ doc: Doc["doc"]; count: number }>) => store.setState(v),
  actions: ["bump"] as const,
};

const ws = defineWorkspace({
  moduleId: "ws-test",
  store: useReplicaStore,
  bridge: { pick: bridgeOf.pick, apply: bridgeOf.apply, actions: ["bump"] },
  isOpen: (s) => s.doc !== null,
  panels: [{ id: "counter", title: "Counter", icon: "hash", tip: "Counts", component: Counter }],
  preview: { component: () => <p>preview</p> },
});

afterEach(() => {
  setWorkspaceTransportForTest(null);
  setCurrentWindowForTest(null);
  resetBridgeStatusesForTest();
});

describe("defineWorkspace", () => {
  it("registers a panel part and a preview part", () => {
    expect(ws.panelPart).toBe("ws-test.panel");
    expect(ws.previewPart).toBe("ws-test.preview");
    expect(getPart("ws-test.panel")?.headingFor?.(new URLSearchParams("panel=counter"))).toEqual({ title: "Counter", icon: "hash" });
    expect(getPart("ws-test.preview")).toBeDefined();
  });

  it("renders a panel in a part window from the host's store and forwards its actions", async () => {
    const hub = new Hub();
    setWorkspaceTransportForTest(() => hub.endpoint("replica"));
    setCurrentWindowForTest(parseWindow("?window=part&part=ws-test.panel&panel=counter&key=part:ws-test.panel@counter"));
    const host = createStore<Doc>((set) => ({ doc: { title: "A" }, count: 4, bump: (by) => set((s) => ({ count: s.count + by })) }));
    const stopHost = hostBridge(host, { name: ws.bridgeName, ...bridgeOf, actions: ["bump"] }, hub.endpoint("host"));
    const part = getPart("ws-test.panel");
    const disconnect = await part!.connect!(new URLSearchParams("panel=counter"));
    expect(ws.isReplica()).toBe(true);
    const Part = part!.component;
    render(<Part placement="window" />);
    expect(await screen.findByText("count 4")).toBeTruthy();
    await userEvent.click(screen.getByText("count 4"));
    expect(host.getState().count).toBe(5);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(screen.getByText("count 5")).toBeTruthy();
    disconnect();
    stopHost();
  });

  it("shows a launcher that opens the panel in a drawer", async () => {
    useReplicaStore.setState({ doc: { title: "B" }, count: 1 });
    render(
      <ClickInHost>
        <WorkspacePanel ws={ws} panel="counter" summary="one" />
      </ClickInHost>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Counter/ }));
    expect(screen.getByRole("dialog", { name: "Counter" })).toBeTruthy();
    expect(screen.getByText("count 1")).toBeTruthy();
  });
});
