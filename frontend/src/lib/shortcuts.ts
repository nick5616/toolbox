import { useEffect, useRef } from "react";
import { isMac } from "./platform";

/**
 * A key combo: modifiers joined with "+", then a key.
 * Modifiers: Mod (⌘ on mac, Ctrl elsewhere), Shift, Alt, Ctrl.
 * Keys: KeyboardEvent.key values ("k", "Enter", "Escape", "/", ","), digits,
 * or "Backslash".
 * Examples: "Mod+K", "Mod+Shift+R", "Escape", "/", "Mod+1".
 */
export type Combo = string;

export interface ShortcutOptions {
  /** Only active while true (default true). */
  when?: boolean;
  /** Fire even when focus is in a text input (default false). */
  allowInInputs?: boolean;
  /** Call preventDefault when matched (default true). */
  preventDefault?: boolean;
}

/** True when focus is in something the user types into. */
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (t as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "range", "color"].includes(type);
  }
  return false;
}

/** Whether a keyboard event matches a combo on the current platform. */
export function matches(e: KeyboardEvent, combo: Combo): boolean {
  const parts = combo.split("+");
  const key = parts.pop();
  if (!key) return false;
  const mods = new Set(parts);
  const wantMeta = isMac && mods.has("Mod");
  const wantCtrl = mods.has("Ctrl") || (!isMac && mods.has("Mod"));
  if (e.metaKey !== wantMeta || e.ctrlKey !== wantCtrl || e.altKey !== mods.has("Alt")) return false;
  // Shifted punctuation ("?", "/") is matched by the produced character.
  const isSymbol = key.length === 1 && !/[a-z0-9]/i.test(key);
  if (!isSymbol && e.shiftKey !== mods.has("Shift")) return false;
  const want = key === "Backslash" ? "\\" : key;
  return e.key.toLowerCase() === want.toLowerCase();
}

/**
 * Binds a global keyboard shortcut for the lifetime of the component.
 * The handler may change between renders without re-binding.
 */
export function useShortcut(
  combo: Combo | Combo[],
  handler: (e: KeyboardEvent) => void,
  opts: ShortcutOptions = {},
): void {
  const { when = true, allowInInputs = false, preventDefault = true } = opts;
  const ref = useRef(handler);
  ref.current = handler;
  const combos = Array.isArray(combo) ? combo : [combo];
  const key = combos.join("|");

  useEffect(() => {
    if (!when) return;
    const list = key.split("|");
    const onKey = (e: KeyboardEvent) => {
      if (!allowInInputs && isEditableTarget(e.target)) return;
      if (list.some((c) => matches(e, c))) {
        if (preventDefault) e.preventDefault();
        ref.current(e);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key, when, allowInInputs, preventDefault]);
}
