import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    PipelinesService: { Save: (...a: unknown[]) => h.save(...a), Describe: async () => ({}), List: async () => [], Runs: async () => [], Catalog: async () => [], Templates: async () => [] },
    FilesService: { PickFolder: async () => "" },
  };
});

import { useUI } from "@/state/ui";
import { useDraft } from "./draftStore";
import { TriggersPanel, triggersSummary } from "./panels";
import { entry, pipeline, step } from "./testFixtures";

const p = () => pipeline("p1", [step("aaaaaaaa", "downloader")]);

function open(clip: Partial<{ enabled: boolean; kinds: string[]; pattern: string }> = {}, status = { active: false, message: "" }) {
  const pl = p();
  pl.clip = { enabled: false, kinds: [], pattern: "", ...clip };
  useDraft.getState().open(entry(pl));
  useDraft.getState().setLive({ clipStatus: status });
}

const clipOf = () => useDraft.getState().draft?.clip;

beforeEach(() => {
  h.save.mockReset().mockImplementation(async (pl: unknown) => entry(pl as never));
});
afterEach(() => {
  cleanup();
  useDraft.getState().markDeleted();
  useDraft.getState().close();
});

describe("the clipboard trigger", () => {
  it("is off by default and shows only its switch", () => {
    open();
    render(<TriggersPanel />);
    expect(screen.getByRole("switch", { name: "When I copy…" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("switch", { name: "Links" })).toBeNull();
  });

  it("turning it on starts with links, and kinds can be toggled", async () => {
    open();
    render(<TriggersPanel />);
    await userEvent.click(screen.getByRole("switch", { name: "When I copy…" }));
    expect(clipOf()).toMatchObject({ enabled: true, kinds: ["link"] });
    await userEvent.click(screen.getByRole("switch", { name: "Images" }));
    expect(clipOf()?.kinds).toEqual(["link", "image"]);
    await userEvent.click(screen.getByRole("switch", { name: "Links" }));
    expect(clipOf()?.kinds).toEqual(["image"]);
  });

  it("asks for a pattern when text is chosen and stores it", async () => {
    open({ enabled: true, kinds: ["link"] });
    render(<TriggersPanel />);
    expect(screen.queryByLabelText("Text pattern")).toBeNull();
    await userEvent.click(screen.getByRole("switch", { name: "Text" }));
    expect(clipOf()?.kinds).toEqual(["link", "text"]);
    expect(screen.getByText(/Enter a pattern/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Text pattern"), "^TODO");
    expect(clipOf()?.pattern).toBe("^TODO");
    expect(screen.queryByText(/Enter a pattern/)).toBeNull();
  });

  it("says it is active when copies can start a run", () => {
    open({ enabled: true, kinds: ["link"] }, { active: true, message: "" });
    render(<TriggersPanel />);
    expect(screen.getByText(/Active: copies start a run/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clipboard settings" })).toBeNull();
  });

  it("explains that recording is off and opens Clipboard settings", async () => {
    open({ enabled: true, kinds: ["link"] }, { active: false, message: "Turn on clipboard recording in Clipboard History" });
    useUI.setState({ view: "pipelines" });
    render(<TriggersPanel />);
    expect(screen.getByText("Turn on clipboard recording in Clipboard History")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Clipboard settings" }));
    expect(useUI.getState().view).toBe("settings");
  });

  it("shows other problems without the settings button", () => {
    open({ enabled: true, kinds: ["link"] }, { active: false, message: "Fix the problems in step 2" });
    render(<TriggersPanel />);
    expect(screen.getByText("Fix the problems in step 2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clipboard settings" })).toBeNull();
  });

  it("summarises the triggers that are on", () => {
    expect(triggersSummary("", false, { enabled: false, kinds: [] })).toBe("Off");
    expect(triggersSummary("C:\\in", true, { enabled: false, kinds: null })).toBe("Watching in");
    expect(triggersSummary("", false, { enabled: true, kinds: ["link", "text"] })).toBe("On copying links, text");
    expect(triggersSummary("C:\\in", true, { enabled: true, kinds: null })).toBe("Watching in · On copying (nothing chosen)");
  });
});
