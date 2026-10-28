import { Suspense } from "react";
import { isMac } from "@/lib/platform";
import { Button, Gallery, Kbd, Toaster, cx } from "@/components";
import { useModules } from "@/state/modules";
import { useUI } from "@/state/ui";
import { toolViews } from "@/tools";
import { ComingSoonView } from "@/views/ComingSoonView";
import { LibraryView } from "@/views/LibraryView";
import { SetupView } from "@/views/setup/SetupView";
import { ToolsFolderBanner } from "@/views/setup/ToolsFolderBanner";
import { SettingsView } from "@/views/SettingsView";
import { CommandPalette } from "./CommandPalette";
import { DropOverlay } from "./DropOverlay";
import { JobTray } from "./JobTray";
import { Sidebar } from "./Sidebar";
import { viewTitle } from "./nav";
import { useBuiltinCommands } from "./useBuiltinCommands";
import { useGlobalPaste } from "./useGlobalPaste";
import { useJobToasts } from "./useJobToasts";
import { useShellShortcuts } from "./useShellShortcuts";
import styles from "./Shell.module.css";

function ViewRouter({ view }: { view: string }) {
  if (view === "library") return <LibraryView />;
  if (view === "settings") return <SettingsView />;
  if (view === "gallery" && import.meta.env.DEV) return <Gallery />;
  const Tool = toolViews[view];
  if (Tool) {
    return (
      <Suspense fallback={null}>
        <Tool moduleId={view} />
      </Suspense>
    );
  }
  return <ComingSoonView moduleId={view} />;
}

export function Shell() {
  const view = useUI((s) => s.view);
  const returnView = useUI((s) => s.returnView);
  const collapsed = useUI((s) => s.sidebarCollapsed);
  const setPaletteOpen = useUI((s) => s.setPaletteOpen);
  const byId = useModules((s) => s.byId);

  useBuiltinCommands();
  useShellShortcuts();
  useGlobalPaste();
  useJobToasts();

  return (
    <div id="app-root" className={cx(styles.root, collapsed && styles.collapsed)} data-file-drop-target>
      <Sidebar />
      <div className={styles.main}>
        <header className={cx(styles.topbar, isMac && styles.drag)}>
          <h1 className={styles.title}>{viewTitle(view, byId)}</h1>
          <Button size="sm" icon="search" className={styles.noDrag} onClick={() => setPaletteOpen(true)}>
            Search
            <Kbd combo="Mod+K" />
          </Button>
        </header>
        <ToolsFolderBanner />
        <main className={styles.view}>
          <ViewRouter view={view === "setup" ? returnView : view} />
        </main>
        <JobTray />
      </div>
      {view === "setup" ? <SetupView overlay onClose={() => useUI.getState().navigate(returnView)} /> : null}
      <CommandPalette />
      <DropOverlay />
      <Toaster />
    </div>
  );
}
