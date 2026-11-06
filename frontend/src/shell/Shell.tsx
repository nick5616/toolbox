import { Suspense } from "react";
import { isMac } from "@/lib/platform";
import { Button, ClickInHost, ErrorBoundary, Gallery, IconButton, Kbd, Toaster, cx } from "@/components";
import { popOutToolFlushed } from "@/lib/popout";
import { useToolPoppedOut } from "@/state/windows";
import { useModules } from "@/state/modules";
import { useSidebarCollapsed, useUI } from "@/state/ui";
import { toolViews } from "@/tools";
import { ComingSoonView } from "@/views/ComingSoonView";
import { LibraryView } from "@/views/LibraryView";
import { SetupView } from "@/views/setup/SetupView";
import { ToolsFolderBanner } from "@/views/setup/ToolsFolderBanner";
import { SettingsView } from "@/views/SettingsView";
import { CommandPalette } from "./CommandPalette";
import { CompositionBar } from "./CompositionBar";
import { ConstituentDrawer } from "./ConstituentDrawer";
import { DropOverlay } from "./DropOverlay";
import { PoppedOutPlaceholder } from "./PoppedOutPlaceholder";
import { JobTray } from "./JobTray";
import { Sidebar } from "./Sidebar";
import { viewTitle } from "./nav";
import { useBuiltinCommands } from "./useBuiltinCommands";
import { useGlobalPaste } from "./useGlobalPaste";
import { useJobToasts } from "./useJobToasts";
// --- pipelines ---
import { PipelineBanner } from "./PipelineBanner";
import { usePipelineNotices } from "./usePipelineNotices";
// --- end pipelines ---
import { useShellShortcuts } from "./useShellShortcuts";
import styles from "./Shell.module.css";

/** Views that are not tools (no Pop out). */
const NON_TOOL_VIEWS = new Set(["library", "settings", "gallery", "setup"]);

/** A tool that's open in its own window shows a placeholder here instead. */
function ToolSlot({ view }: { view: string }) {
  const out = useToolPoppedOut(view);
  if (out) return <PoppedOutPlaceholder windowKey={out} />;
  const Tool = toolViews[view];
  return (
    <ErrorBoundary label="This tool" resetKey={view}>
      <Suspense fallback={null}>{Tool ? <Tool moduleId={view} /> : null}</Suspense>
    </ErrorBoundary>
  );
}

function ViewRouter({ view }: { view: string }) {
  if (view === "library") return <LibraryView />;
  if (view === "settings") return <SettingsView />;
  if (view === "gallery" && import.meta.env.DEV) return <Gallery />;
  const Tool = toolViews[view];
  if (Tool) return <ToolSlot view={view} />;
  return <ComingSoonView moduleId={view} />;
}

export function Shell() {
  const view = useUI((s) => s.view);
  const returnView = useUI((s) => s.returnView);
  const collapsed = useSidebarCollapsed();
  const setPaletteOpen = useUI((s) => s.setPaletteOpen);
  const byId = useModules((s) => s.byId);
  const shown = view === "setup" ? returnView : view;
  const popOutName = !NON_TOOL_VIEWS.has(shown) && toolViews[shown] ? byId[shown]?.name : undefined;

  useBuiltinCommands();
  useShellShortcuts();
  useGlobalPaste();
  useJobToasts();
  // --- pipelines ---
  usePipelineNotices();
  // --- end pipelines ---

  return (
    <div id="app-root" className={cx(styles.root, collapsed && styles.collapsed)} data-file-drop-target>
      <Sidebar />
      <div className={styles.main}>
        <header className={cx(styles.topbar, isMac && styles.drag)}>
          <div className={styles.titleGroup}>
            <h1 className={styles.title}>{viewTitle(view, byId)}</h1>
            <CompositionBar view={shown} />
          </div>
          <div className={cx(styles.actions, styles.noDrag)}>
            {popOutName ? (
              <IconButton
                icon="picture-in-picture-2"
                label="Pop out"
                data-tip="Open this tool in its own window"
                onClick={() => void popOutToolFlushed(shown, popOutName)}
              />
            ) : null}
            <Button size="sm" icon="search" data-tip="Find a tool, action, setting or recent file and jump to it" onClick={() => setPaletteOpen(true)}>
              Search
              <Kbd combo="Mod+K" />
            </Button>
          </div>
        </header>
        <ToolsFolderBanner />
        {/* --- pipelines --- */}
        <PipelineBanner view={shown} />
        {/* --- end pipelines --- */}
        <ClickInHost className={styles.viewHost}>
          <main className={styles.view}>
            <ViewRouter view={shown} />
          </main>
          <ConstituentDrawer view={shown} />
        </ClickInHost>
        <JobTray />
      </div>
      {view === "setup" ? <SetupView overlay onClose={() => useUI.getState().navigate(returnView)} /> : null}
      <CommandPalette />
      <DropOverlay />
      <Toaster />
    </div>
  );
}
