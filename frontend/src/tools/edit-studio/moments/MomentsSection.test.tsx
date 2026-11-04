import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeProject } from "@/viz/edit/defaults";
import { fixtureProject } from "@/viz/edit/fixture";
import { parseEffects, parseSpeed } from "@/viz/edit/schema";
import type { EditParam } from "@/viz/edit/types";
import { findClip } from "@/editor/doc";
import { useEditStudio } from "@/editor/store";

const mocks = vi.hoisted(() => ({ Moments: vi.fn() }));

vi.mock("@/lib/api", async (orig) => {
  const m = await orig<typeof import("@/lib/api")>();
  return { ...m, EditStudioService: { ...m.EditStudioService, Moments: mocks.Moments } };
});

import { MomentsSection } from "./MomentsSection";
import { useMoments } from "./store";

const st = () => useEditStudio.getState();
const clip = (id: string) => findClip(st().history!.present, id)!.clip;

/** The section tracks the document's clip, as the inspector does. */
function Harness({ id }: { id: string }) {
  const c = useEditStudio((s) => (s.history ? findClip(s.history.present, id)?.clip : undefined));
  return c ? <MomentsSection clip={c} /> : null;
}

beforeEach(() => {
  mocks.Moments.mockReset();
  useMoments.setState({ entries: {}, strength: 1 });
  st().close();
  st().open("p1", "Test", normalizeProject(fixtureProject()));
});

// c1: a.mp4, timeline 0..8000, in point 1000 -> source 3000 is clip time 2000.
const MOMENTS = [
  { ms: 3000, strength: 0.9, kind: "motion" },
  { ms: 6000, strength: 0.4, kind: "cut" },
  { ms: 500, strength: 0.5, kind: "cut" }, // before the in point
];

describe("MomentsSection", () => {
  it("lists the moments inside the clip", async () => {
    mocks.Moments.mockResolvedValue(MOMENTS);
    render(<Harness id="c1" />);
    const list = await screen.findByRole("list", { name: "Moments in this clip" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Motion burst");
    expect(rows[0]?.textContent).toContain("0:02.0");
    expect(rows[1]?.textContent).toContain("Shot change");
    expect(mocks.Moments).toHaveBeenCalledWith("/fixture/a.mp4", 30);
  });

  it("Use writes a pulse and adds the effect; turning it off removes the keys", async () => {
    mocks.Moments.mockResolvedValue(MOMENTS);
    render(<Harness id="c1" />);
    const sw = await screen.findByRole("switch", { name: "Use Motion burst at 0:02.0" });
    fireEvent.click(sw);
    const shake = parseEffects(clip("c1").effects).value.find((e) => e.type === "shake");
    expect(shake).toBeTruthy();
    const keys = ((shake?.params.amount as Exclude<EditParam, number>).keys ?? []).map((k) => k.t);
    expect(keys).toContain(2000);
    expect(screen.getByRole("switch", { name: "Use Motion burst at 0:02.0" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("switch", { name: "Use Motion burst at 0:02.0" }));
    const after = parseEffects(clip("c1").effects).value.find((e) => e.type === "shake");
    expect(after?.params.amount).toBe(0);
    // The fixture's own punch effect is untouched.
    expect(parseEffects(clip("c1").effects).value.find((e) => e.type === "punch")).toBeTruthy();
  });

  it("Use all turns on every row, Clear turns them off", async () => {
    mocks.Moments.mockResolvedValue(MOMENTS);
    render(<Harness id="c1" />);
    await screen.findByRole("list", { name: "Moments in this clip" });
    fireEvent.click(screen.getByRole("button", { name: "Use all" }));
    expect(screen.getAllByRole("switch").every((s) => s.getAttribute("aria-checked") === "true")).toBe(true);
    expect(screen.getByText("2 of 2 in use")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("0 of 2 in use")).toBeTruthy();
  });

  it("Freeze writes speed keys", async () => {
    mocks.Moments.mockResolvedValue(MOMENTS);
    render(<Harness id="c1" />);
    const pick = await screen.findByLabelText("Effect for Motion burst at 0:02.0");
    fireEvent.change(pick, { target: { value: "freeze" } });
    fireEvent.click(screen.getByRole("switch", { name: "Use Motion burst at 0:02.0" }));
    const speed = parseSpeed(clip("c1").speed).value as Exclude<EditParam, number>;
    expect(speed.keys?.map((k) => [k.t, k.v])).toEqual([
      [2000, 1],
      [2033, 0],
      [2500, 1],
    ]);
  });

  it("shows an error with Retry", async () => {
    mocks.Moments.mockRejectedValueOnce(new Error("no stream"));
    render(<Harness id="c1" />);
    await screen.findByText(/Couldn't read this footage's moments/);
    mocks.Moments.mockResolvedValue(MOMENTS);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("list", { name: "Moments in this clip" })).toBeTruthy());
  });

  it("says so when there are none", async () => {
    mocks.Moments.mockResolvedValue([]);
    render(<Harness id="c1" />);
    await screen.findByText("No stand-out moments in this clip.");
  });
});
