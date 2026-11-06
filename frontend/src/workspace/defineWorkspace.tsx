/**
 * defineWorkspace (Phase 11, SPEC §3.2): registers a tool's panel and preview
 * parts and returns the hooks its view needs. Call it at module load in
 * `tools/<id>/workspace.ts(x)` and import that file from `parts/index.ts`, so
 * part windows (which never mount the tool view) know the parts too.
 */
import { useEffect, type ReactNode } from "react";
import { useStore } from "zustand";
import { EmptyState, ErrorBoundary } from "@/components";
import { currentWindow } from "@/lib/windows";
import { definePart } from "@/parts/registry";
import type { PartProps } from "@/parts/types";
import { hostBridge, replicaBridge, useBridgesStatus, useBridgeStatus, type BridgeSpec, type BridgeTransport } from "@/state/bridge";
import type { StoreApi } from "zustand";
import type { ExtraBridge, ToolPanel, Workspace, WorkspaceSpec } from "./types";
import styles from "./workspace.module.css";

const workspaces = new Map<string, Workspace>();

/** Test hook: bridge transports per side ("host" | "replica") instead of the window relay. */
let testTransport: ((side: "host" | "replica", name: string) => BridgeTransport) | null = null;
export function setWorkspaceTransportForTest(t: ((side: "host" | "replica", name: string) => BridgeTransport) | null): void {
  testTransport = t;
}

/** A store and its bridge spec as an extra channel of a workspace. */
export function bridgeOf<S, V extends Record<string, unknown>>(store: StoreApi<S>, spec: BridgeSpec<S, V>): ExtraBridge {
  return {
    name: spec.name,
    host: (transport) => hostBridge(store, spec, transport),
    replica: (transport) => replicaBridge(store, spec, transport ? { transport } : {}),
  };
}

/** The workspace a tool defined, if any. */
export function getWorkspace(moduleId: string): Workspace | undefined {
  return workspaces.get(moduleId);
}

export function defineWorkspace<S, V extends Record<string, unknown>>(spec: WorkspaceSpec<S, V>): Workspace {
  const bridgeName = spec.bridgeName ?? `ws:${spec.moduleId}`;
  const bridge: BridgeSpec<S, V> = { name: bridgeName, ...spec.bridge };
  const panelPart = `${spec.moduleId}.panel`;
  const previewPart = spec.preview ? `${spec.moduleId}.preview` : "";
  const byId = new Map<string, ToolPanel>(spec.panels.map((p) => [p.id, p]));
  let replica = false;

  const extras = spec.extraBridges ?? [];

  const connect = (): Promise<() => void> => {
    replica = true;
    const disposeAll = [
      replicaBridge(spec.store, bridge, testTransport ? { transport: testTransport("replica", bridgeName) } : {}),
      ...extras.map((x) => x.replica(testTransport?.("replica", x.name))),
      ...(spec.onConnect ? [spec.onConnect()] : []),
    ];
    return Promise.resolve(() => {
      for (const d of disposeAll) d();
      replica = false;
    });
  };

  /** A part window renders once its replicas are live and it has an open document. */
  function useReady(): boolean {
    const one = useBridgeStatus(bridgeName);
    const all = useBridgesStatus();
    const status = extras.length > 0 ? all : one;
    const open = useStore(spec.store, spec.isOpen);
    return status === "live" && open;
  }

  function ReplicaHooks() {
    spec.useReplica?.();
    return null;
  }

  function Wrap({ children }: { children: ReactNode }) {
    const W = spec.wrap;
    return W ? <W>{children}</W> : <>{children}</>;
  }

  function PanelWindow(_p: PartProps) {
    const ready = useReady();
    const id = currentWindow().params.get("panel") ?? "";
    const panel = byId.get(id);
    if (!panel) return <EmptyState icon="circle-alert" title="Nothing to show here" body="This panel doesn't exist." />;
    if (!ready) return <div className={styles.waiting}>Connecting…</div>;
    const Panel = panel.component;
    return (
      <Wrap>
        <div className={styles.panelWindow}>
          <ReplicaHooks />
          <ErrorBoundary label={panel.title} resetKey={id}>
            <Panel />
          </ErrorBoundary>
        </div>
      </Wrap>
    );
  }

  function PreviewWindow(_p: PartProps) {
    const ready = useReady();
    if (!spec.preview) return null;
    if (!ready) return <div className={styles.waiting}>Connecting…</div>;
    const Preview = spec.preview.component;
    return (
      <Wrap>
        <div className={styles.previewWindow}>
          <ReplicaHooks />
          <ErrorBoundary label={spec.preview.title ?? "Preview"}>
            <Preview />
          </ErrorBoundary>
        </div>
      </Wrap>
    );
  }

  definePart({
    id: panelPart,
    host: spec.moduleId,
    title: "Panel",
    icon: "panel-right",
    tip: spec.panelTip ?? "A panel of this tool in its own window",
    width: 380,
    height: 720,
    headingFor: (params) => {
      const p = byId.get(params.get("panel") ?? "");
      return p ? { title: p.title, icon: p.icon } : null;
    },
    component: PanelWindow,
    connect,
  });
  if (spec.preview) {
    definePart({
      id: previewPart,
      host: spec.moduleId,
      title: spec.preview.title ?? "Preview",
      icon: spec.preview.icon ?? "monitor-play",
      tip: spec.preview.tip ?? "The live preview in its own window",
      width: spec.preview.width ?? 960,
      height: spec.preview.height ?? 600,
      component: PreviewWindow,
      connect,
    });
  }

  const isReplica = (): boolean => replica || (currentWindow().kind === "part" && currentWindow().part.startsWith(`${spec.moduleId}.`));

  function useHost(): void {
    const open = useStore(spec.store, spec.isHosting ?? spec.isOpen);
    useEffect(() => {
      if (!open || isReplica()) return;
      const stops = [hostBridge(spec.store, bridge, testTransport?.("host", bridgeName)), ...extras.map((x) => x.host(testTransport?.("host", x.name)))];
      return () => {
        for (const stop of stops) stop();
      };
    }, [open]);
  }

  const ws: Workspace = {
    moduleId: spec.moduleId,
    panelPart,
    previewPart,
    previewMirror: !!spec.preview?.mirror,
    bridgeName,
    panels: spec.panels,
    getPanel: (id) => byId.get(id),
    isReplica,
    useHost,
  };
  workspaces.set(spec.moduleId, ws);
  return ws;
}
