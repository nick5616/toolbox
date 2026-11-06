import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apps = vi.hoisted(() => vi.fn());
const running = vi.hoisted(() => vi.fn());
const appFor = vi.hoisted(() => vi.fn());
const pickWith = vi.hoisted(() => vi.fn());
const pickFolder = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    FocusService: {
      Apps: (...a: unknown[]) => apps(...a),
      Running: (...a: unknown[]) => running(...a),
      AppFor: (...a: unknown[]) => appFor(...a),
      AppIcon: async () => "",
    },
    FilesService: { PickWith: (...a: unknown[]) => pickWith(...a), PickFolder: (...a: unknown[]) => pickFolder(...a) },
  };
});

import type { FocusApp } from "@/lib/api";
import { AppIcon, AppPicker } from "./index";
import { clearAppIconCache } from "./AppIcon";
import { ruleFor } from "./rules";

function app(label: string, path: string, kind = "folder", rulePath = path.replace(/\\[^\\]+$/, "")): FocusApp {
  return { label, path, icon: "", store: false, rule: { id: "", label, kind, path: kind === "exe" ? path : rulePath, children: true } };
}

const DISCORD = app("Discord", "C:\\Users\\me\\AppData\\Local\\Discord\\app-1.0.9\\Discord.exe", "folder", "C:\\Users\\me\\AppData\\Local\\Discord");
const CODE = app("Visual Studio Code", "C:\\Code\\Code.exe", "folder", "C:\\Code");
const TERMINAL = app("Windows Terminal", "C:\\WindowsApps\\wt.exe", "exe");

beforeEach(() => {
  clearAppIconCache();
  apps.mockResolvedValue([DISCORD, CODE]);
  running.mockResolvedValue([TERMINAL]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ruleFor", () => {
  it("switches between folder and program rules", () => {
    expect(ruleFor(DISCORD, "folder").path).toBe("C:\\Users\\me\\AppData\\Local\\Discord");
    const exe = ruleFor(DISCORD, "exe");
    expect(exe).toMatchObject({ kind: "exe", path: DISCORD.path });
    expect(ruleFor(TERMINAL, "folder")).toMatchObject({ kind: "folder", path: "C:\\WindowsApps" });
  });
});

describe("AppPicker", () => {
  it("lists installed apps, searches and returns rules for several picks", async () => {
    const onPickRules = vi.fn();
    const onClose = vi.fn();
    render(<AppPicker open onClose={onClose} mode="rule" multiple onPickRules={onPickRules} />);
    expect(await screen.findByText("Discord")).toBeTruthy();
    expect(screen.getByText("Visual Studio Code")).toBeTruthy();

    await userEvent.type(screen.getByLabelText("Search apps"), "disc");
    expect(screen.queryByText("Visual Studio Code")).toBeNull();
    await userEvent.clear(screen.getByLabelText("Search apps"));

    await userEvent.click(screen.getByText("Discord"));
    await userEvent.click(screen.getByText("Visual Studio Code"));
    // Switch Discord from its folder to the one program.
    await userEvent.click(screen.getAllByRole("radio", { name: "Program" })[0]!);
    await userEvent.click(screen.getByRole("button", { name: "Add 2 apps" }));

    expect(onPickRules).toHaveBeenCalledTimes(1);
    const rules = onPickRules.mock.calls[0]![0];
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ kind: "exe", path: DISCORD.path });
    expect(rules[1]).toMatchObject({ kind: "folder", path: "C:\\Code" });
    expect(onClose).toHaveBeenCalled();
  });

  it("the Running tab loads the running programs", async () => {
    render(<AppPicker open onClose={() => undefined} mode="rule" multiple onPickRules={() => undefined} />);
    await screen.findByText("Discord");
    expect(running).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("tab", { name: "Running" }));
    expect(await screen.findByText("Windows Terminal")).toBeTruthy();
    expect(screen.queryByText("Discord")).toBeNull();
    expect(running).toHaveBeenCalledTimes(1);
  });

  it("the Browse tab adds a picked program through AppFor", async () => {
    pickWith.mockResolvedValue(["C:\\Tools\\Tool.exe"]);
    appFor.mockResolvedValue(app("Tool", "C:\\Tools\\Tool.exe", "folder", "C:\\Tools"));
    const onPickRules = vi.fn();
    render(<AppPicker open initialTab="browse" onClose={() => undefined} mode="rule" multiple onPickRules={onPickRules} />);
    await userEvent.click(screen.getByRole("button", { name: "Program…" }));
    expect(await screen.findByText("Tool")).toBeTruthy();
    expect(appFor).toHaveBeenCalledWith("C:\\Tools\\Tool.exe");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onPickRules.mock.calls[0]![0][0]).toMatchObject({ path: "C:\\Tools" });
  });

  it("shows chosen paths checked and disabled", async () => {
    render(<AppPicker open onClose={() => undefined} mode="rule" multiple chosen={["C:\\Code"]} onPickRules={() => undefined} />);
    await screen.findByText("Discord");
    const options = screen.getAllByRole("option");
    const code = options.find((o) => o.textContent?.includes("Visual Studio Code"))!;
    expect(code.getAttribute("aria-selected")).toBe("true");
    expect(code.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("button", { name: "Add" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("app mode picks exactly one program", async () => {
    const onPickApp = vi.fn();
    render(<AppPicker open onClose={() => undefined} mode="app" onPickApp={onPickApp} />);
    await userEvent.click(await screen.findByText("Discord"));
    await userEvent.click(screen.getByText("Visual Studio Code"));
    await userEvent.click(screen.getByRole("button", { name: "Choose" }));
    expect(onPickApp).toHaveBeenCalledTimes(1);
    expect(onPickApp.mock.calls[0]![0].label).toBe("Visual Studio Code");
  });

  it("renders nothing when closed", () => {
    render(<AppPicker open={false} onClose={() => undefined} mode="rule" />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("AppIcon", () => {
  it("falls back to a lettered tile when there's no icon", async () => {
    render(<AppIcon path="C:\\x.exe" label="Discord" />);
    await waitFor(() => expect(screen.getByTestId("app-icon-tile").textContent).toBe("D"));
  });
});
