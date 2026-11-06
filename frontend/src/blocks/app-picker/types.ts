// Frozen props of the shared app picker (SPEC.md §5.1, §5.3; Phase 18 Wave 0).
// WP-U1 builds AppPicker.tsx; WP-U2 (Open in app) consumes it. Never import a tool.
import type { FocusAllowRule, FocusApp } from "@/lib/api";

export type AppPickerTab = "installed" | "running" | "browse";

export interface AppPickerProps {
  /** Open as a dialog; the picker closes itself through onClose. */
  open: boolean;
  onClose: () => void;
  /** "rule": returns AllowRules (Focus profiles, Always allowed, extras); "app": returns the program to open (Open in app). */
  mode: "rule" | "app";
  /** Rule mode may pick several; app mode picks one. */
  multiple?: boolean;
  /** Paths already chosen, shown as checked/disabled. */
  chosen?: ReadonlyArray<string>;
  /** First tab shown (default "installed"). */
  initialTab?: AppPickerTab;
  /** Rule mode: the suggested rules of the picked apps (the user may switch a rule between folder and exe). */
  onPickRules?: (rules: FocusAllowRule[]) => void;
  /** App mode: the picked program. */
  onPickApp?: (app: FocusApp) => void;
  /** Dialog title (default "Add app" / "Choose an app"). */
  title?: string;
}

/** A row's icon: the app's PNG data URL, else a lettered tile (AppIcon). */
export interface AppIconProps {
  path: string;
  label: string;
  /** Pixel size, default 20. */
  size?: number;
}
