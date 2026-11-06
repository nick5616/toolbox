import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  flush: vi.fn(async () => undefined),
  setModuleState: vi.fn(async () => undefined),
  moduleState: vi.fn(async () => ""),
  list: vi.fn(async () => []),
  get: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    EditStudioService: { List: () => h.list(), Get: (...a: unknown[]) => h.get(...a), SaveThumb: async () => undefined },
    SettingsService: { ModuleState: () => h.moduleState(), SetModuleState: (...a: unknown[]) => h.setModuleState(...(a as [])) },
  };
});
vi.mock("@/tools/_kit", () => ({ DepsGate: () => null, FileActions: () => null }));
vi.mock("@/viz/edit/EditCanvas", () => ({ EditCanvas: () => <div data-testid="canvas" /> }));
vi.mock("./sources/SourcesPanel", () => ({ SourcesPanel: () => <div data-testid="sources" /> }));
vi.mock("./overlays/PreviewOverlays", () => ({ PreviewOverlays: () => null }));
vi.mock("./transport/Transport", () => ({ Transport: () => <div data-testid="transport" /> }));
vi.mock("./transport/commands", () => ({ useEditCommands: () => undefined }));
vi.mock("./timeline/TracksPanel", () => ({
  TracksPanel: () => (
    <div data-testid="tracks">
      <div data-clip-id="a" role="button" aria-label="clip a" />
    </div>
  ),
}));
vi.mock("./export/ExportDialog", () => ({ ExportDialog: ({ open }: { open: boolean }) => (open ? <div role="dialog" aria-label="Export" /> : null) }));
vi.mock("./home/ProjectsHome", async () => {
  const { useEditorProfile } = await import("./profileContext");
  return { ProjectsHome: ({ profile }: { profile?: { moduleId: string } }) => <div data-testid="home">{`home:${profile?.moduleId}:${useEditorProfile().moduleId}`}</div> };
});
vi.mock("./home/handoff", () => ({ useEditHandoff: () => undefined }));
vi.mock("./useEditAutosave", () => ({ flushEdit: () => h.flush(), markOpened: () => undefined, onEditSaved: () => () => undefined, useEditAutosave: () => undefined }));
vi.mock("./useEditData", () => ({ useEditData: () => undefined }));
// The preview inputs need a real analysis; the shell only passes them on to the (stubbed) canvas.
vi.mock("./store", async (orig) => ({ ...(await orig<typeof import("./store")>()), useEditInputs: () => null }));

import { useUI } from "@/state/ui";
import { emptyEditProject, type NormalProject } from "@/viz/edit/defaults";
import { newClip } from "./doc";
import { EditorShell, openInOtherTool } from "./EditorShell";
import { useEditorFocus } from "./focus";
import type { EditorFocus, EditorProfile } from "./profile";
import { PLAIN_PROFILE } from "./profileContext";
import { useEditStudio } from "./store";

const OWN_PANEL = { id: "own", title: "Own", icon: "music", tip: "A panel of the profile", component: () => <div data-testid="own-panel" /> };

function TimelineTop({ focus }: { focus: EditorFocus }) {
  return <div data-testid="timeline-top" data-focus={focus} />;
}

/** A composed profile like Edit Studio's, built from stubs (the editor must not import the real one). */
const COMPOSED: EditorProfile = {
  ...PLAIN_PROFILE,
  moduleId: "edit-studio",
  title: "Edit Studio",
  noun: "edit",
  song: "analyzed",
  homeFilter: "music-edit",
  markerSignals: true,
  Setup: () => <div data-testid="setup" />,
  TimelineTop,
  HeaderStart: ({ disabled }: { disabled: boolean }) => <span data-testid="header-start">{disabled ? "off" : "on"}</span>,
  panels: [OWN_PANEL],
  rail: ["media", "own", "project"],
  moreItems: () => [{ id: "extra", label: "Export markers (CSV)", onSelect: () => undefined }],
  Dialogs: () => <div data-testid="dialogs" />,
};

function openProject(song: boolean): void {
  const doc = emptyEditProject("9:16", 30, 1) as NormalProject;
  if (song) doc.song = { path: "/s.mp3", startMs: 0, endMs: 20_000, gainDb: 0, fadeInMs: 0, fadeOutMs: 0 };
  doc.tracks = [{ id: "t1", kind: "video", name: "Video 1", muted: false, locked: false, matte: "", clips: [newClip({ id: "a", kind: "video", path: "/a.mp4", startMs: 0, endMs: 4000 })] }];
  useEditStudio.getState().open("p1", "My edit", doc);
}

function shell(profile: EditorProfile): ReactNode {
  return <EditorShell moduleId={profile.moduleId} profile={profile} />;
}

beforeEach(() => {
  h.flush.mockClear();
  h.setModuleState.mockClear();
  useEditStudio.getState().close();
  useEditorFocus.setState({ focus: "compose" });
});
afterEach(cleanup);

describe("EditorShell routing", () => {
  it("shows the projects home, with the profile, when no project is open", () => {
    render(shell(COMPOSED));
    expect(screen.getByTestId("home").textContent).toBe("home:edit-studio:edit-studio");
  });

  it("an analysed profile shows Setup until the song's analysis is ready", () => {
    openProject(true);
    render(shell(COMPOSED));
    expect(screen.getByTestId("setup")).toBeTruthy();
    expect(screen.queryByTestId("tracks")).toBeNull();
    expect(screen.getByTestId("header-start").textContent).toBe("off");
    expect((screen.getByRole("button", { name: /export/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("an analysed profile without a song shows Setup too", () => {
    openProject(false);
    useEditStudio.getState().setAnalysis(null, {} as never, "ready");
    render(shell(COMPOSED));
    expect(screen.getByTestId("setup")).toBeTruthy();
  });

  it("shows the timeline once the analysis is ready", () => {
    openProject(true);
    useEditStudio.getState().setAnalysis(null, {} as never, "ready");
    render(shell(COMPOSED));
    expect(screen.queryByTestId("setup")).toBeNull();
    expect(screen.getByTestId("tracks")).toBeTruthy();
    expect(screen.getByTestId("timeline-top").getAttribute("data-focus")).toBe("compose");
    expect(screen.getByTestId("dialogs")).toBeTruthy();
  });

  it("the plain profile shows the editor, not Setup, with no song and no analysis", () => {
    openProject(false);
    useEditStudio.getState().setSetupOpen(true); // a fresh empty project asks for it; the Video Editor ignores it
    render(shell(PLAIN_PROFILE));
    expect(screen.queryByTestId("setup")).toBeNull();
    expect(screen.getByTestId("tracks")).toBeTruthy();
    expect((screen.getByRole("button", { name: /export/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("radiogroup", { name: "Focus" })).toBeNull();
    expect(screen.queryByTestId("timeline-top")).toBeNull();
  });
});

describe("focus", () => {
  function ready(): void {
    openProject(true);
    useEditStudio.getState().setAnalysis(null, {} as never, "ready");
  }

  it("double-clicking a clip clicks into the video: lanes compact, breadcrumb", async () => {
    ready();
    render(shell(COMPOSED));
    expect(screen.queryByTestId("breadcrumb")).toBeNull();
    fireEvent.doubleClick(screen.getByRole("button", { name: "clip a" }));
    expect(useEditorFocus.getState().focus).toBe("video");
    expect(screen.getByTestId("timeline-top").getAttribute("data-focus")).toBe("video");
    expect(screen.getByTestId("breadcrumb").textContent).toBe("Edit Studio›Clip view");
  });

  it("double-clicking the preview does the same", () => {
    ready();
    render(shell(COMPOSED));
    fireEvent.doubleClick(screen.getByTestId("canvas"));
    expect(useEditorFocus.getState().focus).toBe("video");
  });

  it("the Music | Video control switches focus and the breadcrumb's back arrow returns", async () => {
    ready();
    const user = userEvent.setup();
    render(shell(COMPOSED));
    await user.click(screen.getByRole("radio", { name: "Clip view" }));
    expect(screen.getByTestId("timeline-top").getAttribute("data-focus")).toBe("video");
    await user.click(screen.getByRole("button", { name: "Back to Edit Studio" }));
    expect(screen.getByTestId("timeline-top").getAttribute("data-focus")).toBe("compose");
    expect(screen.getByRole("radio", { name: "Song view" }).getAttribute("aria-checked")).toBe("true");
  });

  it("Esc returns to Music", () => {
    ready();
    render(shell(COMPOSED));
    act(() => useEditorFocus.getState().setFocus("video"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useEditorFocus.getState().focus).toBe("compose");
  });

  it("Esc is left alone while a dialog is open, a menu is open or a text field has focus", async () => {
    ready();
    const user = userEvent.setup();
    render(shell(COMPOSED));
    act(() => useEditorFocus.getState().setFocus("video"));

    act(() => useEditStudio.getState().openDialog({ kind: "export" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useEditorFocus.getState().focus).toBe("video");
    act(() => useEditStudio.getState().openDialog(null));

    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useEditorFocus.getState().focus).toBe("video");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    const name = screen.getByLabelText("Edit name");
    name.focus();
    fireEvent.keyDown(name, { key: "Escape" });
    expect(useEditorFocus.getState().focus).toBe("video");
  });

  it("the plain profile is always in video focus and has no control or breadcrumb", () => {
    openProject(false);
    render(shell(PLAIN_PROFILE));
    expect(screen.queryByTestId("breadcrumb")).toBeNull();
    fireEvent.doubleClick(screen.getByRole("button", { name: "clip a" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("tracks")).toBeTruthy();
  });

  it("a newly opened project starts on the composition", () => {
    ready();
    useEditorFocus.setState({ focus: "video" });
    render(shell(COMPOSED));
    expect(useEditorFocus.getState().focus).toBe("compose");
  });
});

describe("minimal surface", () => {
  it("has no permanent inspector column or tabs; the preview is a part frame", () => {
    openProject(false);
    render(shell(PLAIN_PROFILE));
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(document.querySelector('[data-part="video-studio.preview"]')).toBeTruthy();
    expect(screen.getByTestId("canvas")).toBeTruthy();
  });

  it("the rail lists the profile's panels as icon launchers, in order", () => {
    openProject(true);
    useEditStudio.getState().setAnalysis(null, {} as never, "ready");
    render(shell(COMPOSED));
    const rail = screen.getByRole("navigation", { name: "Panels" });
    expect(within(rail).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Media", "Own", "Project"]);
  });

  it("a rail launcher opens its panel in a drawer over the editor; Esc closes it and Video focus stays", async () => {
    openProject(true);
    useEditStudio.getState().setAnalysis(null, {} as never, "ready");
    const user = userEvent.setup();
    render(shell(COMPOSED));
    expect(screen.queryByTestId("own-panel")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Own" }));
    const drawer = screen.getByRole("dialog", { name: "Own" });
    expect(within(drawer).getByTestId("own-panel")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("own-panel")).toBeNull();

    act(() => useEditorFocus.getState().setFocus("video"));
    await user.click(screen.getByRole("button", { name: "Own" }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useEditorFocus.getState().focus).toBe("video"); // the drawer takes the Esc
    await waitFor(() => expect(screen.queryByTestId("own-panel")).toBeNull());
  });

  it("opening the Media panel shows the sources", async () => {
    openProject(false);
    const user = userEvent.setup();
    render(shell(PLAIN_PROFILE));
    await user.click(screen.getByRole("button", { name: "Media" }));
    expect(screen.getByTestId("sources")).toBeTruthy();
  });
});

describe("More menu", () => {
  it("lists the profile's items and Open in the other tool, and opens it there", async () => {
    openProject(true);
    useEditStudio.getState().setAnalysis(null, {} as never, "ready");
    const navigate = vi.spyOn(useUI.getState(), "navigate");
    const user = userEvent.setup();
    render(shell(COMPOSED));
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitem", { name: "Export markers (CSV)" })).toBeTruthy();
    await user.click(screen.getByRole("menuitem", { name: "Open in Video Editor" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("video-studio"));
    expect(h.flush).toHaveBeenCalled();
    expect(h.setModuleState).toHaveBeenCalledWith("video-studio", JSON.stringify({ lastProjectId: "p1" }));
    expect(useEditStudio.getState().projectId).toBe("p1"); // still open for the other tool
    navigate.mockRestore();
  });

  it("the Video Editor offers Open in Edit Studio", async () => {
    openProject(false);
    const navigate = vi.spyOn(useUI.getState(), "navigate");
    const user = userEvent.setup();
    render(shell(PLAIN_PROFILE));
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Open in Edit Studio" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("edit-studio"));
    expect(h.setModuleState).toHaveBeenCalledWith("edit-studio", JSON.stringify({ lastProjectId: "p1" }));
    navigate.mockRestore();
  });

  it("openInOtherTool does nothing without an open project or another tool", async () => {
    const navigate = vi.spyOn(useUI.getState(), "navigate");
    await openInOtherTool("edit-studio");
    openProject(false);
    await openInOtherTool("somewhere-else");
    expect(navigate).not.toHaveBeenCalled();
    navigate.mockRestore();
  });
});
