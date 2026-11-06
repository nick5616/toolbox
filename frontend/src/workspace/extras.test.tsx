import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createContext, useContext } from "react";
import { createStore } from "zustand/vanilla";
import { create } from "zustand";
import { parseWindow, setCurrentWindowForTest } from "@/lib/windows";
import { getPart } from "@/parts/registry";
import { resetBridgeStatusesForTest, type BridgeTransport } from "@/state/bridge";
import { bridgeOf, defineWorkspace, setWorkspaceTransportForTest } from "./defineWorkspace";

/** Two modules of one family: same store, same channels (the editor's pattern). */
interface Doc {
  doc: string | null;
  id: string | null;
  poke(): void;
}
interface Side {
  mode: string;
}

const useMain = create<Doc>(() => ({ doc: null, id: null, poke: () => undefined }));
const sideStore = createStore<Side>(() => ({ mode: "a" }));
const Tag = createContext("none");

const events: string[] = [];
const hosted: { name: string; side: string }[] = [];

function transportFor(name: string, side: "host" | "replica"): BridgeTransport {
  hosted.push({ name, side });
  return {
    send: (payload) => {
      const m = payload as { t?: string };
      // a replica's hello is answered with a snapshot, per channel
      if (side === "replica" && m.t === "hello") {
        const values = name === "fam" ? { doc: "D", id: "p1" } : { mode: "b" };
        queueMicrotask(() => listener.get(name)?.({ t: "snap", seq: 0, values }, "host"));
      }
    },
    on: (cb) => {
      listener.set(name, cb);
      return () => listener.delete(name);
    },
  };
}
const listener = new Map<string, (p: unknown, from: string) => void>();

function family(moduleId: string) {
  return defineWorkspace<Doc, { doc: string | null; id: string | null }>({
    moduleId,
    store: useMain,
    bridgeName: "fam",
    bridge: { pick: (s) => ({ doc: s.doc, id: s.id }), apply: (st, v) => st.setState(v), actions: ["poke"] },
    extraBridges: [bridgeOf(sideStore, { name: "fam-side", pick: (s) => ({ mode: s.mode }), apply: (st, v) => st.setState(v), actions: [] })],
    isHosting: (s) => s.id !== null,
    isOpen: (s) => s.doc !== null,
    wrap: ({ children }) => <Tag.Provider value={moduleId}>{children}</Tag.Provider>,
    onConnect: () => {
      events.push(`connect:${moduleId}`);
      return () => events.push(`disconnect:${moduleId}`);
    },
    panelTip: "A panel of the family",
    panels: [{ id: "p", title: "P", icon: "hash", tip: "t", component: () => <div>{`tag:${useContext(Tag)}:${useMain.getState().doc}:${sideStore.getState().mode}`}</div> }],
  });
}

const a = family("fam-a");
const b = family("fam-b");

afterEach(() => {
  cleanup();
  setWorkspaceTransportForTest(null);
  setCurrentWindowForTest(null);
  resetBridgeStatusesForTest();
  events.length = 0;
  hosted.length = 0;
  listener.clear();
  useMain.setState({ doc: null, id: null });
});

describe("workspaces sharing channels (the editor family)", () => {
  it("two modules share a bridge name, each with its own parts and the panel tip", () => {
    expect(a.bridgeName).toBe("fam");
    expect(b.bridgeName).toBe("fam");
    expect(getPart("fam-a.panel")).toMatchObject({ host: "fam-a", tip: "A panel of the family" });
    expect(getPart("fam-b.panel")?.host).toBe("fam-b");
  });

  it("a part window connects every channel, runs onConnect, wraps the panel and renders once all are live", async () => {
    setWorkspaceTransportForTest((side, name) => transportFor(name, side));
    setCurrentWindowForTest(parseWindow("?window=part&part=fam-a.panel&panel=p&key=part:fam-a.panel@p"));
    const part = getPart("fam-a.panel")!;
    const off = await part.connect!(new URLSearchParams("panel=p"));
    expect(hosted.filter((h) => h.side === "replica").map((h) => h.name).sort()).toEqual(["fam", "fam-side"]);
    expect(events).toEqual(["connect:fam-a"]);
    expect(a.isReplica()).toBe(true);
    const Part = part.component as React.ComponentType<{ placement: "window" }>;
    render(<Part placement="window" />);
    await act(async () => void (await Promise.resolve()));
    expect(screen.getByText("tag:fam-a:D:b")).toBeTruthy();
    off();
    expect(events).toEqual(["connect:fam-a", "disconnect:fam-a"]);
  });

  it("hosts both channels from isHosting (not isOpen) and stops them together", () => {
    setWorkspaceTransportForTest((side, name) => transportFor(name, side));
    const { unmount } = renderHook(() => b.useHost());
    expect(hosted).toEqual([]);
    act(() => useMain.setState({ id: "p1" }));
    expect(hosted.filter((h) => h.side === "host").map((h) => h.name).sort()).toEqual(["fam", "fam-side"]);
    unmount();
  });
});
