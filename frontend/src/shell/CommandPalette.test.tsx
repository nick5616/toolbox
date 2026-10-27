import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCommandRegistry } from "@/lib/commands";
import { useUI } from "@/state/ui";
import { CommandPalette } from "./CommandPalette";

describe("CommandPalette", () => {
  const alpha = vi.fn();
  const beta = vi.fn();

  beforeEach(() => {
    alpha.mockClear();
    beta.mockClear();
    useUI.setState({ paletteOpen: false });
    useCommandRegistry.setState({
      commands: {
        a: { id: "a", title: "Alpha thing", section: "Actions", run: alpha },
        b: { id: "b", title: "Beta thing", section: "Actions", run: beta },
      },
    });
  });

  it("opens with Mod+K and closes with Escape", () => {
    render(<CommandPalette />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("filters results by typing", () => {
    render(<CommandPalette />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "beta" } });
    expect(screen.queryByText("Alpha thing")).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("Enter runs the top command and closes", () => {
    render(<CommandPalette />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "alpha" } });
    fireEvent.keyDown(input, { key: "Enter" });
    return vi.waitFor(() => expect(alpha).toHaveBeenCalledTimes(1)).then(() => {
      expect(beta).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });
});
