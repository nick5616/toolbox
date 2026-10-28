import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button, EmptyState, Kbd, Spinner, TextField, toast } from "@/components";
import { ClipboardService, DesktopService } from "@/lib/api";
import { on } from "@/lib/events";
import { toAppError } from "@/lib/errors";
import { useSettings } from "@/state/settings";
import { ClipRow } from "./ClipRow";
import { useClipList } from "./useClipList";
import { useSelection } from "./useSelection";
import styles from "./ClipboardPopup.module.css";

const LIMIT = 50;

/**
 * Hotkey popup (440x560, frameless). Keyboard-first: type to filter, arrows +
 * Enter (or a number key) copy the item and hide the window. Picking an item
 * only copies it; the app never pastes into other apps.
 */
export default function ClipboardPopup() {
  const enabled = useSettings((s) => s.settings.clipboard.enabled);
  const [search, setSearch] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);

  const list = useClipList({ search, kind: "all", limit: LIMIT, debounceMs: 120 });
  const { items, refresh } = list;
  const sel = useSelection(items);
  const { reset } = sel;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(
    () =>
      on("window:show", () => {
        setSearch("");
        reset();
        setNow(Date.now());
        refresh();
        inputRef.current?.focus();
      }),
    [reset, refresh],
  );

  const hide = useCallback(() => {
    DesktopService.HidePopup().catch(() => undefined);
  }, []);

  const pick = useCallback(
    async (id: string) => {
      try {
        await ClipboardService.Copy(id);
      } catch (e) {
        toast({ title: "Couldn't copy", description: toAppError(e).message, tone: "danger" });
        return;
      }
      hide();
    },
    [hide],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      sel.move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (sel.selected) void pick(sel.selected.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      hide();
    } else if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
      // Digits pick an item while the search box is empty; Alt+digit always does.
      if (e.altKey || search === "") {
        const item = items[Number(e.key) - 1];
        e.preventDefault();
        if (item) void pick(item.id);
      }
    } else if (/^Digit[1-9]$/.test(e.code) && e.altKey) {
      // Alt can change e.key on some layouts (macOS); fall back to the physical key.
      const item = items[Number(e.code.slice(5)) - 1];
      e.preventDefault();
      if (item) void pick(item.id);
    }
  };

  const showOff = !enabled && items.length === 0 && !list.loading;
  const showEmpty = enabled && items.length === 0 && !list.loading && search.trim() === "";
  const noMatches = items.length === 0 && !list.loading && search.trim() !== "";

  return (
    <div className={styles.root} onKeyDown={onKeyDown}>
      <div className={styles.searchRow}>
        <TextField
          ref={inputRef}
          autoFocus
          icon="search"
          placeholder="Search clipboard history"
          aria-label="Search clipboard history"
          aria-controls="clip-popup-list"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {showOff ? (
        <EmptyState
          className={styles.empty}
          icon="clipboard"
          title="Clipboard history is off — enable it in Toolbox"
          action={
            <Button variant="primary" size="sm" onClick={() => void DesktopService.ShowMain("clipboard")}>
              Open Toolbox
            </Button>
          }
        />
      ) : showEmpty ? (
        <EmptyState className={styles.empty} icon="clipboard" title="Nothing copied yet" body="Things you copy will show up here." />
      ) : (
        <div
          id="clip-popup-list"
          className={styles.list}
          role="listbox"
          aria-label="Clipboard items"
          aria-activedescendant={sel.selected ? `clip-${sel.selected.id}` : undefined}
        >
          {items.map((item, i) => (
            <ClipRow
              key={item.id}
              item={item}
              domId={`clip-${item.id}`}
              compact
              index={i < 9 ? i + 1 : undefined}
              selected={item.id === sel.selectedId}
              now={now}
              onSelect={sel.setSelectedId}
              onActivate={(id) => void pick(id)}
            />
          ))}
          {list.loading && items.length === 0 && (
            <div className={styles.note}>
              <Spinner size={14} label="Loading" />
            </div>
          )}
          {noMatches && <div className={styles.note}>No matching items.</div>}
        </div>
      )}

      <footer className={styles.footer} aria-hidden="true">
        <span>
          <Kbd combo="ArrowUp" /> <Kbd combo="ArrowDown" /> navigate
        </span>
        <span>
          <Kbd combo="Enter" /> copy
        </span>
        <span>
          <Kbd combo="Escape" /> close
        </span>
      </footer>
    </div>
  );
}
