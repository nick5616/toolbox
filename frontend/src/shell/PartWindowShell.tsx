import { Suspense, useEffect, useState } from "react";
import { Banner, Button, EmptyState, ErrorBoundary, Icon, Toaster, toast } from "@/components";
import { TooltipLayer } from "@/components/TooltipLayer";
import { toAppError } from "@/lib/errors";
import { closeWindow, currentWindow, focusWindow } from "@/lib/windows";
import { loadPartHost } from "@/parts";
import { getPart } from "@/parts/registry";
import { useBridgesStatus } from "@/state/bridge";
import { useModules } from "@/state/modules";
import styles from "./PartWindowShell.module.css";

/** How long a part window waits for its host to answer before saying so. */
export const HOST_WAIT_MS = 6000;

export interface PartWindowShellProps {
  /** The part id (the `part` parameter). */
  part: string;
}

/** Root of a part window (`/?window=part&part=<id>`): connects to the host's store, then renders the part. */
export function PartWindowShell({ part }: PartWindowShellProps) {
  // The tool's part definitions load on demand (parts/index.ts), not with the entry bundle.
  const [loaded, setLoaded] = useState(() => !!getPart(part));
  useEffect(() => {
    let live = true;
    loadPartHost(part).then(
      () => live && setLoaded(true),
      () => live && setLoaded(true), // falls through to "this panel doesn't exist"
    );
    return () => {
      live = false;
    };
  }, [part]);
  const spec = loaded ? getPart(part) : undefined;
  const host = useModules((s) => (spec ? s.byId[spec.host] : undefined));
  const hostName = host?.name ?? spec?.host ?? "the tool";
  const bridge = useBridgesStatus();
  const [connected, setConnected] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [waited, setWaited] = useState(false);
  const key = currentWindow().key;
  const heading = spec ? (spec.headingFor?.(currentWindow().params) ?? { title: spec.title, icon: spec.icon }) : null;

  useEffect(() => {
    if (!spec) return;
    document.title = `${heading?.title ?? spec.title} — Toolbox`;
    let live = true;
    let cleanup: (() => void) | undefined;
    const run = async () => {
      try {
        cleanup = (await spec.connect?.(currentWindow().params)) ?? undefined;
        if (!live) cleanup?.();
        else setConnected(true);
      } catch (e) {
        if (live) setFailed(toAppError(e).message);
      }
    };
    void run();
    return () => {
      live = false;
      cleanup?.();
    };
  }, [spec]);

  // No host answer in 6 s (the part never went live).
  useEffect(() => {
    if (!connected || bridge === "live" || bridge === "none") {
      setWaited(false);
      return;
    }
    const t = setTimeout(() => setWaited(true), HOST_WAIT_MS);
    return () => clearTimeout(t);
  }, [connected, bridge]);

  const bringBack = () => {
    closeWindow(key).catch((e: unknown) => toast({ tone: "danger", title: toAppError(e).message }));
  };

  let body;
  if (!loaded) {
    body = null;
  } else if (!spec) {
    body = <EmptyState icon="circle-alert" title="Nothing to show here" body="This panel doesn't exist." />;
  } else if (failed) {
    body = <EmptyState icon="circle-alert" title="This panel couldn't start" body={failed} />;
  } else if (bridge === "lost") {
    body = (
      <div className={styles.notice}>
        <Banner tone="warn" title={`The ${hostName} window closed this panel's project`}>
          Bring it back, or open the project again in {hostName}.
        </Banner>
      </div>
    );
  } else if (!connected || (bridge === "connecting" && !waited)) {
    body = <div className={styles.waiting}>Connecting…</div>;
  } else if (bridge === "connecting") {
    body = (
      <EmptyState
        icon="app-window"
        title={`Open ${hostName} in the main window first`}
        body="This panel shows a project that's open there."
        action={<Button onClick={() => focusWindow("main").catch(() => undefined)}>Show main window</Button>}
      />
    );
  } else {
    const Part = spec.component;
    body = (
      <ErrorBoundary label={spec.title} resetKey={part}>
        <Suspense fallback={null}>
          <Part placement="window" />
        </Suspense>
      </ErrorBoundary>
    );
  }

  return (
    <div className={styles.root}>
      <header className={styles.topbar}>
        <Icon name={heading?.icon ?? "app-window"} size={16} className={styles.icon} />
        <h1 className={styles.title}>{heading?.title ?? "Panel"}</h1>
        <span className={styles.spacer} />
        <Button size="sm" icon="app-window" data-tip="Close this window and show the panel in its tool again" onClick={bringBack}>
          Bring back
        </Button>
      </header>
      <main className={styles.view}>{body}</main>
      <Toaster />
      <TooltipLayer />
    </div>
  );
}
