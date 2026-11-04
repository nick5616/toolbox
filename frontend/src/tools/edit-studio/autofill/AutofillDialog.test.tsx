import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditSourceState } from "@/lib/api";
import { normalizeProject } from "@/viz/edit/defaults";
import { buildEditFixture, fixtureProject } from "@/viz/edit/fixture";
import { useEditStudio } from "@/editor/store";
import { AutofillDialog } from "./AutofillDialog";

afterEach(() => {
  cleanup();
  useEditStudio.getState().close();
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

describe("AutofillDialog", () => {
  it("applies in one undo step on a new Auto track and records the recipe", async () => {
    const doc = normalizeProject(fixtureProject());
    act(() => {
      useEditStudio.getState().open("p1", "Edit", doc);
      useEditStudio.getState().setAnalysis(null, buildEditFixture(), "ready");
      useEditStudio.getState().setSources([state("/fixture/a.mp4", "video", 10_000), state("/fixture/b.mp4", "video", 10_000), state("/fixture/photo.jpg", "image", 0)]);
    });
    const onClose = vi.fn();
    render(<AutofillDialog open range={null} onClose={onClose} />);
    expect(screen.getByText(/cuts ·/)).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Target track"), "new");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    const h = useEditStudio.getState().history!;
    expect(h.past.length).toBe(1);
    expect(onClose).toHaveBeenCalled();
    expect(h.present.recipe).toMatchObject({ recipeId: "downbeat", run: 1 });
    const t = h.present.tracks.find((x) => x.clips.some((c) => c.auto));
    expect(t).toBeDefined();
    expect(h.present.tracks.length).toBe(doc.tracks.length + 1);
    expect(t?.name).toBe("Auto");
  });

  it("renders nothing when closed", () => {
    const { container } = render(<AutofillDialog open={false} range={null} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
