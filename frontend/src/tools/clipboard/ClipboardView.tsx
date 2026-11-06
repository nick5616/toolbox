import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  Badge,
  Button,
  ClickIn,
  ClickInHost,
  ConfirmDialog,
  EmptyState,
  Kbd,
  SegmentedControl,
  Spinner,
  TextField,
  ToolClickIn,
  toast,
  type BadgeTone,
} from "@/components";
import { ClipKind, ClipboardService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { acceleratorToCombo, isMac } from "@/lib/platform";
import { isEditableTarget, useShortcut } from "@/lib/shortcuts";
import { useCompositionInputs } from "@/state/composition";
import { useDesktop } from "@/state/desktop";
import { useSettings } from "@/state/settings";
import type { ToolViewProps } from "@/tools";
import { ClipRow } from "./ClipRow";
import { ClipboardSettingsPanel, clipboardSummary } from "./ClipboardSettingsPanel";
import { removeClips, upsertClip, type KindFilter } from "./clips";
import { useClipList } from "./useClipList";
import { useSelection } from "./useSelection";
import styles from "./ClipboardView.module.css";

const PAGE = 200;

const KINDS = [
  { value: "all", label: "All", tip: "Show text and images" },
  { value: "text", label: "Text", tip: "Show only copied text" },
  { value: "image", label: "Images", tip: "Show only copied images" },
] as const;

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function fail(title: string, e: unknown) {
  toast({ title, description: toAppError(e).message, tone: "danger" });
}

export default function ClipboardView({ moduleId }: ToolViewProps) {
  useCompositionInputs(moduleId, { "dev-utils": [] });
  const enabled = useSettings((s) => s.settings.clipboard.enabled);
  const clipSettings = useSettings((s) => s.settings.clipboard);
  const hotkey = useSettings((s) => s.settings.hotkeys?.clipboard ?? "");
  const update = useSettings((s) => s.update);
  const state = useDesktop((s) => s.clipboard);

  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [confirmClear, setConfirmClear] = useState(false);
  const [keepPinned, setKeepPinned] = useState(true);
  const [busy, setBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const now = useNow(60_000);

  const list = useClipList({ search, kind, limit: PAGE });
  const { items, patch } = list;
  const sel = useSelection(items);
  const filtering = search.trim() !== "" || kind !== "all";
  const hasHistory = items.length > 0 || filtering;
  // The selected text item can be opened in Dev Utilities (it stays on this computer).
  const textItem = sel.selected && sel.selected.kind === ClipKind.ClipText && sel.selected.text !== "" ? sel.selected : null;

  useShortcut("/", () => searchRef.current?.focus());

  const copy = useCallback(async (id: string) => {
    try {
      await ClipboardService.Copy(id);
      toast({ title: "Copied", tone: "success", duration: 1800 });
    } catch (e) {
      fail("Couldn't copy", e);
    }
  }, []);

  const pin = useCallback(
    async (id: string, pinned: boolean) => {
      try {
        const next = await ClipboardService.Pin(id, pinned);
        patch((cur) => upsertClip(cur, next));
      } catch (e) {
        fail(pinned ? "Couldn't pin" : "Couldn't unpin", e);
      }
    },
    [patch],
  );

  const remove = useCallback(
    async (id: string) => {
      const next = sel.neighbourOf(id);
      try {
        await ClipboardService.Delete([id]);
        patch((cur) => removeClips(cur, [id]));
        if (next) sel.setSelectedId(next);
      } catch (e) {
        fail("Couldn't delete", e);
      }
    },
    [patch, sel],
  );

  const setEnabled = async (value: boolean) => {
    setBusy(true);
    try {
      const cur = useSettings.getState().settings.clipboard;
      await update({ clipboard: { ...cur, enabled: value } });
      if (!value) toast({ title: "Clipboard history is off", description: "Existing history is kept." });
    } catch (e) {
      fail(value ? "Couldn't start recording" : "Couldn't turn off", e);
    } finally {
      setBusy(false);
    }
  };

  const togglePause = async () => {
    try {
      if (state.paused) await ClipboardService.Resume();
      else await ClipboardService.Pause();
      useDesktop.getState().setClipboardState(await ClipboardService.State());
    } catch (e) {
      fail("Couldn't change recording", e);
    }
  };

  const clear = async () => {
    setConfirmClear(false);
    try {
      const n = await ClipboardService.Clear(keepPinned);
      list.refresh();
      toast({ title: n === 1 ? "Cleared 1 item" : `Cleared ${n} items`, tone: "success" });
    } catch (e) {
      fail("Couldn't clear history", e);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("[role=\"dialog\"]")) return;
    const inInput = isEditableTarget(target);
    const inButton = target.closest("button") !== null;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      sel.move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter" && !inButton && sel.selected) {
      e.preventDefault();
      void copy(sel.selected.id);
    } else if (e.key === "Backspace" && (isMac ? e.metaKey : e.ctrlKey) && sel.selected) {
      const typing = target instanceof HTMLInputElement && target.value !== "";
      if (!typing) {
        e.preventDefault();
        void remove(sel.selected.id);
      }
    } else if ((e.key === "p" || e.key === "P") && !inInput && !e.metaKey && !e.ctrlKey && !e.altKey && sel.selected) {
      e.preventDefault();
      void pin(sel.selected.id, !sel.selected.pinned);
    } else if (e.key === "Escape" && target === searchRef.current) {
      if (search) setSearch("");
      listRef.current?.focus();
    }
  };

  const statusTone: BadgeTone = state.error ? "danger" : state.paused ? "warn" : state.recording ? "ok" : "neutral";
  const statusLabel = state.error ? "Error" : state.paused ? "Paused" : state.recording ? "Recording" : "Starting…";
  const combo = acceleratorToCombo(hotkey);

  return (
    <ClickInHost>
    <div className={styles.root} onKeyDown={onKeyDown}>
      <header className={styles.header}>
        {enabled && (
          <span className={styles.status} role="status">
            <Badge tone={statusTone} tip={state.error ? "Recording hit a problem; see the message" : state.paused ? "Copies are being ignored until you resume" : state.recording ? "Everything you copy is being saved to the history" : "Recording is getting ready"}>{statusLabel}</Badge>
            {state.error && <span className={styles.errorText}>{state.error}</span>}
          </span>
        )}
        {enabled && (
          <Button size="sm" variant="secondary" collapsible onClick={() => void togglePause()} icon={state.paused ? "play" : "pause"} data-tip={state.paused ? "Start saving what you copy again" : "Stop saving copies for now; existing history stays"}>
            {state.paused ? "Resume" : "Pause"}
          </Button>
        )}
        <span className={styles.spacer} />
        {enabled && (
          <Button
            size="sm"
            variant="secondary"
            icon="external-link"
            collapsible
            data-tip={combo ? `Open the small picker window that lists recent copies (${combo})` : "Open the small picker window that lists recent copies"}
            onClick={() => ClipboardService.OpenPopup().catch((e: unknown) => fail("Couldn't open popup", e))}
          >
            Open popup
          </Button>
        )}
        {enabled && (
          <span className={styles.hotkey} data-tip={combo ? "The global shortcut that opens the popup; change it in Settings" : "No global shortcut is set; choose one in Settings"}>
            {combo ? <Kbd combo={combo} /> : <span className={styles.noKey}>No shortcut</span>}
          </span>
        )}
        {hasHistory && (
          <Button size="sm" variant="secondary" icon="trash-2" collapsible data-tip="Delete saved items, optionally keeping the pinned ones" onClick={() => setConfirmClear(true)}>
            Clear…
          </Button>
        )}
        {enabled && (
          <ClickIn
            icon="settings"
            title="Clipboard settings"
            summary={clipboardSummary(clipSettings)}
            tip="Image capture, how long history is kept, auto-paste and the popup shortcut"
            className={styles.settingsRow}
            width={400}
          >
            <section className={styles.settings} aria-label="Clipboard settings">
              <ClipboardSettingsPanel />
              <div>
                <Button size="sm" variant="ghost" onClick={() => void setEnabled(false)} loading={busy} data-tip="Stop recording what you copy; existing history is kept">
                  Turn off recording
                </Button>
              </div>
            </section>
          </ClickIn>
        )}
      </header>

      {!enabled && (
        <EmptyState
          className={hasHistory ? styles.offCompact : styles.off}
          icon="clipboard"
          size={hasHistory ? "md" : "lg"}
          title="Clipboard history is off"
          body={
            <>
              Toolbox can keep a searchable history of the text and images you copy. It is stored only on this
              computer, in the app&apos;s database, with images saved as files in the app folder; nothing ever leaves
              this machine. Copies from password managers are skipped.
            </>
          }
          action={
            <Button variant="primary" onClick={() => void setEnabled(true)} loading={busy} data-tip="Start saving text and images you copy, on this computer only">
              Start recording clipboard history
            </Button>
          }
        />
      )}

      {(enabled || hasHistory) && (
        <>
          <div className={styles.toolbar}>
            <TextField
              ref={searchRef}
              wrapperClassName={styles.search}
              icon="search"
              placeholder="Search clipboard history"
              aria-label="Search clipboard history"
              data-tip="Search the text of copied items. Press / to focus"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              trailing={<Kbd combo="/" />}
            />
            <SegmentedControl aria-label="Filter by kind" value={kind} onChange={setKind} options={KINDS} />
            <ToolClickIn
              host={moduleId}
              module="dev-utils"
              variant="icon"
              icon="braces"
              title="Open in Dev Utilities"
              tip="Open the selected text in the matching developer utility: JSON, JWT, Base64, a URL, a timestamp or a colour"
              extra={textItem ? { text: { title: "Copied text", body: textItem.text } } : undefined}
              disabledReason={textItem ? undefined : "Select a copied text item first"}
            />
          </div>

          <div
            ref={listRef}
            id={listId}
            className={styles.list}
            role="listbox"
            tabIndex={0}
            aria-label="Clipboard items"
            aria-activedescendant={sel.selected ? `clip-${sel.selected.id}` : undefined}
          >
            {items.map((item) => (
              <ClipRow
                key={item.id}
                item={item}
                domId={`clip-${item.id}`}
                selected={item.id === sel.selectedId}
                now={now}
                onSelect={(id) => {
                  sel.setSelectedId(id);
                  listRef.current?.focus();
                }}
                onActivate={(id) => void copy(id)}
                onCopy={(id) => void copy(id)}
                onPin={(id, p) => void pin(id, p)}
                onDelete={(id) => void remove(id)}
              />
            ))}
            {list.loading && items.length === 0 && (
              <div className={styles.note}>
                <Spinner size={14} label="Loading" />
              </div>
            )}
            {!list.loading && items.length === 0 && (
              <div className={styles.note}>{filtering ? "No matching items." : "Nothing copied yet."}</div>
            )}
            {list.hasMore && (
              <div className={styles.more}>
                <Button size="sm" variant="secondary" onClick={list.loadMore} loading={list.loadingMore} data-tip="Show older items">
                  Load more
                </Button>
              </div>
            )}
          </div>
          {list.error && (
            <p className={styles.errorText} role="alert">
              {list.error}
            </p>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmClear}
        title="Clear clipboard history?"
        tone="danger"
        confirmLabel="Clear"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => void clear()}
        body={
          <>
            <p className={styles.dialogText}>This permanently deletes the saved items, including copied images.</p>
            <label className={styles.check}>
              <input type="checkbox" data-tip="Leave pinned items alone and delete the rest" checked={keepPinned} onChange={(e) => setKeepPinned(e.target.checked)} />
              Keep pinned items
            </label>
          </>
        }
      />
    </div>
    </ClickInHost>
  );
}
