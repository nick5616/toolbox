import {
  ClipboardService,
  DepsService,
  DesktopService,
  JobsService,
  LibraryService,
  ModulesService,
  SettingsService,
} from "@/lib/api";
import { on } from "@/lib/events";
import { currentWindow } from "@/lib/windows";
import { routeFilesDropped } from "@/shell/dropRouting";
import { notifyHiddenToTray } from "@/shell/hiddenToTray";
import { useDesktop } from "./desktop";
import { useDeps } from "./deps";
import { useJobs } from "./jobs";
import { subscribeLanShare } from "./lanshare";
import { useLibrary } from "./library";
import { useModules } from "./modules";
import { usePipelines } from "./pipelines";
import { useSettings } from "./settings";
import { useUI } from "./ui";
import { loadWindows, subscribeWindows } from "./windows";

let unsubscribers: Array<() => void> = [];

/** Subscribes every store to backend events. Idempotent. */
export function subscribeAll(): void {
  for (const u of unsubscribers) u();
  // Only the main window navigates on app:navigate and tells about the tray; the others
  // (tool and part windows) take drops only when `drop.window` is theirs (routeFilesDropped).
  const isMain = currentWindow().kind === "main";
  unsubscribers = [
    on("jobs:changed", (j) => useJobs.getState().upsert(j)),
    on("jobs:removed", (p) => useJobs.getState().removeLocal(p.ids ?? [])),
    on("jobs:progress", (p) => useJobs.getState().applyProgress(p)),
    on("jobs:log", (b) => useJobs.getState().appendLogs(b)),
    on("library:added", (o) => useLibrary.getState().add(o)),
    on("library:removed", (p) => useLibrary.getState().removeLocal(p.ids ?? [])),
    on("deps:changed", (p) => useDeps.getState().setAll(p.deps ?? [], true)),
    on("settings:changed", (s) => useSettings.getState().set(s)),
    on("app:files-dropped", routeFilesDropped),
    ...(isMain
      ? [
          on("app:navigate", (n) => {
            if (n.target === "palette") useUI.getState().setPaletteOpen(true);
            else if (n.target === "pipelines-runs") {
              usePipelines.getState().setTab("runs");
              useUI.getState().navigate("pipelines");
            } else useUI.getState().navigate(n.target);
          }),
          on("app:hidden-to-tray", () => notifyHiddenToTray()),
        ]
      : []),
    subscribeWindows(),
    on("pipelines:changed", (p) => usePipelines.getState().setEntries(p.pipelines ?? [])),
    on("pipelines:run", (r) => usePipelines.getState().upsertRun(r)),
    on("pipelines:runs-removed", (p) => usePipelines.getState().removeRuns(p.ids ?? [])),
    ...subscribeDesktop(),
    // Local File Transfer (Phase 13): main and tool windows, not popups.
    subscribeLanShare({ main: isMain }),
  ];
}

/** Events every window (main and popups) needs. */
function subscribeDesktop(): Array<() => void> {
  return [
    on("clipboard:state", (s) => useDesktop.getState().setClipboardState(s)),
    on("hotkeys:status", (h) => useDesktop.getState().setHotkeys(h.items ?? [])),
  ];
}

let popupUnsubscribers: Array<() => void> = [];

/**
 * Bootstrap for popup windows: settings, modules and desktop state only (no
 * jobs, library or drop routing).
 */
export async function bootstrapPopup(): Promise<void> {
  for (const u of popupUnsubscribers) u();
  popupUnsubscribers = [on("settings:changed", (s) => useSettings.getState().set(s)), ...subscribeDesktop()];
  const [settings, modules, clip, hotkeys] = await Promise.all([
    SettingsService.Get(),
    ModulesService.List(),
    ClipboardService.State(),
    DesktopService.HotkeyStatus(),
  ]);
  useSettings.getState().set(settings);
  useModules.getState().setAll(modules ?? []);
  useDesktop.getState().setClipboardState(clip);
  useDesktop.getState().setHotkeys(hotkeys ?? []);
}

/**
 * Loads all initial state in parallel and subscribes to events. App renders
 * nothing until this resolves, and <BootError> if it rejects.
 */
export async function bootstrap(): Promise<void> {
  // Subscribe first so nothing emitted during loading is lost.
  subscribeAll();
  const depsGen = useDeps.getState().gen;
  const [settings, appInfo, modules, jobs, deps, recent, clip, hotkeys] = await Promise.all([
    SettingsService.Get(),
    SettingsService.AppInfo(),
    ModulesService.List(),
    JobsService.List({ moduleId: "", statuses: [], limit: 200, pipelineRunId: "" }),
    DepsService.List(),
    LibraryService.Recent({ moduleId: "", search: "", limit: 100, cursor: "" }),
    ClipboardService.State(),
    DesktopService.HotkeyStatus(),
    usePipelines.getState().load(),
    loadWindows(),
  ]);
  useSettings.getState().set(settings);
  useSettings.getState().setAppInfo(appInfo);
  useModules.getState().setAll(modules ?? []);
  useJobs.getState().setAll(jobs ?? []);
  // A deps:changed that arrived while loading is newer than this reply (start-up detection races the first List).
  if (useDeps.getState().gen === depsGen) useDeps.getState().setAll(deps ?? []);
  useLibrary.getState().setPage(recent.items ?? [], recent.nextCursor);
  useDesktop.getState().setClipboardState(clip);
  useDesktop.getState().setHotkeys(hotkeys ?? []);

  // Fall back to the first ready module if the remembered view no longer exists.
  if (currentWindow().kind === "part") return;
  const ui = useUI.getState();
  const known = new Set(["library", "settings", ...(modules ?? []).map((m) => m.id)]);
  if (!known.has(ui.view)) ui.navigate("downloader");
}
