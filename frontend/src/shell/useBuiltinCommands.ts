import { ClipboardService, LibraryService, PdfAction, Theme, VaultService } from "@/lib/api";
import { usePdfIntent } from "@/tools/pdf/intent";
import { useCommands, type Command } from "@/lib/commands";
import { toAppError } from "@/lib/errors";
import { toast } from "@/components";
import { useDeps } from "@/state/deps";
import { useDesktop } from "@/state/desktop";
import { useJobs } from "@/state/jobs";
import { useSettings } from "@/state/settings";
import { useUI } from "@/state/ui";
import { useVaultState } from "@/tools/vault/useVaultState";
import { extractUrls } from "./useGlobalPaste";
import { trimmerCommands } from "@/tools/trimmer/commands";
import { subtitlesCommands } from "@/tools/subtitles/commands";
import { audiocleanupCommands } from "@/tools/audiocleanup/commands";
import { lyricvideoCommands } from "@/tools/lyricvideo/commands";
import { redactCommands } from "@/tools/redact/commands";
import { eraserCommands } from "@/tools/eraser/commands";
import { devutilsCommands } from "@/tools/devutils/commands";

function guard(fn: () => Promise<unknown>): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (e) {
      toast({ tone: "danger", title: toAppError(e).message });
    }
  };
}

function openPdf(action: PdfAction) {
  usePdfIntent.getState().request(action);
  useUI.getState().navigate("pdf");
}

const setTheme =(theme: Theme) => guard(() => useSettings.getState().update({ theme }));

/** Opens Settings and scrolls to the element with `id` once it has rendered. */
function openSettingsSection(id: string) {
  useUI.getState().navigate("settings");
  let tries = 0;
  const tick = () => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView?.({ block: "start" });
    else if (++tries < 20) setTimeout(tick, 50);
  };
  setTimeout(tick, 0);
}

export function useBuiltinCommands(): void {
  const vault = useVaultState();
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
    {
      id: "clipboard.open",
      title: "Open clipboard history",
      section: "Actions",
      icon: "clipboard",
      run: guard(() => ClipboardService.OpenPopup()),
    },
    {
      id: "clipboard.pause",
      title: "Pause clipboard history",
      section: "Actions",
      icon: "pause",
      enabled: () => {
        const c = useDesktop.getState().clipboard;
        return useSettings.getState().settings.clipboard.enabled && !c.paused;
      },
      run: guard(() => ClipboardService.Pause()),
    },
    {
      id: "clipboard.resume",
      title: "Resume clipboard history",
      section: "Actions",
      icon: "play",
      enabled: () => {
        const c = useDesktop.getState().clipboard;
        return useSettings.getState().settings.clipboard.enabled && c.paused;
      },
      run: guard(() => ClipboardService.Resume()),
    },
    {
      id: "bg-remover.open",
      title: "Remove background…",
      section: "Actions",
      icon: "wand-sparkles",
      keywords: ["background", "cutout", "transparent"],
      run: () => useUI.getState().navigate("bg-remover"),
    },
    {
      id: "upscaler.open",
      title: "Upscale image…",
      section: "Actions",
      icon: "maximize-2",
      keywords: ["enlarge", "resolution", "super resolution"],
      run: () => useUI.getState().navigate("upscaler"),
    },
    {
      id: "pdf.merge",
      title: "Merge PDFs…",
      section: "Actions",
      icon: "file-text",
      keywords: ["combine", "join", "pdf"],
      run: () => openPdf(PdfAction.ActionMerge),
    },
    {
      id: "pdf.compress",
      title: "Compress PDF…",
      section: "Actions",
      icon: "archive",
      keywords: ["shrink", "smaller", "pdf"],
      run: () => openPdf(PdfAction.ActionCompress),
    },
    {
      id: "pdf.organize",
      title: "Organize PDF pages…",
      section: "Actions",
      icon: "file-text",
      keywords: ["reorder", "rotate", "delete pages", "pdf"],
      run: () => openPdf(PdfAction.ActionOrganize),
    },
    {
      // Opens the clipboard tool, whose own "Clear all" asks for confirmation.
      id: "clipboard.clear",
      title: "Clear clipboard history…",
      section: "Actions",
      icon: "trash-2",
      run: () => useUI.getState().navigate("clipboard"),
    },
    {
      id: "chat.new",
      title: "New chat",
      section: "Actions",
      icon: "message-square",
      keywords: ["llm", "conversation", "ai"],
      run: () => useUI.getState().navigate("llm-chat"),
    },
    {
      id: "chat.history",
      title: "Open chat history",
      section: "Actions",
      icon: "history",
      keywords: ["llm", "conversations"],
      run: () => useUI.getState().navigate("llm-chat"),
    },
    {
      id: "ocr.open",
      title: "Read text from image or PDF (OCR)…",
      section: "Actions",
      icon: "scan-search",
      keywords: ["ocr", "scan", "searchable", "text"],
      run: () => useUI.getState().navigate("ocr"),
    },
    {
      id: "vault.lock",
      title: "Lock vault",
      section: "Actions",
      icon: "lock",
      enabled: () => vault?.unlocked === true,
      run: guard(() => VaultService.Lock()),
    },
    {
      id: "vault.open",
      title: "Open vault",
      section: "Actions",
      icon: "lock",
      keywords: ["encrypted", "private"],
      run: () => useUI.getState().navigate("vault"),
    },
    {
      id: "packs.manage",
      title: "Manage tool packs",
      section: "Actions",
      icon: "archive",
      keywords: ["install", "download", "tools"],
      run: () => openSettingsSection("settings-packs"),
    },
    {
      id: "setup.show",
      title: "Show setup screen",
      section: "Actions",
      icon: "settings",
      keywords: ["first run", "welcome", "packs"],
      run: () => useUI.getState().navigate("setup"),
    },
    // Phase 6 tools: each package owns its tools/<id>/commands.ts.
    ...trimmerCommands(),
    ...subtitlesCommands(),
    ...audiocleanupCommands(),
    ...lyricvideoCommands(),
    ...redactCommands(),
    ...eraserCommands(),
    ...devutilsCommands(),
  ];
  useCommands(cmds);
}
