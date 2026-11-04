import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditSourceState } from "@/lib/api";
import { normalizeProject } from "@/viz/edit/defaults";
import { buildEditFixture, fixtureProject } from "@/viz/edit/fixture";
import { useEditStudio } from "@/editor/store";
import { SectionStyleDialog } from "./SectionStyleDialog";
import { STYLE_TRACK_NAME } from "./styleLogic";
import { useSectionStyle } from "./useSectionStyle";

const moments = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (orig) => {
  const real = await orig<typeof import("@/lib/api")>();
  return { ...real, EditStudioService: { ...real.EditStudioService, Moments: moments } };
});

afterEach(() => {
  cleanup();
  useEditStudio.getState().close();
  useSectionStyle.setState({ range: null, saved: {}, moments: {} });
  moments.mockReset();
});

function state(path: string, kind: string, durationMs: number): EditSourceState {
  return {
    path,
    info: { path, kind, durationMs, width: 1080, height: 1920, fps: 30, rotation: 0, hasAudio: false, takenAt: 0, error: "" },
    preview: null,
    image: "",
    shots: null,
    preparing: false,
    error: "",
  };
}

function setup() {
  act(() => {
    useEditStudio.getState().open("p1", "Edit", normalizeProject(fixtureProject()));
    useEditStudio.getState().setAnalysis(null, buildEditFixture(), "ready");
    useEditStudio.getState().setSources([state("/fixture/a.mp4", "video", 10_000), state("/fixture/b.mp4", "video", 10_000), state("/fixture/photo.jpg", "image", 0)]);
    useSectionStyle.getState().open({ fromMs: 4000, toMs: 8000 });
  });
}

describe("SectionStyleDialog", () => {
  it("renders nothing while closed", () => {
    const { container } = render(<SectionStyleDialog />);
    expect(container.firstChild).toBeNull();
  });

  it("applies cuts, an adjustment clip and a transition in one undo step", async () => {
    setup();
    render(<SectionStyleDialog />);
    expect(screen.getByRole("dialog", { name: "Section style" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Hi-hats" }));
    await userEvent.selectOptions(screen.getByLabelText("Effects"), "anime-hit");
    await userEvent.selectOptions(screen.getByLabelText("Transition between cuts"), "flash");
    expect(screen.getByText(/clips switching on hi-hats, Anime hit on hi-hats/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    const h = useEditStudio.getState().history!;
    expect(h.past.length).toBe(1);
    const p = h.present;
    const adj = p.tracks.find((t) => t.name === STYLE_TRACK_NAME);
    expect(adj?.clips).toHaveLength(1);
    expect(adj?.clips[0]).toMatchObject({ startMs: 4000, endMs: 8000 });
    const t1 = p.tracks.find((t) => t.id === "t1")!;
    expect(t1.clips.filter((c) => c.auto && c.in.includes("flash")).length).toBeGreaterThan(5);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useSectionStyle.getState().saved["p1"]?.cutLane).toBe("hats");
  });

  it("fetches footage moments for Best moments", async () => {
    moments.mockResolvedValue([{ ms: 2000, strength: 0.8, kind: "cut" }]);
    setup();
    render(<SectionStyleDialog />);
    await userEvent.selectOptions(screen.getByLabelText("Distribute them"), "best");
    await waitFor(() => expect(moments).toHaveBeenCalledWith("/fixture/a.mp4", 30));
    await waitFor(() => expect(useSectionStyle.getState().moments["/fixture/a.mp4"]).toHaveLength(1));
  });

  it("disables Apply and explains when the song isn't analysed", () => {
    setup();
    act(() => useEditStudio.getState().setAnalysis(null, null, "none"));
    render(<SectionStyleDialog />);
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
