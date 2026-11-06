import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClickInHost } from "@/components";
import { normalizeProject } from "@/viz/edit/defaults";
import { fixtureProject } from "@/viz/edit/fixture";
import { defineEditorWorkspace } from "./workspace";
import { EditorProfileProvider, PLAIN_PROFILE } from "./profileContext";
import { railFit } from "@/workspace";
import { Rail } from "./Rail";
import { useEditStudio } from "./store";

const size = vi.hoisted(() => ({ height: 0 }));
vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: 56, height: size.height }) }));

beforeEach(() => {
  size.height = 0;
  useEditStudio.getState().close();
  useEditStudio.getState().open("p1", "T", normalizeProject(fixtureProject()));
});
afterEach(cleanup);

const mount = () => {
  const profile = { ...PLAIN_PROFILE, rail: ["media", "text", "music", "project", "track", "clip-effects"] };
  defineEditorWorkspace(profile);
  return render(
    <EditorProfileProvider profile={profile}>
      <ClickInHost>
        <Rail />
      </ClickInHost>
    </EditorProfileProvider>,
  );
};

describe("railFit", () => {
  it("shows everything when it fits or the height is unknown, else leaves a slot for the more item", () => {
    expect(railFit(6, 0)).toBe(6);
    expect(railFit(6, 6 * 44 + 16)).toBe(6);
    expect(railFit(6, 4 * 44 + 16)).toBe(3);
    expect(railFit(6, 10)).toBe(0);
  });
});

describe("Rail", () => {
  it("never scrolls: what doesn't fit goes into a More item that still opens the drawers", async () => {
    size.height = 4 * 44 + 16;
    mount();
    const nav = screen.getByRole("navigation", { name: "Panels" });
    const names = within(nav).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Media", "Text", "Music", "More panels"]);
    await userEvent.click(screen.getByRole("button", { name: "More panels" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Project" }));
    expect(screen.getByRole("dialog", { name: "Project" })).toBeTruthy();
  });
});
