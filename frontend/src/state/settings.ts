import { create } from "zustand";
import { SettingsService, Theme, type AppInfo, type Settings, type SettingsPatch } from "@/lib/api";

interface SettingsState {
  settings: Settings;
  appInfo: AppInfo | null;
  set: (s: Settings) => void;
  setAppInfo: (a: AppInfo) => void;
  /** Persists a patch; the returned settings (and settings:changed) update the store. */
  update: (patch: Partial<SettingsPatch>) => Promise<Settings>;
}

export const useSettings = create<SettingsState>((set) => ({
  settings: { libraryDir: "", concurrency: 3, theme: Theme.ThemeDark },
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
