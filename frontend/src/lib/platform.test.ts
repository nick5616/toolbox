import { describe, expect, it } from "vitest";
import { acceleratorToCombo } from "./platform";

describe("acceleratorToCombo", () => {
  it.each([
    ["CmdOrCtrl+Alt+V", "Mod+Alt+V"],
    ["cmdorctrl+alt+space", "Mod+Alt+Space"],
    ["Option+Shift+f12", "Alt+Shift+F12"],
    ["Ctrl+Super+1", "Ctrl+Super+1"],
    ["", ""],
  ])("%s → %s", (accel, combo) => {
    expect(acceleratorToCombo(accel)).toBe(combo);
  });
});
