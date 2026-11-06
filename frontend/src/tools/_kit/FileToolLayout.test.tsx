import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    FilesService: { Stat: async () => [], Pick: async () => [] },
    SettingsService: { ModuleState: vi.fn().mockResolvedValue(""), SetModuleState: vi.fn().mockResolvedValue(undefined) },
  };
});

import { ModuleStatus, type Descriptor } from "@/lib/api";
import { useDeps } from "@/state/deps";
import { useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { FileToolLayout } from "./FileToolLayout";
import { summarize } from "./summary";
import type { FileInputs } from "./useFileInputs";

const inputs: FileInputs = {
  files: [],
  add: async () => undefined,
  pick: async () => undefined,
  remove: () => undefined,
  clear: () => undefined,
} as unknown as FileInputs;

beforeEach(() => {
  useModules.getState().setAll([{ id: "converter", name: "Converter", tagline: "t", description: "", icon: "box", status: ModuleStatus.StatusReady, accepts: { extensions: [], urls: false }, requires: null, recommends: null, maxInputs: 0 } as unknown as Descriptor]);
  useDeps.getState().setAll([]);
  useJobs.getState().setAll([]);
});

describe("summarize", () => {
  it("joins the non-empty parts", () => {
    expect(summarize("MP3", false, "320 kbps", undefined, "")).toBe("MP3 · 320 kbps");
    expect(summarize()).toBe("");
  });
});

describe("FileToolLayout advanced slot", () => {
  it("shows primary settings, an Advanced row with its summary, and opens the drawer", async () => {
    const user = userEvent.setup();
    render(
      <FileToolLayout
        moduleId="converter"
        inputs={inputs}
        runLabel="Go"
        onRun={() => undefined}
        primary={<label>Preset <input aria-label="Preset" /></label>}
        advanced={<input aria-label="Bitrate" />}
        advancedSummary="MP3 · 320 kbps"
      />,
    );
    expect(screen.getByLabelText("Preset")).toBeTruthy();
    const row = screen.getByRole("button", { name: /Advanced/ });
    expect(row.textContent).toContain("MP3 · 320 kbps");
    expect(screen.queryByLabelText("Bitrate")).toBeNull();
    await user.click(row);
    expect(await screen.findByLabelText("Bitrate")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Advanced" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByLabelText("Bitrate")).toBeNull();
  });

  it("renders no Advanced row when there is no advanced slot", () => {
    render(<FileToolLayout moduleId="converter" inputs={inputs} runLabel="Go" onRun={() => undefined} primary={<span>p</span>} />);
    expect(screen.queryByRole("button", { name: /Advanced/ })).toBeNull();
  });
});
