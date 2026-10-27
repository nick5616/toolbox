import {
  DepsService,
  JobsService,
  LibraryService,
  ModulesService,
  SettingsService,
} from "@/lib/api";
import { on } from "@/lib/events";
import { routeFilesDropped } from "@/shell/dropRouting";
import { useDeps } from "./deps";
import { useJobs } from "./jobs";
import { useLibrary } from "./library";
import { useModules } from "./modules";
import { useSettings } from "./settings";
import { useUI } from "./ui";

let unsubscribers: Array<() => void> = [];

/** Subscribes every store to backend events. Idempotent. */
export function subscribeAll(): void {
  for (const u of unsubscribers) u();
  unsubscribers = [
    on("jobs:changed", (j) => useJobs.getState().upsert(j)),
    on("jobs:removed", (p) => useJobs.getState().removeLocal(p.ids ?? [])),
    on("jobs:progress", (p) => useJobs.getState().applyProgress(p)),
    on("jobs:log", (b) => useJobs.getState().appendLogs(b)),
    on("library:added", (o) => useLibrary.getState().add(o)),
    on("library:removed", (p) => useLibrary.getState().removeLocal(p.ids ?? [])),
    on("deps:changed", (p) => useDeps.getState().setAll(p.deps ?? [])),
    on("settings:changed", (s) => useSettings.getState().set(s)),
    on("app:files-dropped", routeFilesDropped),
    on("app:navigate", (n) => useUI.getState().navigate(n.target)),
  ];
}

/**
 * Loads all initial state in parallel and subscribes to events. App renders
 * nothing until this resolves, and <BootError> if it rejects.
 */
export async function bootstrap(): Promise<void> {
  // Subscribe first so nothing emitted during loading is lost.
  subscribeAll();
  const [settings, appInfo, modules, jobs, deps, recent] = await Promise.all([
    SettingsService.Get(),
    SettingsService.AppInfo(),
    ModulesService.List(),
    JobsService.List({ moduleId: "", statuses: [], limit: 200 }),
    DepsService.List(),
    LibraryService.Recent({ moduleId: "", search: "", limit: 100, cursor: "" }),
  ]);
  useSettings.getState().set(settings);
  useSettings.getState().setAppInfo(appInfo);
  useModules.getState().setAll(modules ?? []);
  useJobs.getState().setAll(jobs ?? []);
  useDeps.getState().setAll(deps ?? []);
  useLibrary.getState().setPage(recent.items ?? [], recent.nextCursor);

  // Fall back to the first ready module if the remembered view no longer exists.
  const ui = useUI.getState();
  const known = new Set(["library", "settings", ...(modules ?? []).map((m) => m.id)]);
  if (!known.has(ui.view)) ui.navigate("downloader");
}
