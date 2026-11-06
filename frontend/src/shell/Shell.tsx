import { Suspense, useCallback, useState } from "react";
import { isMac } from "@/lib/platform";
import { Button, ClickInHost, ErrorBoundary, Gallery, IconButton, Kbd, Toaster, cx } from "@/components";
import { HeaderPresenceContext } from "@/components/ToolHeader";
import { HeaderSlotProvider } from "@/components";
import { useElementSize } from "@/lib/useElementSize";
import { popOutToolFlushed } from "@/lib/popout";
import { useToolPoppedOut } from "@/state/windows";
import { useModules } from "@/state/modules";
import { useSidebarCollapsed, useUI } from "@/state/ui";
import { shellOverlays, toolViews } from "@/tools";
import { ComingSoonView } from "@/views/ComingSoonView";
import { LibraryView } from "@/views/LibraryView";
import { SetupView } from "@/views/setup/SetupView";
import { ToolsFolderBanner } from "@/views/setup/ToolsFolderBanner";
import { SettingsView } from "@/views/SettingsView";
import { BatchResultsDialog } from "./BatchResultsDialog";
import { CommandPalette } from "./CommandPalette";
import { CompositionBar } from "./CompositionBar";
import { ConstituentDrawer } from "./ConstituentDrawer";
import { DropOverlay } from "./DropOverlay";
import { PoppedOutPlaceholder } from "./PoppedOutPlaceholder";
import { JobTray } from "./JobTray";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
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
/** Below this top bar width, Search collapses to an icon so a tool header fits. */
const SEARCH_ICON_BELOW = 800;
/** Top bar width (px) from which the condensed composition menu shows its label. */
const COMPOSITION_LABEL_FROM = 1150;

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
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [topbar, setTopbar] = useState<HTMLElement | null>(null);
  const [headers, setHeaders] = useState(0);
  const reportHeader = useCallback((present: boolean) => setHeaders((n) => Math.max(0, n + (present ? 1 : -1))), []);
  const { width: topbarWidth } = useElementSize(topbar);
  // A tool header needs the room: Search is an icon then (Mod+K still works).
  const tightSearch = headers > 0 || (topbarWidth > 0 && topbarWidth < SEARCH_ICON_BELOW);
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
        <header ref={setTopbar} className={cx(styles.topbar, isMac && styles.drag)}>
          <div className={styles.titleGroup}>
            <h1 className={styles.title}>{viewTitle(view, byId)}</h1>
            <CompositionBar view={shown} condensed={headers > 0} iconOnly={topbarWidth > 0 && topbarWidth < COMPOSITION_LABEL_FROM} />
          </div>
          <div ref={setSlot} className={cx(styles.slot, styles.noDrag)} data-testid="header-slot" />
          <div className={cx(styles.actions, styles.noDrag)}>
            {popOutName ? (
              <IconButton
                icon="picture-in-picture-2"
                label="Pop out"
                data-tip="Open this tool in its own window"
                onClick={() => void popOutToolFlushed(shown, popOutName)}
              />
            ) : null}
            {tightSearch ? (
              <IconButton icon="search" label="Search" kbd="Mod+K" data-tip="Find a tool, action, setting or recent file and jump to it" onClick={() => setPaletteOpen(true)} />
            ) : (
              <Button size="sm" icon="search" data-tip="Find a tool, action, setting or recent file and jump to it" onClick={() => setPaletteOpen(true)}>
                Search
                <Kbd combo="Mod+K" />
              </Button>
            )}
          </div>
        </header>
        <ToolsFolderBanner />
        {/* --- pipelines --- */}
        <PipelineBanner view={shown} />
        {/* --- end pipelines --- */}
        <HeaderPresenceContext.Provider value={reportHeader}>
          <HeaderSlotProvider value={slot}>
            <ClickInHost className={styles.viewHost}>
              <main className={styles.view}>
                <ViewRouter view={shown} />
              </main>
              <ConstituentDrawer view={shown} />
            </ClickInHost>
          </HeaderSlotProvider>
        </HeaderPresenceContext.Provider>
        <JobTray />
      </div>
      {view === "setup" ? <SetupView overlay onClose={() => useUI.getState().navigate(returnView)} /> : null}
      <CommandPalette />
      <ShortcutsOverlay />
      <BatchResultsDialog />
      <DropOverlay />
      <Suspense fallback={null}>
        {shellOverlays.map((Overlay, i) => (
          <Overlay key={i} />
        ))}
      </Suspense>
      <Toaster />
    </div>
  );
}
