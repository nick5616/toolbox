import { create } from "zustand";
import { SettingsService, Theme, type AppInfo, type Settings, type SettingsPatch } from "@/lib/api";

/** Mirrors core.DefaultHotkeys / DefaultClipboardSettings (used until settings load). */
export const DEFAULT_HOTKEYS: Record<string, string> = {
  clipboard: "CmdOrCtrl+Alt+V",
  quickOpen: "CmdOrCtrl+Alt+Space",
};

/** Default settings (mirrors Go; used before load and as a test fixture base). */
export function defaultSettings(): Settings {
  return {
    libraryDir: "",
    concurrency: 3,
    theme: Theme.ThemeDark,
    keepInTray: true,
    startAtLogin: false,
    hotkeys: { ...DEFAULT_HOTKEYS },
    clipboard: { enabled: false, images: true, retentionDays: 30, maxItems: 500 },
  };
}

interface SettingsState {
  settings: Settings;
  appInfo: AppInfo | null;
  set: (s: Settings) => void;
  setAppInfo: (a: AppInfo) => void;
  /** Persists a patch; the returned settings (and settings:changed) update the store. */
  update: (patch: Partial<SettingsPatch>) => Promise<Settings>;
}

export const useSettings = create<SettingsState>((set) => ({
  settings: defaultSettings(),
  appInfo: null,
  set: (s) => {
    set({ settings: s });
    applyTheme(s.theme);
  },
  setAppInfo: (a) => set({ appInfo: a }),
  update: async (patch) => {
    const next = await SettingsService.Update({
      libraryDir: patch.libraryDir ?? null,
      concurrency: patch.concurrency ?? null,
      theme: patch.theme ?? null,
      keepInTray: patch.keepInTray ?? null,
      startAtLogin: patch.startAtLogin ?? null,
      hotkeys: patch.hotkeys ?? null,
      clipboard: patch.clipboard ?? null,
    });
    set({ settings: next });
    applyTheme(next.theme);
    return next;
  },
}));

let mediaListener: ((e: MediaQueryListEvent) => void) | null = null;

/** Resolves a theme preference and sets <html data-theme>. */
export function applyTheme(theme: Theme | string): void {
  const mq = window.matchMedia?.("(prefers-color-scheme: light)");
  if (mq && mediaListener) {
    mq.removeEventListener("change", mediaListener);
    mediaListener = null;
  }
  const resolve = () =>
    theme === Theme.ThemeLight || (theme === Theme.ThemeSystem && mq?.matches) ? "light" : "dark";
  document.documentElement.dataset.theme = resolve();
  if (theme === Theme.ThemeSystem && mq) {
    mediaListener = () => {
      document.documentElement.dataset.theme = resolve();
    };
    mq.addEventListener("change", mediaListener);
  }
}
