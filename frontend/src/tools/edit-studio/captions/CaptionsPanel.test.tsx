import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, EditStudioService: { Fonts: async () => ["Arial", "Impact"], ExportText: async () => ({}) } };
});
vi.mock("../useEditAutosave", () => ({ flushEdit: async () => undefined }));

import { normalizeProject } from "@/viz/edit/defaults";
import { buildEditFixture, fixtureProject } from "@/viz/edit/fixture";
import { parseCaptionLines } from "@/viz/edit/schema";
import { useEditStudio } from "../store";
import { CaptionsPanel, wordsSource } from "./CaptionsPanel";

function open(captions: boolean, withAnalysis = true) {
  const doc = normalizeProject(fixtureProject());
  useEditStudio.getState().open("p1", "Edit", { ...doc, song: { ...doc.song!, startMs: 4000, endMs: 20_000 }, captions: captions ? { style: "", behindSubject: false, lines: "" } : null });
  if (withAnalysis) useEditStudio.getState().setAnalysis(null, buildEditFixture(), "ready");
}
const captionsNow = () => useEditStudio.getState().history!.present.captions!;

describe("CaptionsPanel", () => {
  beforeEach(() => {
    useEditStudio.getState().close();
  });

  it("turns captions on and off through the switch", async () => {
    open(false);
    render(<CaptionsPanel />);
    expect(screen.queryByTestId("words-source")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Show captions" }));
    expect(captionsNow()).toMatchObject({ behindSubject: false, lines: "" });
    expect(JSON.parse(captionsNow().style)).toMatchObject({ preset: "pop" });
    fireEvent.click(await screen.findByRole("switch", { name: "Show captions" }));
    expect(useEditStudio.getState().history!.present.captions).toBeNull();
  });

  it("disables Behind the subject without a ready cut-out", async () => {
    open(true);
    render(<CaptionsPanel />);
    expect((await screen.findByRole("switch", { name: "Behind the subject" })).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Make a cut-out on a clip first")).toBeTruthy();
  });

  it("lists the lines in timeline ms and writes the full list when one is edited", async () => {
    open(true);
    render(<CaptionsPanel />);
    const rows = await screen.findAllByTestId("caption-row");
    expect(rows.length).toBeGreaterThan(1);
    expect(screen.getByLabelText("Line 1 start")).toHaveProperty("value", "0:00.000");
    expect(screen.getByTestId("words-source").textContent).toContain("Words from the analysis");
    const input = screen.getByLabelText("Line 1 text") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "changed words" } });
    fireEvent.change(input, { target: { value: "changed words!" } });
    const lines = parseCaptionLines(captionsNow().lines).value!;
    expect(lines.length).toBe(buildEditFixture().text!.lines.length);
    expect(lines.find((l) => l.text === "changed words!")).toBeTruthy();
    // typing coalesces into one undo step
    expect(useEditStudio.getState().history!.past.length).toBe(1);
  });

  it("deletes a line, then resets to the analysis", async () => {
    open(true);
    render(<CaptionsPanel />);
    const before = buildEditFixture().text!.lines.length;
    fireEvent.click(await screen.findByRole("button", { name: "Line 1 actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    expect(parseCaptionLines(captionsNow().lines).value).toHaveLength(before - 1);
    fireEvent.click(screen.getByRole("button", { name: /Reset to the analysis/ }));
    expect(captionsNow().lines).toBe("");
    await act(async () => undefined);
  });

  it("edits a word's time from the expanded row", async () => {
    open(true);
    render(<CaptionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Show words of line 1" }));
    const start = screen.getByLabelText("Line 1 word 2 start");
    fireEvent.change(start, { target: { value: "0:01.000" } });
    fireEvent.keyDown(start, { key: "Enter" });
    const first = parseCaptionLines(captionsNow().lines).value![0]!;
    expect(first.words[1]?.startMs).toBe(4000 + 1000);
  });

  it("describes where the words come from", () => {
    expect(wordsSource("detect", true)).toBe("Detected from the vocals");
    expect(wordsSource("align", true)).toBe("Aligned to your lyrics");
    expect(wordsSource(undefined, false)).toMatch(/^No words/);
  });
});
