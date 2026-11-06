/**
 * Pop-out windows (Phase 10, SPEC.md §4). FOUNDATION CONTRACT: the exported
 * names and types are final; WP-W1 may add helpers.
 *
 * Every window is its own JS context loading the same page:
 * - the main window: no `window` query parameter;
 * - a tool window: `/?window=tool&view=<moduleId>&key=tool:<moduleId>`;
 * - a part window: `/?window=part&part=<partId>&key=part:<partId>[@<instance>]` (+ part params);
 * - the clipboard popup (`window=popup`) and VizLab (`window=vizlab`) are older kinds.
 * Windows talk only through Go (`DesktopService.Relay` → `windows:relay`), never sockets.
 */
import { DesktopService, type PopOutRequest } from "@/lib/api";
import { on } from "@/lib/events";

export type WindowKind = "main" | "tool" | "part" | "popup" | "vizlab";

export interface WindowIdentity {
  kind: WindowKind;
  /** "main" for the main window, else the pop-out's key ("tool:edit-studio", "part:edit-studio.preview@1"); "" for popup/vizlab. */
  key: string;
  /** tool windows: the module id; part windows: the host tool's view from `view=` if given. */
  view: string;
  /** part windows: the part id. */
  part: string;
  /** All query parameters (parts read their own, e.g. `project=`). */
  params: URLSearchParams;
}

/** Parses a window's identity from its query string. */
export function parseWindow(search: string): WindowIdentity {
  const q = new URLSearchParams(search);
  const w = q.get("window");
  const kind: WindowKind = w === "tool" || w === "part" || w === "popup" || w === "vizlab" ? w : "main";
  const key = kind === "main" ? "main" : kind === "tool" || kind === "part" ? (q.get("key") ?? "") : "";
  return { kind, key, view: q.get("view") ?? "", part: q.get("part") ?? "", params: q };
}

let identity: WindowIdentity | null = null;

/** This window's identity (parsed once). */
export function currentWindow(): WindowIdentity {
  if (!identity) identity = parseWindow(typeof window === "undefined" ? "" : window.location.search);
  return identity;
}

/** Test hook: override the identity. */
export function setCurrentWindowForTest(w: WindowIdentity | null): void {
  identity = w;
}

/** Window key of a whole tool popped out. */
export const toolWindowKey = (moduleId: string): string => `tool:${moduleId}`;

/** Window key of a part (optionally one of several instances). */
export const partWindowKey = (partId: string, instance?: string): string => (instance ? `part:${partId}@${instance}` : `part:${partId}`);

export interface PopOutOptions {
  title?: string;
  width?: number;
  height?: number;
  /** Extra query parameters for the window (strings only; URL-encoded by this helper). */
  params?: Record<string, string>;
  /** A handoff the new window takes once at start (see state/ui Handoff). */
  handoff?: unknown;
}

function query(base: Record<string, string>, extra?: Record<string, string>): string {
  const q = new URLSearchParams({ ...base, ...(extra ?? {}) });
  return q.toString();
}

/** Opens (or focuses) a whole tool in its own window. */
export function popOutTool(moduleId: string, o: PopOutOptions = {}): Promise<void> {
  const req: PopOutRequest = {
    key: toolWindowKey(moduleId),
    title: o.title ?? "",
    query: query({ window: "tool", view: moduleId }, o.params),
    width: o.width ?? 0,
    height: o.height ?? 0,
    handoff: o.handoff === undefined ? "" : JSON.stringify(o.handoff),
  };
  return DesktopService.PopOut(req);
}

/** Opens (or focuses) a part in its own window. */
export function popOutPart(partId: string, o: PopOutOptions & { instance?: string } = {}): Promise<void> {
  const req: PopOutRequest = {
    key: partWindowKey(partId, o.instance),
    title: o.title ?? "",
    query: query({ window: "part", part: partId }, o.params),
    width: o.width ?? 0,
    height: o.height ?? 0,
    handoff: o.handoff === undefined ? "" : JSON.stringify(o.handoff),
  };
  return DesktopService.PopOut(req);
}

export function closeWindow(key: string): Promise<void> {
  return DesktopService.CloseWindow(key);
}

/** Shows and focuses a window ("main" or a pop-out key). */
export function focusWindow(key: string): Promise<void> {
  return DesktopService.FocusWindow(key);
}

/** Takes the handoff waiting for this window (parsed JSON), or null. */
export async function takeWindowHandoff(): Promise<unknown> {
  const key = currentWindow().key;
  if (!key || key === "main") return null;
  const raw = await DesktopService.TakeHandoff(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** A message between windows. */
export interface RelayMessage<T = unknown> {
  channel: string;
  from: string;
  to: string;
  payload: T;
}

/** Sends a message to every window (or one, with `to`) on a channel. The sender ignores its own messages. */
export function relaySend(channel: string, payload: unknown, to = ""): Promise<void> {
  return DesktopService.Relay({ channel, from: currentWindow().key || "main", to, payload: JSON.stringify(payload) });
}

/** Receives messages on a channel addressed to this window (or to all), excluding its own. */
export function relayOn<T = unknown>(channel: string, cb: (m: RelayMessage<T>) => void): () => void {
  return on("windows:relay", (r) => {
    const me = currentWindow().key || "main";
    if (r.channel !== channel || r.from === me) return;
    if (r.to && r.to !== me) return;
    let payload: T;
    try {
      payload = JSON.parse(r.payload) as T;
    } catch {
      return;
    }
    cb({ channel: r.channel, from: r.from, to: r.to, payload });
  });
}
