import { LibraryService, Theme } from "@/lib/api";
import { useCommands, type Command } from "@/lib/commands";
import { toAppError } from "@/lib/errors";
import { toast } from "@/components";
import { useDeps } from "@/state/deps";
import { useJobs } from "@/state/jobs";
import { useSettings } from "@/state/settings";
import { useUI } from "@/state/ui";
import { extractUrls } from "./useGlobalPaste";

function guard(fn: () => Promise<unknown>): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (e) {
      toast({ tone: "danger", title: toAppError(e).message });
    }
  };
}

const setTheme = (theme: Theme) => guard(() => useSettings.getState().update({ theme }));

export function useBuiltinCommands(): void {
  const cmds: Command[] = [
    {
      id: "shell.toggle-tray",
      title: "Toggle job tray",
      section: "Actions",
      icon: "activity",
      shortcut: "Mod+J",
      run: () => useUI.getState().setTrayOpen(!useUI.getState().trayOpen),
    },
    {
      id: "shell.toggle-sidebar",
      title: "Toggle sidebar",
      section: "Actions",
      icon: "panel-left",
      shortcut: "Mod+Backslash",
      run: () => useUI.getState().setSidebarCollapsed(!useUI.getState().sidebarCollapsed),
    },
    {
      id: "jobs.cancel-all",
      title: "Cancel all jobs",
      section: "Actions",
      icon: "square",
      run: guard(() => useJobs.getState().cancelAll()),
    },
    {
      id: "jobs.clear-finished",
      title: "Clear finished jobs",
      section: "Actions",
      icon: "trash-2",
      run: guard(() => useJobs.getState().clearFinished()),
    },
    { id: "theme.dark", title: "Theme: Dark", section: "Actions", icon: "moon", keywords: ["appearance"], run: setTheme(Theme.ThemeDark) },
    { id: "theme.light", title: "Theme: Light", section: "Actions", icon: "sun", keywords: ["appearance"], run: setTheme(Theme.ThemeLight) },
    {
      id: "theme.system",
      title: "Theme: System",
      section: "Actions",
      icon: "monitor",
      keywords: ["appearance"],
      run: setTheme(Theme.ThemeSystem),
    },
    {
      id: "library.open-folder",
      title: "Open library folder",
      section: "Actions",
      icon: "folder-open",
      run: guard(() => LibraryService.OpenLibraryFolder("")),
    },
    {
      id: "deps.update-ytdlp",
      title: "Install/Update yt-dlp",
      section: "Actions",
      icon: "download",
      run: guard(() => useDeps.getState().updateYtDlp()),
    },
    {
      id: "deps.recheck",
      title: "Recheck dependencies",
      section: "Actions",
      icon: "refresh-cw",
      run: guard(() => useDeps.getState().recheck()),
    },
    {
      id: "downloader.paste-and-download",
      title: "Paste link and download",
      section: "Actions",
      icon: "clipboard",
      run: guard(async () => {
        const urls = extractUrls(await navigator.clipboard.readText());
        if (urls.length === 0) {
          toast({ tone: "warn", title: "No link found on the clipboard" });
          return;
        }
        useUI.getState().handOff({ moduleId: "downloader", inputs: urls });
      }),
    },
  ];
  useCommands(cmds);
}
