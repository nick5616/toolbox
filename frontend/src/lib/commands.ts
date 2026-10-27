import { useEffect, useRef } from "react";
import { create } from "zustand";
import type { Combo } from "./shortcuts";

/** A command shown in the Cmd-K palette. */
export interface Command {
  /** Stable unique id, e.g. "nav.settings" or "downloader.focus-input". */
  id: string;
  title: string;
  /** Palette group heading, e.g. "Navigate" or "Actions". */
  section: string;
  keywords?: string[];
  /** Display-only shortcut hint; binding is done separately with useShortcut. */
  shortcut?: Combo;
  /** lucide icon name (see components/Icon). */
  icon?: string;
  /** Hidden from the palette when this returns false. */
  enabled?: () => boolean;
  run: () => void | Promise<void>;
}

interface CommandRegistry {
  commands: Record<string, Command>;
  add: (cmds: Command[]) => void;
  removeIds: (ids: string[]) => void;
}

export const useCommandRegistry = create<CommandRegistry>((set) => ({
  commands: {},
  add: (cmds) =>
    set((s) => {
      const next = { ...s.commands };
      for (const c of cmds) next[c.id] = c;
      return { commands: next };
    }),
  removeIds: (ids) =>
    set((s) => {
      const next = { ...s.commands };
      for (const id of ids) delete next[id];
      return { commands: next };
    }),
}));

/** Registers commands imperatively. Returns an unregister function. */
export function registerCommands(cmds: Command[]): () => void {
  useCommandRegistry.getState().add(cmds);
  return () => useCommandRegistry.getState().removeIds(cmds.map((c) => c.id));
}

/**
 * Registers commands while the calling component is mounted. `run` handlers
 * always see the latest closure; the command list is re-registered when the
 * ids, titles or `deps` change.
 */
export function useCommands(cmds: Command[], deps: readonly unknown[] = []): void {
  const latest = useRef(cmds);
  latest.current = cmds;
  const signature = cmds.map((c) => `${c.id}\u0000${c.title}`).join("\u0001");

  useEffect(() => {
    const stable = latest.current.map((c) => ({
      ...c,
      run: () => latest.current.find((x) => x.id === c.id)?.run(),
      enabled: c.enabled ? () => latest.current.find((x) => x.id === c.id)?.enabled?.() ?? true : undefined,
    }));
    return registerCommands(stable);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, ...deps]);
}

/** All currently enabled commands. */
export function enabledCommands(): Command[] {
  return Object.values(useCommandRegistry.getState().commands).filter((c) => c.enabled?.() ?? true);
}
