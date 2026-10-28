/** True on macOS (decided synchronously from the webview's user agent). */
export const isMac: boolean = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** Label of the primary modifier key. */
export const modKeyLabel: string = isMac ? "⌘" : "Ctrl";

/** Label for "show this file in the OS file manager". */
export const revealLabel: string = isMac ? "Reveal in Finder" : "Show in Explorer";

const macSymbols: Record<string, string> = {
  Mod: "⌘",
  Shift: "⇧",
  Alt: "⌥",
  Ctrl: "⌃",
  Enter: "↵",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Backslash: "\\",
};

const pcNames: Record<string, string> = {
  Mod: "Ctrl",
  Enter: "Enter",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Backslash: "\\",
};

/** Splits a combo like "Mod+Shift+K" into display tokens for the current OS. */
export function comboTokens(combo: string): string[] {
  return combo.split("+").map((part) => (isMac ? macSymbols[part] : pcNames[part]) ?? part.toUpperCase());
}

/** Renders a combo for display: "⌘⇧K" on mac, "Ctrl+Shift+K" elsewhere. */
export function formatCombo(combo: string): string {
  return comboTokens(combo).join(isMac ? "" : "+");
}

const accelModifiers: Record<string, string> = {
  cmdorctrl: "Mod",
  cmd: "Mod",
  command: "Mod",
  ctrl: "Ctrl",
  control: "Ctrl",
  optionoralt: "Alt",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  super: "Super",
};

/**
 * Converts a Wails accelerator ("CmdOrCtrl+Alt+V", used for global hotkeys)
 * to a display combo for <Kbd> ("Mod+Alt+V"). "" stays "".
 */
export function acceleratorToCombo(accel: string): string {
  if (!accel) return "";
  const parts = accel.split("+");
  const key = parts.pop() ?? "";
  const mods = parts.map((p) => accelModifiers[p.trim().toLowerCase()] ?? p.trim());
  const k = key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
  return [...mods, k].join("+");
}
