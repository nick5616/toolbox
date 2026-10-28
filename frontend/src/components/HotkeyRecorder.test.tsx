import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HotkeyRecorder, eventToAccelerator } from "./HotkeyRecorder";

const ev = (over: Partial<Parameters<typeof eventToAccelerator>[0]>) => ({
  key: "v",
  code: "KeyV",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe("eventToAccelerator", () => {
  it("maps the primary modifier to CmdOrCtrl on mac", () => {
    expect(eventToAccelerator(ev({ metaKey: true, altKey: true }), true)).toBe("CmdOrCtrl+Alt+V");
    expect(eventToAccelerator(ev({ metaKey: true, ctrlKey: true, shiftKey: true }), true)).toBe("CmdOrCtrl+Ctrl+Shift+V");
  });
  it("maps Ctrl to CmdOrCtrl and Meta to Super elsewhere", () => {
    expect(eventToAccelerator(ev({ ctrlKey: true, altKey: true }), false)).toBe("CmdOrCtrl+Alt+V");
    expect(eventToAccelerator(ev({ metaKey: true }), false)).toBe("Super+V");
  });
  it("uses code for letters, digits, F-keys and named keys", () => {
    expect(eventToAccelerator(ev({ ctrlKey: true, key: "å", code: "KeyA" }), false)).toBe("CmdOrCtrl+A");
    expect(eventToAccelerator(ev({ ctrlKey: true, key: "1", code: "Digit1" }), false)).toBe("CmdOrCtrl+1");
    expect(eventToAccelerator(ev({ ctrlKey: true, key: "F12", code: "F12" }), false)).toBe("CmdOrCtrl+F12");
    expect(eventToAccelerator(ev({ altKey: true, key: " ", code: "Space" }), false)).toBe("Alt+Space");
    expect(eventToAccelerator(ev({ altKey: true, key: "ArrowUp", code: "ArrowUp" }), false)).toBe("Alt+Up");
  });
  it("rejects modifier-only and modifier-less combos", () => {
    expect(eventToAccelerator(ev({ ctrlKey: true, key: "Control", code: "ControlLeft" }), false)).toBe("");
    expect(eventToAccelerator(ev({ shiftKey: true }), false)).toBe("");
    expect(eventToAccelerator(ev({}), false)).toBe("");
  });
});

describe("HotkeyRecorder", () => {
  function setup(value = "CmdOrCtrl+Alt+V") {
    const onChange = vi.fn();
    render(<HotkeyRecorder value={value} onChange={onChange} label="Clipboard shortcut" />);
    const btn = screen.getByRole("button", { name: "Clipboard shortcut" });
    return { onChange, btn };
  }

  it("shows Disabled for an empty value", () => {
    setup("");
    expect(screen.getByText("Disabled")).toBeTruthy();
  });

  it("records a combination", () => {
    const { onChange, btn } = setup();
    fireEvent.click(btn);
    expect(screen.getByText("Press a shortcut…")).toBeTruthy();
    fireEvent.keyDown(btn, { key: "Control", code: "ControlLeft", ctrlKey: true });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(btn, { key: "k", code: "KeyK", ctrlKey: true, altKey: true });
    expect(onChange).toHaveBeenCalledWith("CmdOrCtrl+Alt+K");
    expect(screen.queryByText("Press a shortcut…")).toBeNull();
  });

  it("Escape cancels", () => {
    const { onChange, btn } = setup();
    fireEvent.click(btn);
    fireEvent.keyDown(btn, { key: "Escape", code: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText("Press a shortcut…")).toBeNull();
  });

  it("Backspace clears", () => {
    const { onChange, btn } = setup();
    fireEvent.click(btn);
    fireEvent.keyDown(btn, { key: "Backspace", code: "Backspace" });
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("blur cancels recording", () => {
    const { onChange, btn } = setup();
    fireEvent.click(btn);
    fireEvent.blur(btn);
    expect(screen.queryByText("Press a shortcut…")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
