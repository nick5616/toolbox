/**
 * Both tools are the same shell with a different profile: the Video Editor
 * (no song needed) and Edit Studio (needs an analysed song, has the focus switch).
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    EditStudioService: { List: async () => [], Get: async () => null, SaveThumb: async () => undefined, Probe: async () => [] },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
  };
});
vi.mock("@/tools/_kit", () => ({ DepsGate: () => null }));
vi.mock("@/viz/edit/EditCanvas", () => ({ EditCanvas: () => <div data-testid="canvas" /> }));
vi.mock("@/editor/sources/SourcesPanel", () => ({ SourcesPanel: () => null }));
vi.mock("@/editor/overlays/PreviewOverlays", () => ({ PreviewOverlays: () => null }));
vi.mock("@/editor/transport/Transport", () => ({ Transport: () => null }));
vi.mock("@/editor/transport/commands", () => ({ useEditCommands: () => undefined }));
vi.mock("@/editor/timeline/TracksPanel", () => ({ TracksPanel: () => <div data-testid="tracks"><div data-clip-id="a" role="button" aria-label="clip a" /></div> }));
vi.mock("@/editor/export/ExportDialog", () => ({ ExportDialog: () => null }));
vi.mock("@/editor/home/ProjectsHome", () => ({ ProjectsHome: () => <div data-testid="home" /> }));
vi.mock("@/editor/home/handoff", () => ({ useEditHandoff: () => undefined }));
vi.mock("@/editor/useEditAutosave", () => ({ flushEdit: async () => undefined, markOpened: () => undefined, onEditSaved: () => () => undefined, useEditAutosave: () => undefined }));
vi.mock("@/editor/useEditData", () => ({ useEditData: () => undefined }));
vi.mock("@/editor/store", async (orig) => ({ ...(await orig<typeof import("@/editor/store")>()), useEditInputs: () => null, useMarkers: () => [] }));
// the music layer's heavy leaves
vi.mock("./setup/SetupPanel", () => ({ SetupPanel: () => <div data-testid="setup" /> }));
vi.mock("./lanes/LanesPanel", () => ({ LanesPanel: ({ compact }: { compact?: boolean }) => <div data-testid="lanes" data-compact={String(!!compact)} /> }));
vi.mock("./lanes/SectionBands", () => ({ SectionBands: () => null }));
vi.mock("./autofill/AutofillDialog", () => ({ AutofillDialog: () => null }));
vi.mock("./sectionstyle/SectionStyleDialog", () => ({ SectionStyleDialog: () => null }));
vi.mock("./captions/CaptionsPanel", () => ({ CaptionsPanel: () => <div data-testid="captions" /> }));

import { emptyEditProject, type NormalProject } from "@/viz/edit/defaults";
import { newClip } from "@/editor/doc";
import { useEditorFocus } from "@/editor/focus";
import { useEditStudio } from "@/editor/store";
import VideoEditorView from "../video-studio/VideoEditorView";
import EditStudioView from "./EditStudioView";

function open(song: boolean): void {
  const doc = emptyEditProject("9:16", 30, 1) as NormalProject;
  if (song) doc.song = { path: "/s.mp3", startMs: 0, endMs: 20_000, gainDb: 0, fadeInMs: 0, fadeOutMs: 0 };
  doc.tracks = [{ id: "t1", kind: "video", name: "Video 1", muted: false, locked: false, matte: "", clips: [newClip({ id: "a", kind: "video", path: "/a.mp4", startMs: 0, endMs: 4000 })] }];
  useEditStudio.getState().open("p1", "Project", doc);
}

beforeEach(() => {
  useEditStudio.getState().close();
  useEditorFocus.setState({ focus: "compose" });
});
afterEach(cleanup);

describe("Video Editor", () => {
  it("shows the editor, not Setup, for a project with no song", () => {
    open(false);
    useEditStudio.getState().setSetupOpen(true);
    render(<VideoEditorView moduleId="video-studio" />);
    expect(screen.queryByTestId("setup")).toBeNull();
    expect(screen.getByTestId("tracks")).toBeTruthy();
    expect(screen.queryByTestId("lanes")).toBeNull(); // no marker lanes
    expect(screen.queryByRole("radiogroup", { name: "Focus" })).toBeNull();
    expect(screen.queryByRole("button", { name: /auto-fill/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Song:/ })).toBeNull();
    // the rail: media, text, music and project only; nothing of the music layer
    const rail = screen.getByRole("navigation", { name: "Panels" });
    expect(within(rail).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Media", "Text", "Music", "Project"]);
  });

  it("shows the projects home when nothing is open", () => {
    render(<VideoEditorView moduleId="video-studio" />);
    expect(screen.getByTestId("home")).toBeTruthy();
  });
});

describe("Edit Studio", () => {
  it("asks for Setup until the song is analysed", () => {
    open(true);
    render(<EditStudioView moduleId="edit-studio" />);
    expect(screen.getByTestId("setup")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Song:/ })).toBeTruthy();
    expect((screen.getByRole("button", { name: /auto-fill/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("with an analysed song: lanes, the focus switch, Captions and Auto-fill; double-click on a clip goes Video with compact lanes", () => {
    open(true);
    useEditStudio.getState().setAnalysis(null, {} as never, "ready");
    render(<EditStudioView moduleId="edit-studio" />);
    expect(screen.queryByTestId("setup")).toBeNull();
    expect(screen.getByTestId("lanes").getAttribute("data-compact")).toBe("false");
    expect(screen.getByRole("radiogroup", { name: "Focus" })).toBeTruthy();
    const rail = screen.getByRole("navigation", { name: "Panels" });
    expect(within(rail).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Media", "Song", "Markers", "Captions", "Style", "Project"]);
    expect((screen.getByRole("button", { name: /auto-fill/i }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.doubleClick(screen.getByRole("button", { name: "clip a" }));
    expect(screen.getByTestId("lanes").getAttribute("data-compact")).toBe("true");
    expect(screen.getByTestId("breadcrumb").textContent).toBe("Edit Studio›Clip view");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("lanes").getAttribute("data-compact")).toBe("false");
  });

  it("the Captions click-in opens the captions panel in a drawer", async () => {
    open(true);
    useEditStudio.getState().setAnalysis(null, {} as never, "ready");
    render(<EditStudioView moduleId="edit-studio" />);
    await userEvent.click(screen.getByRole("button", { name: "Captions" }));
    expect(within(screen.getByRole("dialog", { name: "Captions" })).getByTestId("captions")).toBeTruthy();
  });

  it("the song chip in the header opens the Song panel", async () => {
    open(true);
    useEditStudio.getState().setAnalysis(null, {} as never, "ready");
    render(<EditStudioView moduleId="edit-studio" />);
    await userEvent.click(screen.getByRole("button", { name: /^Song:/ }));
    expect(screen.getByRole("dialog", { name: "Song" })).toBeTruthy();
  });
});
