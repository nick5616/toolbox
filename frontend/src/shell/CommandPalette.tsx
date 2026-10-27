import { useEffect, useMemo, useRef, useState } from "react";
import { LibraryService } from "@/lib/api";
import { useCommandRegistry, type Command } from "@/lib/commands";
import { toAppError } from "@/lib/errors";
import { fuzzyScore } from "@/lib/fuzzy";
import { useShortcut } from "@/lib/shortcuts";
import { Icon, Kbd, toast, cx } from "@/components";
import { useRecentOutputs } from "@/state/library";
import { useUI } from "@/state/ui";
import { RECENT_ITEM, SETTINGS_ITEM, useVisibleModules } from "./nav";
import styles from "./CommandPalette.module.css";

const MAX_RESULTS = 50;
const SECTION_ORDER = ["Navigate", "Actions", "Recent outputs"];

interface Entry {
  key: string;
  section: string;
  title: string;
  icon: string;
  shortcut?: string;
  score: number;
  indices: number[];
  run: () => void;
  alt?: () => void;
}

function fail(e: unknown): void {
  toast({ tone: "danger", title: toAppError(e).message });
}

function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const set = new Set(indices);
  const out: React.ReactNode[] = [];
  let buf = "";
  let marked = false;
  const flush = () => {
    if (!buf) return;
    out.push(marked ? <mark key={out.length}>{buf}</mark> : buf);
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m !== marked) {
      flush();
      marked = m;
    }
    buf += text.charAt(i);
  }
  flush();
  return <>{out}</>;
}

export function CommandPalette() {
  const open = useUI((s) => s.paletteOpen);
  const setOpen = useUI((s) => s.setPaletteOpen);
  useShortcut("Mod+K", () => setOpen(!useUI.getState().paletteOpen), { allowInInputs: true });
  useShortcut("Escape", () => setOpen(false), { when: open, allowInInputs: true });
  return open ? <PaletteDialog onClose={() => setOpen(false)} /> : null;
}

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const modules = useVisibleModules();
  const commands = useCommandRegistry((s) => s.commands);
  const outputs = useRecentOutputs(undefined, 200);

  const entries = useMemo<Entry[]>(() => {
    const navigate = useUI.getState().navigate;
    const all: Omit<Entry, "score" | "indices">[] = [];
    const nav = (id: string, title: string, icon: string) =>
      all.push({ key: `nav:${id}`, section: "Navigate", title, icon, run: () => navigate(id) });
    nav(RECENT_ITEM.id, "Recent", RECENT_ITEM.icon);
    for (const m of modules) nav(m.id, m.name, m.icon);
    nav(SETTINGS_ITEM.id, "Settings", SETTINGS_ITEM.icon);
    if (import.meta.env.DEV) nav("gallery", "Component gallery", "box");

    const enabled: Command[] = Object.values(commands).filter((c) => c.enabled?.() ?? true);
    for (const c of enabled) {
      all.push({
        key: `cmd:${c.id}`,
        section: c.section || "Actions",
        title: c.title,
        icon: c.icon ?? "command",
        shortcut: c.shortcut,
        run: () => {
          Promise.resolve()
            .then(() => c.run())
            .catch(fail);
        },
      });
    }

    const scored: Entry[] = [];
    for (const e of all) {
      const kw = commands[e.key.slice(4)]?.keywords ?? [];
      const m = fuzzyScore(query, e.title);
      if (m) {
        scored.push({ ...e, ...m });
        continue;
      }
      if (query && e.key.startsWith("cmd:")) {
        const k = kw.map((w) => fuzzyScore(query, w)).find((r) => r !== null);
        if (k) scored.push({ ...e, score: k.score - 20, indices: [] });
      }
    }
    // Keep registration order for an empty query; rank by score otherwise.
    const rank = (s: string) => {
      const i = SECTION_ORDER.indexOf(s);
      return i < 0 ? 1 : i;
    };
    if (query) scored.sort((a, b) => rank(a.section) - rank(b.section) || b.score - a.score);
    else scored.sort((a, b) => rank(a.section) - rank(b.section));

    const outEntries: Entry[] = [];
    for (const o of outputs) {
      const m = fuzzyScore(query, o.name);
      if (!m || (!query && outEntries.length >= 5)) continue;
      outEntries.push({
        key: `out:${o.id}`,
        section: "Recent outputs",
        title: o.name,
        icon: o.kind === "audio" ? "music" : o.kind === "video" ? "film" : "file",
        score: m.score,
        indices: m.indices,
        run: () => {
          LibraryService.Open(o.id).catch(fail);
        },
        alt: () => {
          LibraryService.Reveal(o.id).catch(fail);
        },
      });
    }
    outEntries.sort((a, b) => b.score - a.score);
    return scored.concat(outEntries.slice(0, 5)).slice(0, MAX_RESULTS);
  }, [query, modules, commands, outputs]);

  const active = Math.min(cursor, Math.max(0, entries.length - 1));

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active, entries]);

  const choose = (e: Entry | undefined, alt: boolean) => {
    if (!e) return;
    onClose();
    if (alt) e.alt?.();
    else e.run();
  };

  const onKeyDown = (ev: React.KeyboardEvent) => {
    const n = entries.length;
    if (ev.key === "ArrowDown" || (ev.ctrlKey && ev.key.toLowerCase() === "n")) {
      ev.preventDefault();
      setCursor(n ? (active + 1) % n : 0);
    } else if (ev.key === "ArrowUp" || (ev.ctrlKey && ev.key.toLowerCase() === "p")) {
      ev.preventDefault();
      setCursor(n ? (active - 1 + n) % n : 0);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      choose(entries[active], ev.metaKey || ev.ctrlKey);
    }
  };

  let lastSection = "";
  return (
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={styles.inputRow}>
          <Icon name="search" size={16} />
          <input
            autoFocus
            className={styles.input}
            placeholder="Search tools, actions, files…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-label="Search commands"
          />
        </div>
        <div className={styles.list} ref={listRef} id="palette-list" role="listbox">
          {entries.length === 0 && <div className={styles.empty}>No results</div>}
          {entries.map((e, i) => {
            const header = e.section !== lastSection ? e.section : null;
            lastSection = e.section;
            return (
              <div key={e.key}>
                {header && <div className={styles.group}>{header}</div>}
                <div
                  role="option"
                  aria-selected={i === active}
                  className={cx(styles.item, i === active && styles.selected)}
                  onMouseMove={() => i !== active && setCursor(i)}
                  onClick={(ev) => choose(e, ev.metaKey || ev.ctrlKey)}
                >
                  <Icon name={e.icon} size={16} />
                  <span className={styles.title}>
                    <Highlighted text={e.title} indices={e.indices} />
                  </span>
                  {e.shortcut && <Kbd combo={e.shortcut} />}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
