import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const copy = vi.hoisted(() => vi.fn(async () => undefined));
const hashText = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    ClipboardService: { CopyText: (...a: unknown[]) => copy(...(a as [])) },
    DevUtilsService: { HashText: (...a: unknown[]) => hashText(...a), Enqueue: async () => [], FileBase64: async () => "QQ==" },
    FilesService: { Pick: async () => [], Stat: async () => [] },
    SettingsService: { ModuleState: async () => "", SetModuleState: async () => undefined },
  };
});

import { useUI } from "@/state/ui";
import DevUtilsView from "./DevUtilsView";
import { devutilsCommands } from "./commands";
import { UTILS, filterUtils, useDevUtilsNav } from "./registry";

beforeEach(() => {
  copy.mockClear();
  hashText.mockReset();
  useDevUtilsNav.setState({ selected: null });
});

describe("registry and commands", () => {
  it("has the twelve utilities and one palette command each", () => {
    expect(UTILS.map((u) => u.id)).toEqual(["json", "base64", "url", "hash", "uuid", "jwt", "time", "numbers", "color", "regex", "diff", "text"]);
    const cmds = devutilsCommands();
    expect(cmds).toHaveLength(12);
    expect(cmds[0]?.title).toBe("Dev Utilities: JSON");
  });
  it("a command selects the utility and navigates", () => {
    devutilsCommands().find((c) => c.id === "dev-utils.regex")?.run();
    expect(useDevUtilsNav.getState().selected).toBe("regex");
    expect(useUI.getState().view).toBe("dev-utils");
  });
  it("filters by name and keyword", () => {
    expect(filterUtils("sha").map((u) => u.id)).toEqual(["hash"]);
    expect(filterUtils("color").map((u) => u.id)).toEqual(["color"]);
    expect(filterUtils("").length).toBe(12);
  });
});

describe("DevUtilsView", () => {
  it("reports JSON errors with line and column and copies through Go", async () => {
    const user = userEvent.setup();
    render(<DevUtilsView moduleId="dev-utils" />);
    const input = await screen.findByLabelText("JSON input");
    fireEvent.change(input, { target: { value: '{\n  "a": 1,\n}' } });
    expect(await screen.findByText(/line 3, column 1/)).toBeTruthy();

    fireEvent.change(input, { target: { value: '{"b":1,"a":2}' } });
    await waitFor(() => expect(screen.getByLabelText("JSON").textContent).toContain('"b": 1'));
    await user.click(screen.getAllByRole("button", { name: "Copy" })[0]!);
    await waitFor(() => expect(copy).toHaveBeenCalledWith('{\n  "b": 1,\n  "a": 2\n}'));
  });

  it("switches utilities from the list and the palette selection", async () => {
    const user = userEvent.setup();
    render(<DevUtilsView moduleId="dev-utils" />);
    await user.click(await screen.findByRole("button", { name: "UUID" }));
    expect(await screen.findByRole("button", { name: "Generate" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "UUID" })).toBeTruthy();
  });

  it("highlights a hash that matches the compare field", async () => {
    hashText.mockResolvedValue([
      { algorithm: "md5", hex: "5d41402abc4b2a76b9719d911017c592" },
      { algorithm: "sha1", hex: "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d" },
      { algorithm: "sha256", hex: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" },
      { algorithm: "sha512", hex: "9b71d224bd62f378" },
      { algorithm: "crc32", hex: "3610a686" },
    ]);
    useDevUtilsNav.setState({ selected: "hash" });
    render(<DevUtilsView moduleId="dev-utils" />);
    fireEvent.change(await screen.findByLabelText("Text to hash"), { target: { value: "hello" } });
    await waitFor(() => expect(hashText).toHaveBeenCalledWith("hello"));
    await screen.findByText("5d41402abc4b2a76b9719d911017c592");
    fireEvent.change(screen.getByLabelText("Compare"), { target: { value: "5D41402ABC4B2A76B9719D911017C592" } });
    expect(await screen.findByText("Match")).toBeTruthy();
  });
});
