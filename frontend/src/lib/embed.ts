/**
 * Tools inside tools (Phase 11, SPEC §4). A composite tool opens one of its
 * constituents *inside itself*: the constituent's own view renders in a
 * click-in drawer of the host (<ToolClickIn>), preloaded with the host's
 * files, and can pop out into its own window. Results come back through
 * "Use" (`onUse`) — a cut-out replaces the layer, a cleaned clip replaces the
 * clip — so outputs feed inputs without leaving the host.
 *
 * A tool view doesn't know where it is rendered except through this context:
 * - `useToolHandoff(moduleId, cb)` replaces `useUI().takeHandoff` everywhere:
 *   embedded, it delivers the embed's handoff (once per handoff object) and
 *   never consumes the global one; standalone, it behaves as before.
 * - `useEmbed()` tells the kit to render compactly (no tagline, click-ins
 *   inline) and gives result rows a "Use" button.
 * - In a tool window opened from a click-in, the shell provides the context
 *   from the handoff's `embed` link and `onUse` relays the files back.
 */
import { createContext, useContext, useEffect, useRef } from "react";
import type { EmbedLink, Handoff } from "@/state/ui";
import { useUI } from "@/state/ui";
import { currentWindow, relayOn, relaySend } from "./windows";

export interface EmbedContextValue {
  /** The host tool's module id and name. */
  host: string;
  hostName: string;
  /** Inside the host's drawer, or in a tool window popped out of it. */
  placement: "drawer" | "window";
  /** The handoff this embed starts with. A new object is a new handoff. */
  handoff: Handoff;
  /** Label of the Use button ("Use as layer"); only with `onUse`. */
  useLabel: string;
  /** Returns result files to the host. Absent: the embed only shows results. */
  onUse?: (paths: string[]) => void;
}

export const EmbedContext = createContext<EmbedContextValue | null>(null);

/** The embed this view is rendered in, or null when it's a normal tool view. */
export function useEmbed(): EmbedContextValue | null {
  return useContext(EmbedContext);
}

/** True when this tool view is rendered inside another tool (drawer or window). */
export function useIsEmbedded(): boolean {
  return useContext(EmbedContext) !== null;
}

/**
 * Delivers a tool's input handoffs. Embedded: the embed's handoff, once per
 * handoff object (the global handoff is left alone). Standalone: takes
 * `useUI`'s handoff for `moduleId` whenever one arrives (the behaviour of
 * every tool before Phase 11).
 */
export function useToolHandoff(moduleId: string, onHandoff: (h: Handoff) => void): void {
  const embed = useContext(EmbedContext);
  const cb = useRef(onHandoff);
  cb.current = onHandoff;
  const delivered = useRef<Handoff | null>(null);
  const embedded = embed?.handoff ?? null;
  useEffect(() => {
    if (!embedded || embedded.moduleId !== moduleId || delivered.current === embedded) return;
    delivered.current = embedded;
    cb.current(embedded);
  }, [embedded, moduleId]);
  const global = useUI((s) => s.handoff);
  const isEmbedded = embed !== null;
  useEffect(() => {
    if (isEmbedded || global?.moduleId !== moduleId) return;
    const h = useUI.getState().takeHandoff(moduleId);
    if (h) cb.current(h);
  }, [global, moduleId, isEmbedded]);
}

/** The relay channel results travel on from a popped-out embed to its host. */
export const EMBED_CHANNEL = "embed";

interface EmbedUse {
  token: string;
  paths: string[];
}

/** Tool window side: sends "Use" results back to the click-in that opened it. */
export function sendEmbedUse(link: EmbedLink, paths: string[]): Promise<void> {
  const msg: EmbedUse = { token: link.token, paths };
  return relaySend(EMBED_CHANNEL, msg, link.hostWindow);
}

/** Host side: receives results for one click-in's token. Returns unsubscribe. */
export function onEmbedUse(token: string, cb: (paths: string[]) => void): () => void {
  return relayOn<EmbedUse>(EMBED_CHANNEL, (m) => {
    if (m.payload.token === token && Array.isArray(m.payload.paths)) cb(m.payload.paths.filter((p): p is string => typeof p === "string"));
  });
}

/** A fresh link for a click-in about to pop its tool out. */
export function newEmbedLink(host: string, hostName: string, useLabel: string): EmbedLink {
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return { token, host, hostName, hostWindow: currentWindow().key || "main", useLabel };
}
