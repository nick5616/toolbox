import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { setCurrentWindowForTest, parseWindow } from "@/lib/windows";
import { getPart } from "@/parts/registry";
import { hostBridge, resetBridgeStatusesForTest, type BridgeTransport } from "@/state/bridge";
import { setWorkspaceTransportForTest } from "@/workspace/defineWorkspace";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, ClipboardService: { CopyText: async () => undefined } };
});

import { devUtilsWorkspace as ws } from "./workspace";
import { useDevUtils, type DevUtilsStore } from "./store";

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

afterEach(() => {
  setWorkspaceTransportForTest(null);
  setCurrentWindowForTest(null);
  resetBridgeStatusesForTest();
});

describe("Dev Utilities workspace", () => {
  it("has a panel per utility", () => {
    expect(ws.panels.map((p) => p.id)).toContain("jwt");
    expect(ws.panels).toHaveLength(12);
  });

  it("a utility renders in a replica and its edit reaches the host", async () => {
    const hub = new Hub();
    setWorkspaceTransportForTest(() => hub.endpoint("replica"));
    setCurrentWindowForTest(parseWindow("?window=part&part=dev-utils.panel&panel=json&key=part:dev-utils.panel@json"));
    const host = createStore<DevUtilsStore>((set) => ({
      values: { "json.input": '{"a":1}' },
      setValue: (key, value) => set((s) => ({ values: { ...s.values, [key]: value } })),
    }));
    const stopHost = hostBridge(
      host,
      { name: ws.bridgeName, pick: (s) => ({ values: s.values }), apply: () => undefined, actions: ["setValue"] },
      hub.endpoint("host"),
    );
    const part = getPart("dev-utils.panel");
    const disconnect = await part!.connect!(new URLSearchParams("panel=json"));
    const Part = part!.component;
    render(<Part placement="window" />);
    const input = (await screen.findByLabelText("JSON input")) as HTMLTextAreaElement;
    await waitFor(() => expect(input.value).toBe('{"a":1}'));
    fireEvent.change(input, { target: { value: "[1,2]" } });
    expect(input.value).toBe("[1,2]");
    await waitFor(() => expect(host.getState().values["json.input"]).toBe("[1,2]"));
    disconnect();
    stopHost();
    useDevUtils.setState({ values: {} });
  });
});
