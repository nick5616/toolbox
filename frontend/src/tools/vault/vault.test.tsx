import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({
  State: vi.fn(),
  Create: vi.fn(),
  Unlock: vi.fn(),
  Lock: vi.fn(),
  List: vi.fn(),
  Folders: vi.fn(),
  Enqueue: vi.fn(),
  Rename: vi.fn(),
  Move: vi.fn(),
  Delete: vi.fn(),
  Open: vi.fn(),
  Preview: vi.fn(),
  Export: vi.fn(),
}));
const listeners = vi.hoisted(() => ({ cb: null as ((s: unknown) => void) | null }));

vi.mock("@/lib/events", () => ({
  on: (_name: string, cb: (s: unknown) => void) => {
    listeners.cb = cb;
    return () => {
      listeners.cb = null;
    };
  },
}));
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    VaultService: svc,
    FilesService: { Pick: async () => ["/x.txt"], Stat: async () => [] },
  };
});

import { passphraseStrength } from "./useVaultState";
import VaultView from "./VaultView";

const base = { exists: true, unlocked: false, entries: 0, autoLockMinutes: 10, lockAt: 0 };
const entry = (id: string, name: string) => ({ id, name, folder: "", size: 2048, modTime: 1, addedAt: 1_700_000_000_000 });

beforeEach(() => {
  Object.values(svc).forEach((f) => f.mockReset());
  svc.State.mockResolvedValue(base);
  svc.Folders.mockResolvedValue([]);
  svc.List.mockResolvedValue([]);
  svc.Lock.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe("passphraseStrength", () => {
  it("rates by length and classes", () => {
    expect(passphraseStrength("short").level).toBe(0);
    expect(passphraseStrength("alllowercase").level).toBe(2);
    expect(passphraseStrength("Tr0ub4dor&3-horse").level).toBe(3);
  });
});

describe("Vault create flow", () => {
  it("blocks mismatched passphrases, then gates the recovery key", async () => {
    svc.State.mockResolvedValue({ ...base, exists: false });
    svc.Create.mockResolvedValue("AGE-SECRET-KEY-1ABC");
    const user = userEvent.setup();
    render(<VaultView moduleId="vault" />);
    const create = await screen.findByRole("button", { name: "Create vault" });
    expect((create as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText("Passphrase"), "correct horse");
    await user.type(screen.getByLabelText("Confirm passphrase"), "correct hors");
    expect(screen.getByText("Passphrases don't match")).toBeTruthy();
    expect((create as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText("Confirm passphrase"), "e");
    expect(screen.queryByText("Passphrases don't match")).toBeNull();
    await user.click(create);
    await waitFor(() => expect(svc.Create).toHaveBeenCalledWith("correct horse"));

    expect((await screen.findByTestId("recovery-key")).textContent).toBe("AGE-SECRET-KEY-1ABC");
    const open = screen.getByRole("button", { name: "Open vault" }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    await user.click(screen.getByRole("switch", { name: "I've saved it" }));
    expect(open.disabled).toBe(false);
    // The state event (vault now unlocked) must not skip the screen; Open vault continues.
    act(() => listeners.cb?.({ ...base, unlocked: true, lockAt: Date.now() + 600_000 }));
    await user.click(screen.getByRole("button", { name: "Open vault" }));
    expect(await screen.findByText(/Unlocked · locks in/)).toBeTruthy();
  });

  it("refuses passphrases under 8 characters", async () => {
    svc.State.mockResolvedValue({ ...base, exists: false });
    const user = userEvent.setup();
    render(<VaultView moduleId="vault" />);
    await user.type(await screen.findByLabelText("Passphrase"), "short");
    await user.type(screen.getByLabelText("Confirm passphrase"), "short");
    expect((screen.getByRole("button", { name: "Create vault" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Vault unlock", () => {
  it("shows the error inline and supports the recovery key", async () => {
    svc.Unlock.mockRejectedValueOnce({ cause: { code: "validation", message: "Wrong passphrase" } });
    const user = userEvent.setup();
    render(<VaultView moduleId="vault" />);
    await user.type(await screen.findByLabelText("Passphrase"), "nope");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Wrong passphrase");

    await user.click(screen.getByRole("button", { name: "Use recovery key" }));
    svc.Unlock.mockResolvedValueOnce(undefined);
    await user.type(screen.getByLabelText("Recovery key"), "AGE-SECRET-KEY-1XYZ");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(svc.Unlock).toHaveBeenLastCalledWith("AGE-SECRET-KEY-1XYZ"));
  });
});

describe("Vault notice", () => {
  it("shows the backup notice once after unlock and keeps it until dismissed", async () => {
    const user = userEvent.setup();
    render(<VaultView moduleId="vault" />);
    await screen.findByLabelText("Passphrase");
    act(() => listeners.cb?.({ ...base, unlocked: true, notice: "The vault index was restored from its backup copy" }));
    expect(await screen.findByText("The vault index was restored from its backup copy")).toBeTruthy();
    act(() => listeners.cb?.({ ...base, unlocked: true, entries: 1, notice: "" }));
    expect(screen.getByText("The vault index was restored from its backup copy")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("The vault index was restored from its backup copy")).toBeNull();
  });
});

describe("Vault unlocked", () => {
  it("counts down to auto-lock", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(1_700_000_000_000);
    svc.State.mockResolvedValue({ ...base, unlocked: true, lockAt: 1_700_000_000_000 + 9 * 60_000 - 500 });
    render(<VaultView moduleId="vault" />);
    expect(await screen.findByText("Unlocked · locks in 9 min")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(125_000);
    });
    expect(screen.getByText("Unlocked · locks in 7 min")).toBeTruthy();
  });

  it("lists files, confirms deletes and runs row actions", async () => {
    svc.State.mockResolvedValue({ ...base, unlocked: true, entries: 2, lockAt: Date.now() + 600_000 });
    svc.List.mockResolvedValue([entry("1", "photo.png"), entry("2", "notes.txt")]);
    svc.Preview.mockResolvedValue("data:image/png;base64,AAAA");
    svc.Open.mockResolvedValue(undefined);
    svc.Export.mockResolvedValue([{}]);
    svc.Delete.mockResolvedValue(undefined);
    svc.Rename.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<VaultView moduleId="vault" />);
    await screen.findByText("photo.png");
    expect(screen.getAllByText(/KiB/).length).toBe(2);

    // Preview only for images.
    expect(screen.queryByRole("button", { name: "Preview notes.txt" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Preview photo.png" }));
    expect((await screen.findByRole("img", { name: "photo.png" })).getAttribute("src")).toBe("data:image/png;base64,AAAA");
    await user.click(screen.getByRole("button", { name: "Close preview" }));

    await user.click(screen.getByRole("button", { name: "Open notes.txt" }));
    expect(svc.Open).toHaveBeenCalledWith("2");
    await user.click(screen.getByRole("button", { name: "Export notes.txt" }));
    await waitFor(() => expect(svc.Export).toHaveBeenCalledWith(["2"]));

    // Rename through the row menu.
    await user.click(screen.getByRole("button", { name: "More actions for notes.txt" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const input = screen.getByLabelText("Name");
    await user.clear(input);
    await user.type(input, "todo.txt");
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(svc.Rename).toHaveBeenCalledWith("2", "todo.txt"));

    // Delete needs a confirmation; cancel first.
    await user.click(screen.getByRole("button", { name: "Delete notes.txt" }));
    const dlg = screen.getByRole("dialog");
    expect(within(dlg).getByText("Permanently delete from the vault?")).toBeTruthy();
    await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
    expect(svc.Delete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete notes.txt" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(svc.Delete).toHaveBeenCalledWith(["2"]));
  });

  it("supports multi-select export and delete", async () => {
    svc.State.mockResolvedValue({ ...base, unlocked: true, entries: 2, lockAt: 0 });
    svc.List.mockResolvedValue([entry("1", "a.txt"), entry("2", "b.txt")]);
    svc.Export.mockResolvedValue([{}]);
    svc.Delete.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<VaultView moduleId="vault" />);
    await screen.findByText("a.txt");
    await user.click(screen.getByRole("checkbox", { name: "Select all files" }));
    expect(screen.getByText("2 selected")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Export selected" }));
    await waitFor(() => expect(svc.Export).toHaveBeenCalledWith(["1", "2"]));
    await user.click(screen.getByRole("button", { name: "Delete selected" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(svc.Delete).toHaveBeenCalledWith(["1", "2"]));
  });

  it("locks on request and adds files to the chosen folder", async () => {
    svc.State.mockResolvedValue({ ...base, unlocked: true, lockAt: 0 });
    svc.Enqueue.mockResolvedValue([{}]);
    const user = userEvent.setup();
    render(<VaultView moduleId="vault" />);
    await user.click(await screen.findByRole("button", { name: "Add files" }));
    await waitFor(() => expect(svc.Enqueue).toHaveBeenCalledWith(["/x.txt"], ""));
    await user.click(screen.getByRole("button", { name: "Lock" }));
    expect(svc.Lock).toHaveBeenCalled();
  });
});
