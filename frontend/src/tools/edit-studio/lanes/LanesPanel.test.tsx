import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeProject } from "@/viz/edit/defaults";
import { buildEditFixture, fixtureProject } from "@/viz/edit/fixture";
import { useEditStudio } from "../store";
import { LanesPanel } from "./LanesPanel";
import { SectionBands } from "./SectionBands";

vi.mock("@/lib/api", async (orig) => {
  const a = await orig<typeof import("@/lib/api")>();
  return { ...a, MediaService: { ...a.MediaService, Waveform: vi.fn().mockResolvedValue(Array.from({ length: 400 }, (_, i) => (i % 10) / 10)) } };
});

const ctxStub = new Proxy(
  {},
  {
    get: (_t, p: string) => (p === "measureText" ? (s: string) => ({ width: s.length * 6 }) : () => undefined),
    set: () => true,
  },
);

function openFixture() {
  const doc = normalizeProject(fixtureProject());
  useEditStudio.getState().open("p1", "Fixture", doc);
  useEditStudio.getState().setAnalysis(null, buildEditFixture(), "ready");
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ctxStub) as never);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  openFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => useEditStudio.getState().close());
});

const laneRadio = (name: RegExp) => screen.getByRole("radio", { name });

describe("LanesPanel", () => {
  it("shows a row for each visible lane with its marker count", () => {
    render(<LanesPanel />);
    // defaults: beat, downbeat, kick, snare, section, drop, lift, stop, custom
    for (const n of [/Beats lane/, /Downbeats lane/, /Kick lane/, /Snare lane/, /Sections lane/, /Drops lane/, /Stops lane/, /Custom lane/]) expect(laneRadio(n)).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /Hi-hats lane/ })).toBeNull();
    expect(within(laneRadio(/Beats lane/)).getByLabelText("48 markers")).toBeTruthy();
    expect(within(laneRadio(/Stops lane/)).getByLabelText("1 markers")).toBeTruthy();
    expect(within(laneRadio(/Downbeats lane/)).queryByText("bar = beat 1")).toBeNull(); // shown only when moved
  });

  it("clicking a lane header makes it the active lane", () => {
    render(<LanesPanel />);
    fireEvent.click(laneRadio(/Snare lane/));
    expect(useEditStudio.getState().activeLane).toBe("snare");
    expect(laneRadio(/Snare lane/).getAttribute("aria-checked")).toBe("true");
  });

  it("the eye hides a lane, and the + menu brings it back", async () => {
    render(<LanesPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Hide Kick" }));
    expect(useEditStudio.getState().history?.present.markers.lanes.kick?.visible).toBe(false);
    expect(screen.queryByRole("radio", { name: /Kick lane/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show more lanes" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Kick" }));
    expect(useEditStudio.getState().history?.present.markers.lanes.kick?.visible).toBe(true);
  });

  it("the settings popover changes the threshold, and the bar start", () => {
    render(<LanesPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Snare settings" }));
    const dialog = screen.getByRole("dialog", { name: "Snare settings" });
    const before = within(laneRadio(/Snare lane/)).getByLabelText(/markers/).textContent;
    fireEvent.change(within(dialog).getByRole("slider", { name: "Strength threshold" }), { target: { value: "0.8" } });
    expect(useEditStudio.getState().history?.present.markers.lanes.snare?.minStrength).toBeCloseTo(0.8);
    expect(within(laneRadio(/Snare lane/)).getByLabelText(/markers/).textContent).not.toBe(before);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Downbeats settings" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("radio", { name: "3" }));
    expect(useEditStudio.getState().history?.present.markers.barOffset).toBe(2);
  });

  it("M adds a custom marker at the playhead when paused; Delete removes it", () => {
    render(<LanesPanel />);
    act(() => useEditStudio.getState().setPlayhead(5000));
    fireEvent.keyDown(window, { key: "m" });
    const custom = useEditStudio.getState().history?.present.markers.custom ?? [];
    expect(custom.length).toBe(1);
    expect(custom[0]?.ms).toBe(5000);
    const sel = useEditStudio.getState().selection;
    expect(sel).toEqual({ kind: "markers", ids: [custom[0]?.id] });
    fireEvent.keyDown(window, { key: "Delete" });
    expect(useEditStudio.getState().history?.present.markers.custom.length).toBe(0);
  });

  it("T during playback adds at playhead minus 40 ms; a quick second T removes it", () => {
    render(<LanesPanel />);
    act(() => {
      useEditStudio.getState().setPlayhead(5000);
      useEditStudio.getState().setPlaying(true);
    });
    fireEvent.keyDown(window, { key: "t" });
    expect(useEditStudio.getState().history?.present.markers.custom[0]?.ms).toBe(4960);
    fireEvent.keyDown(window, { key: "t" });
    expect(useEditStudio.getState().history?.present.markers.custom.length).toBe(0);
  });

  it("T while paused does nothing", () => {
    render(<LanesPanel />);
    fireEvent.keyDown(window, { key: "t" });
    expect(useEditStudio.getState().history?.present.markers.custom.length).toBe(0);
  });

  it("Delete hides a selected derived marker", () => {
    render(<LanesPanel />);
    act(() => useEditStudio.getState().select({ kind: "markers", ids: ["kick:1000"] }));
    fireEvent.keyDown(window, { key: "Delete" });
    expect(useEditStudio.getState().history?.present.markers.hidden).toEqual(["kick:1000"]);
  });
});

describe("SectionBands", () => {
  it("renders a chip per section and selects its range", () => {
    render(<SectionBands />);
    expect(screen.getByRole("button", { name: "chorus" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "chorus" }));
    expect(useEditStudio.getState().selection).toEqual({ kind: "range", fromMs: 8000, toMs: 16_000 });
  });

  it("opens auto-fill for a section from its menu", async () => {
    render(<SectionBands />);
    fireEvent.click(screen.getByRole("button", { name: "chorus options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Auto-fill this section" }));
    expect(useEditStudio.getState().dialog).toEqual({ kind: "autofill", range: { fromMs: 8000, toMs: 16_000 } });
  });

  it("renames a section into the labels map", async () => {
    render(<SectionBands />);
    fireEvent.click(screen.getByRole("button", { name: "verse options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename section" }));
    const input = screen.getByRole("textbox", { name: "Section name" });
    fireEvent.change(input, { target: { value: "Hook" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useEditStudio.getState().history?.present.markers.labels["section:4000"]).toBe("Hook");
  });
});
