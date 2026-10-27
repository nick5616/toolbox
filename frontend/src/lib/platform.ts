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
