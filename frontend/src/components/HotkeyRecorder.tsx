// FOUNDATION STUB: WP-UI2 builds the recorder (SPEC.md §7). Props are frozen.

export interface HotkeyRecorderProps {
  /** Current Wails accelerator ("CmdOrCtrl+Alt+V"); "" = disabled. */
  value: string;
  /** Called with the new accelerator ("" when cleared with Backspace). */
  onChange: (accelerator: string) => void;
  /** Accessible label, e.g. "Clipboard history shortcut". */
  label: string;
  disabled?: boolean;
}

export function HotkeyRecorder(_props: HotkeyRecorderProps) {
  return null;
}
