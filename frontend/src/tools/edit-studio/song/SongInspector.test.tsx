import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useEditStudio } from "@/editor/store";
import { normalizeProject } from "@/viz/edit/defaults";
import { fixtureProject } from "@/viz/edit/fixture";
import { SongInspector } from "./SongInspector";

const st = () => useEditStudio.getState();
const doc = () => st().history!.present;

beforeEach(() => {
  st().close();
  st().open("p1", "Test", normalizeProject(fixtureProject()));
  st().select({ kind: "song" });
});
afterEach(cleanup);

describe("SongInspector (Edit Studio's song layer)", () => {
  it("edits the song: range display, gain and fades", async () => {
    render(<SongInspector />);
    expect(screen.getAllByText("0:24.0")).toHaveLength(2); // the range end and the edit length
    fireEvent.change(screen.getByRole("slider", { name: "Song gain" }), { target: { value: "-6" } });
    expect(doc().song?.gainDb).toBe(-6);
    fireEvent.change(screen.getByRole("slider", { name: "Fade in" }), { target: { value: "1500" } });
    expect(doc().song?.fadeInMs).toBe(1500);
    // "Change range…" opens Setup's range picker (the shell shows it in place of the timeline)
    await userEvent.click(screen.getByRole("button", { name: "Change range…" }));
    expect(st().setupOpen).toBe(true);
  });
});
