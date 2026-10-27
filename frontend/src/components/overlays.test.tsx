import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";
import { MenuButton } from "./MenuButton";
import { Slider } from "./Slider";

describe("Slider", () => {
  it("reports changes and shows the formatted value", () => {
    const onChange = vi.fn();
    render(<Slider value={5} min={0} max={10} onChange={onChange} format={(v) => `${v}%`} aria-label="Level" />);
    expect(screen.getByText("5%")).toBeTruthy();
    fireEvent.change(screen.getByRole("slider", { name: "Level" }), { target: { value: "7" } });
    expect(onChange).toHaveBeenCalledWith(7);
  });
});

describe("ConfirmDialog", () => {
  const setup = (tone?: "danger") => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="Sure?" confirmLabel="Do it" tone={tone} onConfirm={onConfirm} onCancel={onCancel} />);
    return { onConfirm, onCancel };
  };

  it("renders nothing when closed", () => {
    render(<ConfirmDialog open={false} title="x" confirmLabel="ok" onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("focuses confirm and Escape cancels", () => {
    const { onCancel } = setup();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Do it" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("Enter on the dialog confirms", () => {
    const { onConfirm } = setup();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    expect(onConfirm).toHaveBeenCalled();
  });

  it("focuses Cancel for danger and traps Tab", () => {
    setup("danger");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const confirm = screen.getByRole("button", { name: "Do it" });
    expect(document.activeElement).toBe(cancel);
    confirm.focus();
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });
});

describe("MenuButton", () => {
  it("loads async items on open and selects with the keyboard", async () => {
    const a = vi.fn();
    const b = vi.fn();
    const items = vi.fn().mockResolvedValue([
      { id: "a", label: "Alpha", onSelect: a },
      { id: "b", label: "Beta", onSelect: b },
    ]);
    render(<MenuButton label="Send to…" items={items} />);
    expect(items).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send to…" }));
    const menu = await screen.findByRole("menu");
    await screen.findByRole("menuitem", { name: "Alpha" });
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(b).toHaveBeenCalled();
    expect(a).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("shows the empty label and closes on Escape / outside click", async () => {
    render(<MenuButton label="Menu" items={() => []} emptyLabel="Nothing here" />);
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    expect(await screen.findByText("Nothing here")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    await screen.findByRole("menu");
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});
