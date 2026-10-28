import { useState, type KeyboardEvent } from "react";
import { acceleratorToCombo, isMac } from "@/lib/platform";
import { Kbd } from "./Kbd";
import { cx } from "./cx";
import styles from "./HotkeyRecorder.module.css";

export interface HotkeyRecorderProps {
  /** Current Wails accelerator ("CmdOrCtrl+Alt+V"); "" = disabled. */
  value: string;
  /** Called with the new accelerator ("" when cleared with Backspace). */
  onChange: (accelerator: string) => void;
  /** Accessible label, e.g. "Clipboard history shortcut". */
  label: string;
  disabled?: boolean;
}

/** The subset of KeyboardEvent the converter needs. */
export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const MODIFIER_KEYS = new Set(["Control", "Meta", "Alt", "Shift", "AltGraph", "OS", "Hyper", "Super", "CapsLock"]);

const NAMED_KEYS: Record<string, string> = {
  Space: "Space",
  Enter: "Return",
  NumpadEnter: "Return",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "page up",
  PageDown: "page down",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

/** Wails key name for an event, or "" when it isn't a usable non-modifier key. */
function keyName(e: KeyLike): string {
  if (MODIFIER_KEYS.has(e.key)) return "";
  const code = e.code;
  let m = /^Key([A-Z])$/.exec(code);
  if (m?.[1]) return m[1];
  m = /^Digit(\d)$/.exec(code);
  if (m?.[1]) return m[1];
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  const named = NAMED_KEYS[code];
  if (named) return named;
  if (e.key.length === 1 && e.key !== " ") return e.key.toUpperCase();
  return "";
}

/**
 * Converts a keydown into a Wails accelerator, or "" when it isn't a valid
 * global shortcut (modifier-only, or no Ctrl/Meta/Alt).
 * The primary modifier (Meta on mac, Ctrl elsewhere) becomes CmdOrCtrl.
 */
export function eventToAccelerator(e: KeyLike, mac: boolean = isMac): string {
  const key = keyName(e);
  if (!key) return "";
  if (!e.ctrlKey && !e.metaKey && !e.altKey) return "";
  const parts: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) parts.push("CmdOrCtrl");
  if (mac && e.ctrlKey) parts.push("Ctrl");
  if (!mac && e.metaKey) parts.push("Super");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

export function HotkeyRecorder({ value, onChange, label, disabled }: HotkeyRecorderProps) {
  const [recording, setRecording] = useState(false);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    const ev = e.nativeEvent;
    e.preventDefault();
    e.stopPropagation();
    if (ev.key === "Escape") {
      setRecording(false);
      return;
    }
    const noMods = !ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey;
    if (noMods && (ev.key === "Backspace" || ev.key === "Delete")) {
      setRecording(false);
      onChange("");
      return;
    }
    const accel = eventToAccelerator(ev);
    if (!accel) return;
    setRecording(false);
    onChange(accel);
  };

  const combo = acceleratorToCombo(value);
  return (
    <button
      type="button"
      className={cx(styles.root, recording && styles.recording)}
      aria-label={label}
      disabled={disabled}
      onClick={() => setRecording(true)}
      onKeyDown={onKeyDown}
      onBlur={() => setRecording(false)}
    >
      {recording ? (
        <span className={styles.prompt}>Press a shortcut…</span>
      ) : combo ? (
        <Kbd combo={combo} />
      ) : (
        <span className={styles.disabled}>Disabled</span>
      )}
    </button>
  );
}
