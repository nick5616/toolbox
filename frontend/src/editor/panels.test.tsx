import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeProject } from "@/viz/edit/defaults";
import { fixtureProject } from "@/viz/edit/fixture";
import { EDITOR_PANEL_IDS } from "./panelDefs";
import { defineEditorWorkspace } from "./workspace";
import { EditorProfileProvider, PLAIN_PROFILE } from "./profileContext";
import { useEditStudio, type Selection } from "./store";

vi.mock("@/lib/api", async (orig) => {
  const m = await orig<typeof import("@/lib/api")>();
  return {
    ...m,
    EditStudioService: { ...m.EditStudioService, Fonts: async () => ["Inter"], InterpFor: async () => null, Probe: async () => [], Sources: async () => [], Mattes: async () => [] },
    MediaService: { ...m.MediaService, URLFor: async () => "" },
  };
});
vi.mock("@/editor/useEditAutosave", () => ({ flushEdit: async () => undefined }));

const ws = defineEditorWorkspace(PLAIN_PROFILE);
const listEditorPanels = () => [...ws.panels];
const getEditorPanel = (id: string) => ws.getPanel(id);

const st = () => useEditStudio.getState();

function open(selection: Selection) {
  st().close();
  st().open("p1", "Test", normalizeProject(fixtureProject()));
  st().select(selection);
}

beforeEach(() => open(null));
afterEach(cleanup);

describe("editor panels", () => {
  it("registers every constituent of the editor", () => {
    const ids = listEditorPanels().map((p) => p.id);
    for (const id of EDITOR_PANEL_IDS) expect(ids, id).toContain(id);
    expect(EDITOR_PANEL_IDS).toEqual(["media", "text", "music", "project", "track", "clip-transform", "clip-effects", "clip-masks", "clip-cutout", "clip-speed", "clip-transition", "clip-text-style", "clip-visual"]);
    for (const p of listEditorPanels()) {
      expect(p.component).toBeTruthy();
      expect(p.id).toMatch(/^[a-z0-9-]+$/);
      expect(p.title && p.icon && p.tip).toBeTruthy();
    }
  });

  it("part ids follow the contract", () => {
    expect(ws.panelPart).toBe("video-studio.panel");
    expect(ws.previewPart).toBe("video-studio.preview");
    expect(ws.bridgeName).toBe("editor");
  });

  const selections: Array<[string, Selection]> = [
    ["nothing selected", null],
    ["a video clip", { kind: "clips", ids: ["c1"] }],
    ["a photo", { kind: "clips", ids: ["c2"] }],
    ["an adjustment clip", { kind: "clips", ids: ["c4"] }],
    ["a track", { kind: "track", id: "t1" }],
  ];

  for (const id of EDITOR_PANEL_IDS) {
    for (const [label, sel] of selections) {
      it(`${id} renders standalone with no props (${label})`, () => {
        open(sel);
        const Body = getEditorPanel(id)!.component;
        const { container } = render(
          <EditorProfileProvider profile={PLAIN_PROFILE}>
            <Body />
          </EditorProfileProvider>,
        );
        expect(container.firstElementChild).toBeTruthy();
      });
    }
  }

  it("a panel shows nothing music-related under the plain profile", () => {
    open({ kind: "clips", ids: ["c1"] });
    for (const id of EDITOR_PANEL_IDS) {
      const Body = getEditorPanel(id)!.component;
      const { container, unmount } = render(
        <EditorProfileProvider profile={PLAIN_PROFILE}>
          <Body />
        </EditorProfileProvider>,
      );
      expect(container.textContent, id).not.toMatch(/Ken Burns|Velocity|Cut offset|Active lane|On the beat/);
      unmount();
    }
  });
});
