import { Suspense, useEffect, useState } from "react";
import { Button, ClickInHost, ErrorBoundary, Icon, Toaster, toast } from "@/components";
import { TooltipLayer } from "@/components/TooltipLayer";
import { DesktopService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { on } from "@/lib/events";
import { closeWindow, currentWindow, takeWindowHandoff, toolWindowKey } from "@/lib/windows";
import { useModules } from "@/state/modules";
import { useUI, type Handoff } from "@/state/ui";
import { toolViews } from "@/tools";
import { ComingSoonView } from "@/views/ComingSoonView";
import { CompositionBar } from "./CompositionBar";
import { DropOverlay } from "./DropOverlay";
import { JobTray } from "./JobTray";
import styles from "./ToolWindowShell.module.css";

export interface ToolWindowShellProps {
  /** The module shown in this window (the `view` parameter). */
  view: string;
}

function isHandoff(h: unknown, moduleId: string): h is Handoff {
  return !!h && typeof h === "object" && (h as { moduleId?: unknown }).moduleId === moduleId && Array.isArray((h as { inputs?: unknown }).inputs);
}

/** Root of a tool window (`/?window=tool&view=<id>`): a slim top bar and the tool, nothing else. */
export function ToolWindowShell({ view }: ToolWindowShellProps) {
  const mod = useModules((s) => s.byId[view]);
  const [ready, setReady] = useState(false);
  const key = currentWindow().key || toolWindowKey(view);

  // The window's one-time handoff, then any later one sent to this window.
  useEffect(() => {
    let live = true;
    const take = async () => {
      try {
        const h = await takeWindowHandoff();
        if (live && isHandoff(h, view)) useUI.getState().handOff(h);
      } catch {
        /* no handoff */
      }
    };
    void take().finally(() => {
      if (live) setReady(true);
    });
    const off = on("windows:handoff", (p) => {
      if (p.key === key) void take();
    });
    return () => {
      live = false;
      off();
    };
  }, [view, key]);

  useEffect(() => {
    if (mod) document.title = `${mod.name} — Toolbox`;
  }, [mod]);

  const bringBack = async () => {
    try {
      await DesktopService.ShowMain(view);
      await closeWindow(key);
    } catch (e) {
      toast({ tone: "danger", title: toAppError(e).message });
    }
  };

  const Tool = toolViews[view];
  return (
    <div className={styles.root} data-file-drop-target>
      <header className={styles.topbar}>
        <Icon name={mod?.icon ?? "box"} size={16} className={styles.icon} />
        <h1 className={styles.title}>{mod?.name ?? view}</h1>
        <CompositionBar view={view} />
        <span className={styles.spacer} />
        <Button size="sm" icon="app-window" data-tip="Close this window and show the tool in the main window again" onClick={() => void bringBack()}>
          Bring back
        </Button>
      </header>
      <ClickInHost className={styles.host}>
        <main className={styles.view}>
          {!ready ? null : Tool ? (
            <ErrorBoundary label="This tool" resetKey={view}>
              <Suspense fallback={null}>
                <Tool moduleId={view} />
              </Suspense>
            </ErrorBoundary>
          ) : (
            <ComingSoonView moduleId={view} />
          )}
        </main>
      </ClickInHost>
      <JobTray />
      <DropOverlay />
      <Toaster />
      <TooltipLayer />
    </div>
  );
}
