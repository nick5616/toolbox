import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (orig) => {
  const { libraryApiMock } = await import("./library/testSvc");
  return libraryApiMock(orig as never);
});
vi.mock("@/lib/events", async () => (await import("./library/testSvc")).eventsMock());

import { PackState } from "@/lib/api";
import { usePacks } from "@/state/packs";
import { formatBytes } from "@/lib/format";
import { emit } from "./library/testSvc";
import { folder, resetMocks, search, status, svc } from "./library/testFixtures";
import { SettingsSearch, folderRels } from "./SettingsSearch";

const settings = { enabled: true, paused: false, readText: true, speech: true, speechMaxMin: 60, skip: ["Received"] };

function lastSet(): Record<string, unknown> {
  return search.SetSettings.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

async function show(over = {}, st = status({ indexBytes: 52_428_800 })) {
  search.Status.mockResolvedValue(st);
  search.Settings.mockResolvedValue({ ...settings, ...over });
  svc.Folders.mockResolvedValue(folder("Toolbox", 0, [folder("Received", 3), folder("Downloads", 5, [folder("Downloads/Music", 2, [], { rel: "Downloads/Music" })]), folder("Edits", 1)]));
  render(<SettingsSearch />);
  await screen.findByRole("switch", { name: "Index in the background" });
  await waitFor(() => expect(screen.getByRole("list", { name: "Skipped folders" }).textContent).toContain("Received"));
}

describe("Settings → Search", () => {
  beforeEach(() => {
    resetMocks();
    usePacks.getState().setAll([]);
  });

  it("shows the status, the index size on disk and the origin lines", async () => {
    await show();
    expect((await screen.findByTestId("settings-search-status")).textContent).toBe(`Up to date · 100 files · ${formatBytes(52_428_800)} on disk`);
    expect(screen.getByText("SigLIP 2 by Google — trained on WebLI (web images with alt text) — Apache-2.0")).toBeTruthy();
    expect(screen.getByText("RapidOCR (PP-OCR) — Apache-2.0")).toBeTruthy();
    expect(screen.getByText("Whisper small by OpenAI — MIT. All run on this computer.")).toBeTruthy();
  });

  it("the toggles save the whole settings object with one change", async () => {
    await show();
    fireEvent.click(screen.getByRole("switch", { name: "Index in the background" }));
    await waitFor(() => expect(lastSet()).toMatchObject({ enabled: false, readText: true, speech: true, speechMaxMin: 60, skip: ["Received"] }));
    fireEvent.click(screen.getByRole("switch", { name: "Read text in pictures and PDFs" }));
    await waitFor(() => expect(lastSet()).toMatchObject({ readText: false, enabled: false }));
    fireEvent.click(screen.getByRole("switch", { name: "Listen to speech in videos and audio" }));
    await waitFor(() => expect(lastSet()).toMatchObject({ speech: false }));
  });

  it("the transcription cap is a 1–600 stepper", async () => {
    await show();
    const field = screen.getByLabelText("Transcribe automatically up to") as HTMLInputElement;
    expect(field.value).toBe("60");
    fireEvent.change(field, { target: { value: "900" } });
    fireEvent.blur(field);
    await waitFor(() => expect(lastSet()).toMatchObject({ speechMaxMin: 600 }));
    fireEvent.change(field, { target: { value: "30" } });
    fireEvent.blur(field);
    await waitFor(() => expect(lastSet()).toMatchObject({ speechMaxMin: 30 }));
  });

  it("Pause and Resume", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(lastSet()).toMatchObject({ paused: true }));
    expect(await screen.findByRole("button", { name: "Resume" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(lastSet()).toMatchObject({ paused: false }));
  });

  it("the skip list adds library folders (never outside the library) and removes them", async () => {
    await show();
    const add = screen.getByRole("button", { name: "Add" });
    expect(add.getAttribute("aria-disabled")).toBe("true");
    const pick = screen.getByLabelText("Folder to skip") as HTMLSelectElement;
    // Already-skipped folders aren't offered; nested ones are.
    expect([...pick.options].map((o) => o.value)).toEqual(["", "Downloads", "Downloads/Music", "Edits"]);
    fireEvent.change(pick, { target: { value: "Downloads" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(lastSet().skip).toEqual(["Received", "Downloads"]));
    expect(await screen.findByText("Downloads", { selector: "span" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("list", { name: "Skipped folders" })).getAllByRole("button", { name: "Remove" })[0] as HTMLElement);
    await waitFor(() => expect(lastSet().skip).toEqual(["Downloads"]));
  });

  it("folderRels flattens the tree without the root", () => {
    expect(folderRels(folder("Toolbox", 0, [folder("A", 1, [folder("A/B", 1, [], { rel: "A\\B" })])]))).toEqual(["A", "A/B"]);
    expect(folderRels(null)).toEqual([]);
  });

  it("Rescan now and Rebuild index call the service", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Rescan now" }));
    await waitFor(() => expect(search.Rescan).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Rebuild index" }));
    await waitFor(() => expect(search.Rebuild).toHaveBeenCalled());
  });

  it("Delete index asks first, names the size, and only then deletes", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Delete index" }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText(new RegExp(`frees ${formatBytes(52_428_800).replace(".", "\\.")}`))).toBeTruthy();
    fireEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
    expect(search.DeleteIndex).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete index" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete index" }));
    await waitFor(() => expect(search.DeleteIndex).toHaveBeenCalled());
  });

  it("follows search:status events", async () => {
    await show();
    emit("search:status", status({ stage: "pictures", pending: 3, done: 1240, total: 3100, indexBytes: 0 }));
    await waitFor(() => expect(screen.getByTestId("settings-search-status").textContent).toBe("Indexing pictures 1,240 of 3,100"));
  });

  it("not installed: the gate with the Smart search pack's install button, no Pause", async () => {
    usePacks.getState().setAll([{ id: "search", name: "Smart search", icon: "scan-eye", description: "", state: PackState.PackMissing, unsupportedReason: "", components: [], unlocks: [], jobId: "" } as never]);
    search.Status.mockResolvedValue(status({ installed: false }));
    render(<SettingsSearch />);
    const gate = await screen.findByTestId("search-gate");
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    fireEvent.click(within(gate).getByRole("button", { name: /Install Smart search/ }));
    await waitFor(() => expect(search.PacksInstall).toHaveBeenCalledWith(["search"], ""));
  });
});
