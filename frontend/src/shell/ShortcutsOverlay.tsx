import { useMemo } from "react";
import { Kbd } from "@/components";
import { useCommandRegistry } from "@/lib/commands";
import { useShortcut } from "@/lib/shortcuts";
import { useUI } from "@/state/ui";
import { ADD_FILES_COMMAND } from "./useShellShortcuts";
import styles from "./ShortcutsOverlay.module.css";

interface Row {
  id: string;
  label: string;
  combo: string;
}

/** Shortcuts the shell binds itself (not in the command registry). */
export const GLOBAL_SHORTCUTS: Row[] = [
  { id: "palette", label: "Search tools, actions and files", combo: "Mod+K" },
  { id: "add", label: "Add files in the current tool", combo: "Mod+O" },
  { id: "digits", label: "Open pinned tools 1 to 9 (the digits show in the sidebar tooltips)", combo: "Mod+1" },
  { id: "library", label: "Library", combo: "Mod+L" },
  { id: "settings", label: "Settings", combo: "Mod+," },
  { id: "keys", label: "This list", combo: "?" },
];

/** Splits registry shortcuts into the shell's and the current tool's. */
export function shortcutRows(commands: Record<string, { id: string; title: string; shortcut?: string; enabled?: () => boolean }>): { global: Row[]; tool: Row[] } {
  const global = [...GLOBAL_SHORTCUTS];
  const tool: Row[] = [];
  const have = new Set(global.map((g) => g.combo));
  for (const c of Object.values(commands)) {
    if (!c.shortcut || c.id === ADD_FILES_COMMAND || (c.enabled && !c.enabled())) continue;
    const row = { id: c.id, label: c.title, combo: c.shortcut };
    if (c.id.startsWith("shell.")) {
      if (!have.has(c.shortcut)) global.push(row);
    } else {
      tool.push(row);
    }
  }
  return { global, tool };
}

/** The "Keyboard shortcuts" overlay: `?` or the palette entry opens it, Esc closes it. */
export function ShortcutsOverlay() {
  const open = useUI((s) => s.shortcutsOpen);
  const close = () => useUI.getState().setShortcutsOpen(false);
  const commands = useCommandRegistry((s) => s.commands);
  useShortcut("Escape", close, { when: open, allowInInputs: true });
  const { global, tool } = useMemo(() => shortcutRows(commands), [commands]);
  if (!open) return null;
  const group = (title: string, rows: Row[]) =>
    rows.length === 0 ? null : (
      <section className={styles.group} aria-label={title}>
        <h3 className={styles.heading}>{title}</h3>
        <ul className={styles.list}>
          {rows.map((r) => (
            <li key={r.id} className={styles.row}>
              <span className={styles.label}>{r.label}</span>
              {r.id === "digits" ? <Kbd combo="Mod+1" /> : <Kbd combo={r.combo} />}
              {r.id === "digits" && <span className={styles.to}>to</span>}
              {r.id === "digits" && <Kbd combo="Mod+9" />}
            </li>
          ))}
        </ul>
      </section>
    );
  return (
    <div className={styles.backdrop} onMouseDown={close}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className={styles.title}>Keyboard shortcuts</h2>
        <div className={styles.body}>
          {group("Everywhere", global)}
          {group("In this tool", tool)}
          {tool.length === 0 && <p className={styles.none}>This tool has no shortcuts of its own.</p>}
        </div>
      </div>
    </div>
  );
}
