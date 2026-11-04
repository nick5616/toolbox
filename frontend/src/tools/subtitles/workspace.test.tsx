import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    SubtitlesService: { TranslationLanguages: async () => [], Styles: async () => [], TranslatorStatus: async () => ({ ready: true, model: "", error: "" }), Load: async () => [] },
    TranscribeService: { Languages: async () => [] },
    LyricVideoService: { Fonts: async () => [] },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
  };
});

import { parseWindow, setCurrentWindowForTest } from "@/lib/windows";
import { getPart } from "@/parts/registry";
import { hostBridge, resetBridgeStatusesForTest, type BridgeTransport } from "@/state/bridge";
import { setWorkspaceTransportForTest } from "@/workspace/defineWorkspace";
import { editorReducer, makeTab } from "./editor";
import { toRows, updateCue } from "./logic";
import { BRIDGED_ACTIONS, bridgedValues, initialData, useSubtitles, type SubtitlesState } from "./store";
import { subtitlesWorkspace as ws } from "./workspace";

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
  useSubtitles.setState(initialData());
});

/** A stand-in for the main window's store: real data, and the one action this test forwards. */
function makeHost() {
  const tab = makeTab("original", "Original", "en", toRows([{ startMs: 0, endMs: 2000, text: "Hello" }, { startMs: 2500, endMs: 4000, text: "World" }]));
  const host = createStore<SubtitlesState>(() => ({
    ...useSubtitles.getState(),
    ...initialData(),
    editor: { tabs: [tab], activeId: "original" },
    patchCue: (id, patch, key) => host.setState((s) => ({ editor: editorReducer(s.editor, { type: "edit", fn: (r) => updateCue(r, id, patch), key, at: Date.now() }) })),
  }));
  return host;
}

describe("Subtitles workspace parts", () => {
  it("registers the panels and the preview part", () => {
    expect(ws.panelPart).toBe("subtitles.panel");
    expect(ws.previewPart).toBe("subtitles.preview");
    expect(ws.panels.map((p) => p.id)).toEqual(["source", "transcription", "translate", "style", "export", "cues"]);
    expect(getPart("subtitles.panel")?.headingFor?.(new URLSearchParams("panel=cues"))).toEqual({ title: "Subtitles", icon: "captions" });
  });

  it("only mirrors what survives JSON, and forwards the editing actions", () => {
    expect(() => JSON.stringify(bridgedValues(useSubtitles.getState()))).not.toThrow();
    for (const a of ["patchCue", "rowAction", "undo", "seek", "save", "generate", "useCut"]) expect(BRIDGED_ACTIONS).toContain(a);
  });

  it("renders the cue list in a part window and an edit there reaches the host", async () => {
    const hub = new Hub();
    setWorkspaceTransportForTest(() => hub.endpoint("replica"));
    setCurrentWindowForTest(parseWindow("?window=part&part=subtitles.panel&panel=cues&key=part:subtitles.panel@cues"));
    const host = makeHost();
    const stop = hostBridge(host, { name: ws.bridgeName, pick: bridgedValues, apply: () => undefined, actions: BRIDGED_ACTIONS }, hub.endpoint("host"));
    const part = getPart("subtitles.panel");
    const disconnect = await part!.connect!(new URLSearchParams("panel=cues"));
    expect(ws.isReplica()).toBe(true);
    const Part = part!.component;
    render(<Part placement="window" />);

    const text = (await screen.findByLabelText("Subtitle 2 text")) as HTMLTextAreaElement;
    expect(text.value).toBe("World");
    await userEvent.type(text, "!");
    expect(host.getState().editor.tabs[0]?.history.present[1]?.text).toBe("World!");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    expect((screen.getByLabelText("Subtitle 2 text") as HTMLTextAreaElement).value).toBe("World!");
    disconnect();
    stop();
  });

  it("renders the preview part in a replica from the bridged document", async () => {
    const hub = new Hub();
    setWorkspaceTransportForTest(() => hub.endpoint("replica"));
    setCurrentWindowForTest(parseWindow("?window=part&part=subtitles.preview&key=part:subtitles.preview"));
    const host = makeHost();
    const stop = hostBridge(host, { name: ws.bridgeName, pick: bridgedValues, apply: () => undefined, actions: BRIDGED_ACTIONS }, hub.endpoint("host"));
    const part = getPart("subtitles.preview");
    const disconnect = await part!.connect!(new URLSearchParams(""));
    const Part = part!.component;
    render(<Part placement="window" />);
    // A subtitle file without a video: the preview offers to pick one.
    expect(await screen.findByText("No video to preview against")).toBeTruthy();
    disconnect();
    stop();
  });
});
