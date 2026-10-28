import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({
  List: vi.fn(),
  Copy: vi.fn(),
  Pin: vi.fn(),
  Delete: vi.fn(),
  Clear: vi.fn(),
  State: vi.fn(),
  Pause: vi.fn(),
  Resume: vi.fn(),
  ImageDataURL: vi.fn(),
  OpenPopup: vi.fn(),
}));
const desktop = vi.hoisted(() => ({ HidePopup: vi.fn(), ShowMain: vi.fn(), HotkeyStatus: vi.fn() }));
const handlers = vi.hoisted(() => new Map<string, Set<(data: unknown) => void>>());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, ClipboardService: svc, DesktopService: desktop };
});
vi.mock("@/lib/events", () => ({
  on: (name: string, cb: (data: unknown) => void) => {
    const set = handlers.get(name) ?? new Set();
    set.add(cb);
    handlers.set(name, set);
    return () => set.delete(cb);
  },
}));

import { ClipKind, type ClipItem } from "@/lib/api";
import { useDesktop } from "@/state/desktop";
import { defaultSettings, useSettings } from "@/state/settings";
import { useToastStore } from "@/components/toast";
import ClipboardPopup from "./ClipboardPopup";
import ClipboardView from "./ClipboardView";
import { ClipboardSettingsPanel } from "./ClipboardSettingsPanel";
import { clearThumbCache } from "./useImageThumb";
import { compareClips, matchesFilters } from "./clips";

function emit(name: string, data: unknown) {
  act(() => {
    for (const cb of handlers.get(name) ?? []) cb(data);
  });
}

function clip(id: string, over: Partial<ClipItem> = {}): ClipItem {
  return {
    id,
    kind: ClipKind.ClipText,
    text: `text of ${id}`,
    preview: `preview ${id}`,
    imagePath: "",
    width: 0,
    height: 0,
    byteSize: 10,
    pinned: false,
    createdAt: 1,
    lastUsedAt: 1000,
    ...over,
  };
}

const update = vi.fn();

function setEnabled(enabled: boolean) {
  const s = defaultSettings();
  useSettings.setState({ settings: { ...s, clipboard: { ...s.clipboard, enabled } }, update });
}

function page(...items: ClipItem[]) {
  return { items, nextCursor: "" };
}

function toasts() {
  return useToastStore.getState().toasts.map((t) => t.title);
}

beforeEach(() => {
  for (const f of [...Object.values(svc), ...Object.values(desktop), update]) f.mockReset();
  handlers.clear();
  clearThumbCache();
  useToastStore.setState({ toasts: [] });
  svc.List.mockResolvedValue(page());
  svc.Copy.mockResolvedValue(undefined);
  svc.Delete.mockResolvedValue(undefined);
  svc.Pause.mockResolvedValue(undefined);
  svc.Resume.mockResolvedValue(undefined);
  svc.OpenPopup.mockResolvedValue(undefined);
  svc.State.mockResolvedValue({ recording: true, paused: false, error: "" });
  desktop.HidePopup.mockResolvedValue(undefined);
  desktop.ShowMain.mockResolvedValue(undefined);
  update.mockResolvedValue(undefined);
  useDesktop.setState({ clipboard: { recording: true, paused: false, error: "" } });
  setEnabled(true);
});

describe("clips helpers", () => {
  it("sorts pinned first then newest", () => {
    const a = clip("a", { lastUsedAt: 5 });
    const b = clip("b", { lastUsedAt: 9 });
    const c = clip("c", { lastUsedAt: 1, pinned: true });
    expect([a, b, c].sort(compareClips).map((i) => i.id)).toEqual(["c", "b", "a"]);
  });
  it("matches filters like the server", () => {
    expect(matchesFilters(clip("a"), "PREVIEW", "all")).toBe(true);
    expect(matchesFilters(clip("a"), "zzz", "all")).toBe(false);
    expect(matchesFilters(clip("a"), "", "image")).toBe(false);
  });
});

describe("ClipboardView", () => {
  it("shows the off state and enables recording", async () => {
    setEnabled(false);
    const user = userEvent.setup();
    render(<ClipboardView moduleId="clipboard" />);
    expect(screen.getByText("Clipboard history is off")).toBeTruthy();
    expect(screen.getByText(/password managers are skipped/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Start recording clipboard history" }));
    expect(update).toHaveBeenCalledWith({ clipboard: expect.objectContaining({ enabled: true }) });
  });

  it("shows recording, paused and error states", async () => {
    svc.List.mockResolvedValue(page(clip("a")));
    const { unmount } = render(<ClipboardView moduleId="clipboard" />);
    expect(await screen.findByText("Recording")).toBeTruthy();
    expect(screen.getByText("Ctrl")).toBeTruthy();
    act(() => useDesktop.setState({ clipboard: { recording: true, paused: true, error: "" } }));
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    act(() => useDesktop.setState({ clipboard: { recording: false, paused: false, error: "Clipboard unavailable" } }));
    expect(screen.getByText("Error")).toBeTruthy();
    expect(screen.getByText("Clipboard unavailable")).toBeTruthy();
    unmount();
  });

  it("pauses and opens the popup", async () => {
    const user = userEvent.setup();
    render(<ClipboardView moduleId="clipboard" />);
    await user.click(screen.getByRole("button", { name: /Pause/ }));
    expect(svc.Pause).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Open popup/ }));
    expect(svc.OpenPopup).toHaveBeenCalled();
  });

  it("renders text and image rows with a lazy thumbnail", async () => {
    svc.ImageDataURL.mockResolvedValue("data:image/png;base64,AAAA");
    svc.List.mockResolvedValue(
      page(
        clip("t1", { preview: "hello world", text: "hello world" }),
        clip("i1", { kind: ClipKind.ClipImage, text: "", preview: "", width: 640, height: 480, byteSize: 2048 }),
      ),
    );
    render(<ClipboardView moduleId="clipboard" />);
    expect(await screen.findByText("hello world")).toBeTruthy();
    expect(screen.getByText("11 chars")).toBeTruthy();
    expect(screen.getByText(/640×480/)).toBeTruthy();
    await waitFor(() => expect(document.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AAAA"));
    expect(svc.ImageDataURL).toHaveBeenCalledWith("i1");
    expect(svc.ImageDataURL).toHaveBeenCalledTimes(1);
  });

  it("debounces search and filters by kind", async () => {
    const user = userEvent.setup();
    render(<ClipboardView moduleId="clipboard" />);
    await waitFor(() => expect(svc.List).toHaveBeenCalledTimes(1));
    await user.type(screen.getByRole("textbox", { name: "Search clipboard history" }), "foo");
    expect(svc.List).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(svc.List).toHaveBeenLastCalledWith(expect.objectContaining({ search: "foo", kind: "", limit: 200, cursor: "" })));
    await user.click(screen.getByRole("radio", { name: "Images" }));
    await waitFor(() => expect(svc.List).toHaveBeenLastCalledWith(expect.objectContaining({ search: "foo", kind: "image" })));
  });

  it("pages with Load more", async () => {
    svc.List.mockResolvedValueOnce({ items: [clip("a", { lastUsedAt: 9 })], nextCursor: "c1" });
    svc.List.mockResolvedValueOnce({ items: [clip("b", { lastUsedAt: 5 })], nextCursor: "" });
    const user = userEvent.setup();
    render(<ClipboardView moduleId="clipboard" />);
    await user.click(await screen.findByRole("button", { name: "Load more" }));
    expect(svc.List).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "c1" }));
    expect(await screen.findByText("preview b")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("applies added and removed events", async () => {
    svc.List.mockResolvedValue(page(clip("a", { lastUsedAt: 100 }), clip("b", { lastUsedAt: 50 })));
    render(<ClipboardView moduleId="clipboard" />);
    await screen.findByText("preview a");
    emit("clipboard:added", clip("c", { lastUsedAt: 500 }));
    emit("clipboard:added", clip("b", { lastUsedAt: 900 }));
    const order = () => screen.getAllByRole("option").map((o) => o.getAttribute("data-clip-id"));
    expect(order()).toEqual(["b", "c", "a"]);
    emit("clipboard:added", clip("a", { pinned: true, lastUsedAt: 100 }));
    expect(order()).toEqual(["a", "b", "c"]);
    emit("clipboard:removed", { ids: ["b"] });
    expect(order()).toEqual(["a", "c"]);
  });

  it("handles keyboard: arrows, Enter copies, P pins, Mod+Backspace deletes", async () => {
    svc.List.mockResolvedValue(page(clip("a", { lastUsedAt: 3 }), clip("b", { lastUsedAt: 2 }), clip("c", { lastUsedAt: 1 })));
    svc.Pin.mockImplementation(async (id: string, pinned: boolean) => clip(id, { pinned, lastUsedAt: 2 }));
    const user = userEvent.setup();
    render(<ClipboardView moduleId="clipboard" />);
    await screen.findByText("preview a");
    const listbox = screen.getByRole("listbox");
    listbox.focus();
    const selected = () => screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true")?.getAttribute("data-clip-id");
    expect(selected()).toBe("a");
    await user.keyboard("{ArrowDown}");
    expect(selected()).toBe("b");
    expect(listbox.getAttribute("aria-activedescendant")).toBe("clip-b");

    await user.keyboard("{Enter}");
    expect(svc.Copy).toHaveBeenCalledWith("b");
    await waitFor(() => expect(toasts()).toContain("Copied"));
    expect(JSON.stringify(useToastStore.getState().toasts)).not.toContain("text of b");

    await user.keyboard("p");
    expect(svc.Pin).toHaveBeenCalledWith("b", true);
    await waitFor(() => expect(screen.getAllByRole("option")[0]?.getAttribute("data-clip-id")).toBe("b"));

    await user.keyboard("{Control>}{Backspace}{/Control}");
    expect(svc.Delete).toHaveBeenCalledWith(["b"]);
    await waitFor(() => expect(screen.queryByText("preview b")).toBeNull());
  });

  it("does not pin while typing in the search field", async () => {
    svc.List.mockResolvedValue(page(clip("a")));
    const user = userEvent.setup();
    render(<ClipboardView moduleId="clipboard" />);
    await screen.findByText("preview a");
    await user.click(screen.getByRole("textbox", { name: "Search clipboard history" }));
    await user.keyboard("p");
    expect(svc.Pin).not.toHaveBeenCalled();
  });

  it("clears history with keep pinned on by default", async () => {
    svc.List.mockResolvedValue(page(clip("a")));
    svc.Clear.mockResolvedValue(3);
    const user = userEvent.setup();
    render(<ClipboardView moduleId="clipboard" />);
    await screen.findByText("preview a");
    await user.click(screen.getByRole("button", { name: /Clear…/ }));
    const dialog = screen.getByRole("dialog");
    const box = within(dialog).getByRole("checkbox", { name: "Keep pinned items" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Clear" }));
    expect(svc.Clear).toHaveBeenCalledWith(true);
    await waitFor(() => expect(toasts()).toContain("Cleared 3 items"));
  });

  it("turns recording off from the settings area", async () => {
    const user = userEvent.setup();
    render(<ClipboardView moduleId="clipboard" />);
    await user.click(screen.getByRole("button", { name: "Clipboard settings" }));
    await user.click(screen.getByRole("button", { name: "Turn off recording" }));
    expect(update).toHaveBeenCalledWith({ clipboard: expect.objectContaining({ enabled: false }) });
  });
});

describe("ClipboardSettingsPanel", () => {
  it("saves changes immediately", async () => {
    const user = userEvent.setup();
    render(<ClipboardSettingsPanel />);
    await user.click(screen.getByRole("switch", { name: "Capture images" }));
    expect(update).toHaveBeenLastCalledWith({ clipboard: expect.objectContaining({ images: false }) });
    await user.selectOptions(screen.getByLabelText("Keep history for"), "7");
    expect(update).toHaveBeenLastCalledWith({ clipboard: expect.objectContaining({ retentionDays: 7 }) });
    await user.click(screen.getByRole("button", { name: "Increase" }));
    expect(update).toHaveBeenLastCalledWith({ clipboard: expect.objectContaining({ maxItems: 550 }) });
  });

  it("shows inline field errors", async () => {
    update.mockRejectedValue({ cause: JSON.stringify({ code: "validation", message: "bad", fields: { "clipboard.maxItems": "Must be 50 to 5000" } }) });
    const user = userEvent.setup();
    render(<ClipboardSettingsPanel />);
    await user.click(screen.getByRole("button", { name: "Increase" }));
    expect(await screen.findByText("Must be 50 to 5000")).toBeTruthy();
  });
});

describe("ClipboardPopup", () => {
  const three = () => page(clip("a", { lastUsedAt: 3 }), clip("b", { lastUsedAt: 2 }), clip("c", { lastUsedAt: 1 }));

  it("focuses search, arrows + Enter copy then hide in order", async () => {
    svc.List.mockResolvedValue(three());
    const order: string[] = [];
    svc.Copy.mockImplementation(async () => void order.push("copy"));
    desktop.HidePopup.mockImplementation(async () => void order.push("hide"));
    const user = userEvent.setup();
    render(<ClipboardPopup />);
    await screen.findByText("preview a");
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search clipboard history" }));
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(order).toEqual(["copy", "hide"]));
    expect(svc.Copy).toHaveBeenCalledWith("b");
  });

  it("copies the nth item with number keys", async () => {
    svc.List.mockResolvedValue(three());
    const user = userEvent.setup();
    render(<ClipboardPopup />);
    await screen.findByText("preview a");
    await user.keyboard("3");
    await waitFor(() => expect(svc.Copy).toHaveBeenCalledWith("c"));
    await waitFor(() => expect(desktop.HidePopup).toHaveBeenCalled());
  });

  it("types digits into a non-empty search instead", async () => {
    svc.List.mockResolvedValue(three());
    const user = userEvent.setup();
    render(<ClipboardPopup />);
    await screen.findByText("preview a");
    await user.keyboard("x2");
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("x2");
    expect(svc.Copy).not.toHaveBeenCalled();
  });

  it("hides on Escape", async () => {
    const user = userEvent.setup();
    render(<ClipboardPopup />);
    await user.keyboard("{Escape}");
    expect(desktop.HidePopup).toHaveBeenCalled();
  });

  it("resets search and selection on window:show", async () => {
    svc.List.mockResolvedValue(three());
    const user = userEvent.setup();
    render(<ClipboardPopup />);
    await screen.findByText("preview a");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    await user.type(screen.getByRole("textbox"), "ab");
    (document.activeElement as HTMLElement).blur();
    const calls = svc.List.mock.calls.length;
    emit("window:show", { view: "clipboard" });
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(""));
    await waitFor(() => expect(svc.List.mock.calls.length).toBeGreaterThan(calls));
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(3));
    expect(screen.getAllByRole("option")[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("shows both empty states", async () => {
    const { unmount } = render(<ClipboardPopup />);
    expect(await screen.findByText("Nothing copied yet")).toBeTruthy();
    unmount();
    setEnabled(false);
    const user = userEvent.setup();
    render(<ClipboardPopup />);
    expect(await screen.findByText("Clipboard history is off — enable it in Toolbox")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open Toolbox" }));
    expect(desktop.ShowMain).toHaveBeenCalledWith("clipboard");
  });
});
