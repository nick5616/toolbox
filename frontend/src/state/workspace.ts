import { Events } from "@wailsio/runtime";
import { create } from "zustand";
import { WorkspaceKind, WorkspacesService, type WorkspaceInfo, type WorkspacePresenter } from "@/lib/api";
import { toast } from "@/components/toast";
import { toAppError } from "@/lib/errors";
import { setCurrentPresenter } from "@/lib/pathRewrite";
import { useUI } from "./ui";

/** A switch the running app was asked to make (`--workspace X` from a second launch). */
export interface SwitchRequest {
  id: string;
  name: string;
}

export const WORKSPACE_SETTINGS_ANCHOR = "settings-workspaces";

export interface WorkspaceStore {
  loaded: boolean;
  current: WorkspaceInfo | null;
  list: WorkspaceInfo[];
  presenter: WorkspacePresenter | null;
  /** Set when a second launch asked for another workspace; the shell shows "Switch to <name>?". */
  switchRequest: SwitchRequest | null;
  /** A one-time boot message ("Demo's folder isn't there"), shown once then cleared. */
  notice: string;
  /** The chip/palette asked for the New workspace dialog; Settings → Workspaces opens it and clears this. */
  newRequested: boolean;
  setNewRequested: (v: boolean) => void;
  setAll: (current: WorkspaceInfo | null, list: WorkspaceInfo[], presenter: WorkspacePresenter | null) => void;
  requestSwitch: (r: SwitchRequest | null) => void;
  clearNotice: () => void;
  load: () => Promise<void>;
}

function fixInfo(i: WorkspaceInfo): WorkspaceInfo {
  return { ...i, keep: i.keep ?? [], exclude: i.exclude ?? [] };
}

/** A boot notice, if the backend exposes one on the info (the Go `Boot.Notice`). */
function noticeOf(i: WorkspaceInfo | null): string {
  const n = (i as (WorkspaceInfo & { notice?: unknown }) | null)?.notice;
  return typeof n === "string" ? n : "";
}

export const useWorkspace = create<WorkspaceStore>((set, get) => ({
  loaded: false,
  current: null,
  list: [],
  presenter: null,
  switchRequest: null,
  notice: "",
  newRequested: false,
  setNewRequested: (v) => set({ newRequested: v }),
  setAll: (current, list, presenter) =>
    set((s) => ({
      loaded: true,
      current: current ? fixInfo(current) : null,
      list: list.map(fixInfo),
      presenter,
      notice: s.notice || (!s.loaded ? noticeOf(current) : ""),
    })),
  requestSwitch: (r) => set({ switchRequest: r }),
  clearNotice: () => set({ notice: "" }),
  load: async () => {
    const [current, list, presenter] = await Promise.all([WorkspacesService.Current(), WorkspacesService.List(), WorkspacesService.Presenter()]);
    get().setAll(current, list ?? [], presenter);
  },
}));

// Keep the pure rewriter (used by lib/errors.ts) in step with the store, however it is set.
useWorkspace.subscribe((s) => setCurrentPresenter(s.presenter));

/** True for the Personal workspace (can't be renamed, removed or tidied). */
export function isPersonal(i: WorkspaceInfo | null | undefined): boolean {
  return i?.kind === WorkspaceKind.KindPersonal;
}

function payloadSwitch(data: unknown): SwitchRequest | null {
  if (typeof data === "string") return { id: data, name: data };
  if (typeof data !== "object" || data === null) return null;
  const o = data as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : typeof o.root === "string" ? o.root : "";
  if (!id) return null;
  const known = useWorkspace.getState().list.find((w) => w.id === id || w.root === id);
  return { id: known?.id ?? id, name: typeof o.name === "string" && o.name ? o.name : (known?.name ?? id) };
}

/** Subscribes to an event that may not be in the generated event map yet. */
function onLoose(name: string, cb: (data: unknown) => void): () => void {
  const on = Events.On as unknown as (n: string, c: (e: { data: unknown }) => void) => () => void;
  return on(name, (ev) => cb(ev.data));
}

let subscribers = 0;
let pending: Promise<void> = Promise.resolve();

/** Resolves when the first (or latest) load finished; never rejects. Boot awaits it so paths render rewritten. */
export function workspaceReady(): Promise<void> {
  return pending;
}
let teardown: Array<() => void> = [];

/**
 * Loads the workspace store and keeps it fresh (`workspace:changed`, `workspace:switch-request`).
 * Reference-counted; every window that shows paths calls it.
 */
export function subscribeWorkspace(): () => void {
  if (subscribers === 0) {
    teardown = [
      onLoose("workspace:changed", () => {
        void useWorkspace
          .getState()
          .load()
          .catch(() => undefined);
      }),
      onLoose("workspace:switch-request", (d) => {
        const r = payloadSwitch(d);
        if (r) useWorkspace.getState().requestSwitch(r);
      }),
    ];
  }
  subscribers++;
  pending = useWorkspace
    .getState()
    .load()
    .catch(() => undefined);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    subscribers--;
    if (subscribers === 0) {
      for (const u of teardown) u();
      teardown = [];
    }
  };
}

/** Opens Settings → Workspaces with the New workspace dialog. */
export function openNewWorkspace(): void {
  useWorkspace.getState().setNewRequested(true);
  openWorkspaceSettings();
}

/** Opens Settings and scrolls to the Workspaces section. */
export function openWorkspaceSettings(): void {
  useUI.getState().navigate("settings");
  let tries = 0;
  const tick = () => {
    const el = document.getElementById(WORKSPACE_SETTINGS_ANCHOR);
    if (el) el.scrollIntoView?.({ block: "start" });
    else if (++tries < 20) setTimeout(tick, 50);
  };
  setTimeout(tick, 0);
}

/** Relaunches into another workspace; failures (including the `wails3 dev` explanation) become a toast. */
export async function switchTo(id: string): Promise<boolean> {
  try {
    await WorkspacesService.Switch(id);
    return true;
  } catch (e) {
    const err = toAppError(e);
    toast({ tone: "danger", title: err.message, description: err.hint });
    return false;
  }
}

/** The colour dot of a workspace in the chip and lists: Personal (and the sandbox, which has a badge) has none. */
export function workspaceDot(i: WorkspaceInfo | null | undefined): "accent" | "ok" | null {
  if (!i) return null;
  if (i.kind === WorkspaceKind.KindDemo) return "accent";
  if (i.kind === WorkspaceKind.KindStandard) return "ok";
  return null;
}

/** The icon for a workspace kind (all registered in components/Icon.tsx). */
export function workspaceIcon(i: WorkspaceInfo | null | undefined): string {
  if (!i) return "layers";
  if (i.kind === WorkspaceKind.KindDemo) return "presentation";
  if (i.kind === WorkspaceKind.KindSandbox) return "flask-conical";
  return "layers";
}
