import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeProject } from "@/viz/edit/defaults";
import { fixtureProject } from "@/viz/edit/fixture";
import { defineEditorWorkspace } from "@/editor/workspace";
import { EditorProfileProvider } from "@/editor/profileContext";
import { useEditStudio } from "@/editor/store";
import { MUSIC_EDIT_PROFILE } from "./profile";

const ws = defineEditorWorkspace(MUSIC_EDIT_PROFILE);
const getEditorPanel = (id: string) => ws.getPanel(id);

const st = () => useEditStudio.getState();
const doc = () => st().history!.present;

function renderPanel(id: string) {
  const Body = getEditorPanel(id)?.component;
  if (!Body) throw new Error(`no panel ${id}`);
  return render(
    <EditorProfileProvider profile={MUSIC_EDIT_PROFILE}>
      <Body />
    </EditorProfileProvider>,
  );
}

beforeEach(() => {
  st().close();
  st().open("p1", "Test", normalizeProject(fixtureProject()));
});
afterEach(cleanup);

describe("Edit Studio's panels", () => {
  for (const id of ["song", "markers", "captions", "style", "clip-music"]) {
    it(`${id} renders standalone with no props, with and without a selection`, () => {
      for (const sel of [null, { kind: "clips" as const, ids: ["c1"] }, { kind: "markers" as const, ids: ["beat:1000"] }]) {
        st().select(sel);
        const { container, unmount } = renderPanel(id);
        expect(container.firstElementChild, id).toBeTruthy();
        unmount();
      }
    });
  }

  it("registers the music layer's panels and the rail names only registered panels", () => {
    for (const id of ["song", "markers", "captions", "style", "clip-music"]) expect(getEditorPanel(id), id).toBeTruthy();
    for (const id of MUSIC_EDIT_PROFILE.rail ?? []) expect(getEditorPanel(id), id).toBeTruthy();
    for (const c of MUSIC_EDIT_PROFILE.clipChips ?? []) expect(getEditorPanel(c.panel), c.panel).toBeTruthy();
    expect(getEditorPanel(MUSIC_EDIT_PROFILE.songPanel ?? "")).toBeTruthy();
    expect(getEditorPanel(MUSIC_EDIT_PROFILE.markersPanel ?? "")).toBeTruthy();
  });

  it("Markers: the active lane and the cut offset moved here from the transport", () => {
    renderPanel("markers");
    fireEvent.change(screen.getByRole("combobox", { name: "Active lane" }), { target: { value: "kick" } });
    expect(st().activeLane).toBe("kick");
    const stepper = screen.getByRole("spinbutton", { name: "Cut offset in frames" });
    fireEvent.change(stepper, { target: { value: "-2" } });
    fireEvent.blur(stepper);
    expect(doc().cutOffsetFrames).toBe(-2);
    expect(screen.getByText("Cuts land 2 frames early.")).toBeTruthy();
  });

  it("Markers: a lane's switch hides and shows it", async () => {
    renderPanel("markers");
    const sw = screen.getByRole("switch", { name: "Snare" });
    const was = sw.getAttribute("aria-checked");
    await userEvent.click(sw);
    expect(screen.getByRole("switch", { name: "Snare" }).getAttribute("aria-checked")).not.toBe(was);
  });

  it("Auto-fill panel pins the selected clip", async () => {
    st().select({ kind: "clips", ids: ["c1"] });
    renderPanel("clip-music");
    await userEvent.click(screen.getByRole("switch", { name: "Pinned" }));
    expect(doc().tracks.flatMap((t) => t.clips).find((c) => c.id === "c1")?.pinned).toBe(true);
  });

  it("Auto-fill panel asks for a clip when none is selected", () => {
    renderPanel("clip-music");
    expect(screen.getByText(/Select one clip/)).toBeTruthy();
  });
});
