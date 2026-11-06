/**
 * Workspaces (Phase 11, SPEC §3): the editor's pattern, extracted so every
 * tool that is a workspace (Photo Composer, Post Builder, Subtitles, Lyric
 * Video, Visualizer, Pipelines, …) gets the same three things:
 *
 * 1. **Panels**: each constituent surface is a component that takes no props
 *    and reads the tool's zustand store, so it renders the same in a click-in
 *    drawer and popped out in its own window (part `<moduleId>.panel`).
 * 2. **A preview part**: the tool's live preview can pop out (part
 *    `<moduleId>.preview`), e.g. onto a second screen.
 * 3. **A store bridge**: while a document is open, the tool's window hosts
 *    its store; part windows hold replicas whose listed actions run on the host.
 */
import type { ComponentType, ReactNode } from "react";
import type { StoreApi } from "zustand";
import type { BridgeSpec, BridgeTransport } from "@/state/bridge";

export interface ToolPanel {
  /** [a-z0-9-], unique within the tool ("layers", "cues"). */
  id: string;
  title: string;
  /** A shorter caption for the rail (≤ 10 characters), when the title doesn't fit under an icon. */
  short?: string;
  /** lucide icon name (registered in components/Icon.tsx). */
  icon: string;
  /** One line for the launcher tooltip. */
  tip: string;
  /** Takes no props: reads the tool's store (and may call its actions). */
  component: ComponentType;
  /** Drawer width in px (default 380). */
  drawerWidth?: number;
  /** Pop-out window size (default 380 × 720). */
  width?: number;
  height?: number;
  /** false: the panel only makes sense inline (no Pop out button). Default true. */
  poppable?: boolean;
}

export interface WorkspacePreview {
  title?: string;
  icon?: string;
  tip?: string;
  /** Pop-out window size (default 960 × 600). */
  width?: number;
  height?: number;
  /** Renders the preview from the (replica) store. Takes no props. */
  component: ComponentType;
  /**
   * The popped-out preview is a read-only mirror and the tool's own stage is
   * where you edit: keep the stage in the main window while it's open.
   */
  mirror?: boolean;
}

/**
 * A second store mirrored on its own channel next to the main one (the
 * editor's focus store). Make one with `bridgeOf(store, spec)`.
 */
export interface ExtraBridge {
  name: string;
  host(transport?: BridgeTransport): () => void;
  replica(transport?: BridgeTransport): () => void;
}

export interface WorkspaceSpec<S, V extends Record<string, unknown>> {
  /** The tool (host) module id. */
  moduleId: string;
  /** The tool's zustand store (`create(...)` returns one). */
  store: StoreApi<S>;
  /** What's mirrored into part windows: JSON-serialisable values only. The channel is `ws:<moduleId>` unless `bridgeName` is set. */
  bridge: Omit<BridgeSpec<S, V>, "name">;
  bridgeName?: string;
  /** Whether a document is open: the host bridges only then, and a part window renders only then. */
  isOpen(state: S): boolean;
  /** Whether the host bridges (default `isOpen`): a window may host slightly before a replica can render. */
  isHosting?(state: S): boolean;
  /** More channels that are hosted and replicated together with the main one. */
  extraBridges?: readonly ExtraBridge[];
  /** Wraps what a part window renders (context providers the panels read). */
  wrap?: ComponentType<{ children: ReactNode }>;
  /** Called when a part window of this tool connects; returns its cleanup. */
  onConnect?(): () => void;
  /** The panel part's tooltip (default: "A panel of this tool in its own window"). */
  panelTip?: string;
  panels: readonly ToolPanel[];
  preview?: WorkspacePreview;
  /**
   * Runs inside part windows (panel and preview) once connected: load what the
   * replica needs locally (images, analyses: never bridged) and forward keys.
   */
  useReplica?(): void;
}

/** What `defineWorkspace` returns: the tool view uses it to host, lay out and launch its panels. */
export interface Workspace {
  moduleId: string;
  /** "<moduleId>.panel" (params `{panel}`). */
  panelPart: string;
  /** "<moduleId>.preview", or "" without a preview. */
  previewPart: string;
  /** The preview window is a read-only mirror: the tool keeps its own stage while it's open. */
  previewMirror: boolean;
  bridgeName: string;
  panels: readonly ToolPanel[];
  getPanel(id: string): ToolPanel | undefined;
  /** True in a part window of this tool (a replica never saves, submits jobs or loads documents). */
  isReplica(): boolean;
  /** Mount once in the tool view: hosts the store bridge while a document is open. */
  useHost(): void;
}
