import { Suspense, useEffect, useMemo, useState } from "react";
import { Button, ClickInHost, ErrorBoundary, Icon, Toaster, toast } from "@/components";
import { TooltipLayer } from "@/components/TooltipLayer";
import { DesktopService } from "@/lib/api";
import { EmbedContext, sendEmbedUseAcked, type EmbedContextValue } from "@/lib/embed";
import { toAppError } from "@/lib/errors";
import { on } from "@/lib/events";
import { closeWindow, currentWindow, takeWindowHandoff, toolWindowKey } from "@/lib/windows";
import { useModules } from "@/state/modules";
import { useUI, type Handoff } from "@/state/ui";
import { toolViews } from "@/tools";
import { ComingSoonView } from "@/views/ComingSoonView";
import { CompositionBar } from "./CompositionBar";
import { ConstituentDrawer } from "./ConstituentDrawer";
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

/**
 * The window's start-up handoff, taken once per page. React's StrictMode runs
 * the effect twice in development: the first run's take was discarded by its
 * cleanup and the second found nothing, so tool windows opened empty.
 */
let initialTake: Promise<unknown> | null = null;
function takeInitialHandoff(): Promise<unknown> {
  if (!initialTake) initialTake = takeWindowHandoff();
  return initialTake;
}

/** Test hook. */
export function resetInitialHandoffForTest(): void {
  initialTake = null;
}

/** Root of a tool window (`/?window=tool&view=<id>`): a slim top bar and the tool, nothing else. */
export function ToolWindowShell({ view }: ToolWindowShellProps) {
  const mod = useModules((s) => s.byId[view]);
  const [ready, setReady] = useState(false);
  // A handoff that carries an embed link: this window was popped out of another tool's click-in.
  const [embedded, setEmbedded] = useState<Handoff | null>(null);
  const key = currentWindow().key || toolWindowKey(view);

  // The window's one-time handoff, then any later one sent to this window.
  useEffect(() => {
    let live = true;
    const take = async (initial: boolean) => {
      try {
        const h = await (initial ? takeInitialHandoff() : takeWindowHandoff());
        if (!live || !isHandoff(h, view)) return;
        if (h.embed) {
          setEmbedded(h);
        } else {
          setEmbedded(null);
          useUI.getState().handOff(h);
        }
      } catch {
        /* no handoff */
      }
    };
    void take(true).finally(() => {
      if (live) setReady(true);
    });
    const off = on("windows:handoff", (p) => {
      if (p.key === key) void take(false);
    });
    return () => {
      live = false;
      off();
    };
  }, [view, key]);

  useEffect(() => {
    if (mod) document.title = `${mod.name} — Toolbox`;
  }, [mod]);

  // Use sends the files to the host's click-in; no ack means the host closed.
  const embed = useMemo<EmbedContextValue | null>(() => {
    const link = embedded?.embed;
    if (!embedded || !link) return null;
    return {
      host: link.host,
      hostName: link.hostName,
      placement: "window",
      handoff: embedded,
      useLabel: link.useLabel,
      onUse: link.useLabel
        ? (paths) => {
            void sendEmbedUseAcked(link, paths).then((ok) => {
              if (ok) toast({ title: `Sent to ${link.hostName}`, tone: "success" });
              else toast({ title: `${link.hostName} isn't open any more`, tone: "warn" });
            });
          }
        : undefined,
    };
  }, [embedded]);

  const bringBack = async () => {
    try {
      await DesktopService.ShowMain(view);
      await closeWindow(key);
    } catch (e) {
      toast({ tone: "danger", title: toAppError(e).message });
    }
  };

  const Tool = toolViews[view];
  const body = !ready ? null : Tool ? (
    <ErrorBoundary label="This tool" resetKey={view}>
      <Suspense fallback={null}>
        <Tool moduleId={view} />
      </Suspense>
    </ErrorBoundary>
  ) : (
    <ComingSoonView moduleId={view} />
  );
  return (
    <div className={styles.root} data-file-drop-target>
      <header className={styles.topbar}>
        <Icon name={mod?.icon ?? "box"} size={16} className={styles.icon} />
        <h1 className={styles.title}>{mod?.name ?? view}</h1>
        {embed ? (
          <span className={styles.forHost} data-tip={`Opened from ${embed.hostName}`}>
            for {embed.hostName}
          </span>
        ) : null}
        <CompositionBar view={view} />
        <span className={styles.spacer} />
        <Button size="sm" icon="app-window" data-tip="Close this window and show the tool in the main window again" onClick={() => void bringBack()}>
          Bring back
        </Button>
      </header>
      <ClickInHost className={styles.host}>
        <main className={styles.view}>{embed ? <EmbedContext.Provider value={embed}>{body}</EmbedContext.Provider> : body}</main>
        <ConstituentDrawer view={view} />
      </ClickInHost>
      <JobTray />
      <DropOverlay />
      <Toaster />
      <TooltipLayer />
    </div>
  );
}
