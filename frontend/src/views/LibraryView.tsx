import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Badge, Button, EmptyState, Icon, IconButton, MenuButton, Select, TextField, toast, type MenuItem } from "@/components";
import { LibraryService, ModulesService, OutputKind } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { revealLabel } from "@/lib/platform";
import { useShortcut } from "@/lib/shortcuts";
import { useLibrary, type OutputView } from "@/state/library";
import { useUI } from "@/state/ui";
import { isReady, useModules } from "@/state/modules";
import styles from "./LibraryView.module.css";

const kindIcon: Record<string, string> = {
  [OutputKind.KindAudio]: "music",
  [OutputKind.KindVideo]: "film",
  [OutputKind.KindImage]: "image",
  [OutputKind.KindDocument]: "file-text",
  [OutputKind.KindOther]: "file",
};

function fail(e: unknown): void {
  const err = toAppError(e);
  toast({ tone: "danger", title: err.message, description: err.hint });
}

/** Ready modules that accept `path`, as menu items that hand the file off. */
async function sendToItems(path: string): Promise<MenuItem[]> {
  const res = await ModulesService.Match([path]);
  return (res.matches ?? [])
    .filter((m) => isReady(m.module))
    .map((m) => ({
      id: m.module.id,
      label: m.module.name,
      icon: m.module.icon,
      onSelect: () => useUI.getState().handOff({ moduleId: m.module.id, inputs: [path] }),
    }));
}

export function LibraryView() {
  const items = useLibrary((s) => s.items);
  const nextCursor = useLibrary((s) => s.nextCursor);
  const loading = useLibrary((s) => s.loading);
  const modules = useModules((s) => s.list);
  const byId = useModules((s) => s.byId);

  const [search, setSearch] = useState("");
  const [moduleId, setModuleId] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const firstRun = useRef(true);

  const moduleOptions = useMemo(
    () => [
      { value: "", label: "All tools" },
      ...modules.filter(isReady).map((m) => ({ value: m.id, label: m.name })),
    ],
    [modules],
  );

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      if (!search && !moduleId) return;
    }
    const t = setTimeout(() => {
      void useLibrary.getState().refresh({ search, moduleId });
    }, 200);
    return () => clearTimeout(t);
  }, [search, moduleId]);

  // Restore the unfiltered first page for other views on unmount.
  useEffect(
    () => () => {
      void useLibrary.getState().refresh({});
    },
    [],
  );

  useShortcut("/", () => searchRef.current?.focus());

  const selected: OutputView | undefined = items.find((o) => o.id === selectedId);

  const reveal = (o: OutputView) => LibraryService.Reveal(o.id).catch(fail);
  const open = (o: OutputView) => LibraryService.Open(o.id).catch(fail);
  const copyPath = async (o: OutputView) => {
    try {
      await navigator.clipboard.writeText(o.path);
      toast({ title: "Path copied" });
    } catch (e) {
      fail(e);
    }
  };
  const remove = (o: OutputView) => useLibrary.getState().remove(o.id).catch(fail);

  useShortcut(
    "Mod+Shift+R",
    () => {
      if (selected && !selected.missing) void reveal(selected);
    },
    { when: !!selected, allowInInputs: true },
  );

  const focusRow = (id: string) => {
    setSelectedId(id);
    listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus();
  };

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
    const onRow = (e.target as HTMLElement).dataset.id !== undefined;
    if (!onRow) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (selected && !selected.missing) void open(selected);
      return;
    }
    e.preventDefault();
    const idx = items.findIndex((o) => o.id === selectedId);
    const next = e.key === "ArrowDown" ? Math.min(items.length - 1, idx + 1) : Math.max(0, idx - 1);
    const target = items[next];
    if (target) focusRow(target.id);
  };

  const rovingId = selected ? selected.id : (items[0]?.id ?? "");

  return (
    <section className={styles.root} aria-label="Recent">
      <header className={styles.header}>
        <h1 className={styles.title}>Recent</h1>
        <div className={styles.toolbar}>
          <TextField
            ref={searchRef}
            icon="search"
            size="sm"
            placeholder="Search outputs"
            aria-label="Search outputs"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            wrapperClassName={styles.search}
          />
          <Select
            size="sm"
            value={moduleId}
            onChange={setModuleId}
            options={moduleOptions}
            className={styles.filter}
          />
          <Button
            size="sm"
            variant="secondary"
            icon="folder-open"
            onClick={() => void LibraryService.OpenLibraryFolder("").catch(fail)}
          >
            Open library folder
          </Button>
        </div>
      </header>

      {items.length === 0 ? (
        <EmptyState icon="history" title="Your outputs will appear here." size="lg" />
      ) : (
        <ul ref={listRef} className={styles.list} role="listbox" aria-label="Outputs" onKeyDown={onListKey}>
          {items.map((o) => (
            <li
              key={o.id}
              data-id={o.id}
              role="option"
              aria-selected={o.id === selectedId}
              tabIndex={o.id === rovingId ? 0 : -1}
              className={`${styles.row} ${o.missing ? styles.missing : ""} ${o.id === selectedId ? styles.selected : ""}`}
              onClick={() => setSelectedId(o.id)}
              onFocus={() => setSelectedId(o.id)}
              onDoubleClick={() => !o.missing && void open(o)}
            >
              <span className={styles.kind}>
                <Icon name={kindIcon[o.kind] ?? "file"} size={16} />
              </span>
              <span className={styles.name} title={o.path}>
                {o.name}
              </span>
              {o.missing ? <Badge tone="warn">MISSING</Badge> : null}
              <span className={styles.module}>{byId[o.moduleId]?.name ?? o.moduleId}</span>
              <span className={styles.mono}>{o.missing ? "" : formatBytes(o.sizeBytes)}</span>
              <span className={styles.mono}>{formatRelativeTime(o.createdAt)}</span>
              <span className={styles.actions}>
                <IconButton
                  size="sm"
                  icon="folder-open"
                  label={revealLabel}
                  disabled={o.missing}
                  onClick={() => void reveal(o)}
                />
                {!o.missing && (
                  <MenuButton
                    size="sm"
                    variant="ghost"
                    icon="external-link"
                    label="Send to…"
                    emptyLabel="No tools accept this file"
                    items={() => sendToItems(o.path)}
                  />
                )}
                <IconButton
                  size="sm"
                  icon="external-link"
                  label="Open"
                  disabled={o.missing}
                  onClick={() => void open(o)}
                />
                <IconButton
                  size="sm"
                  icon="copy"
                  label="Copy path"
                  disabled={o.missing}
                  onClick={() => void copyPath(o)}
                />
                <IconButton
                  size="sm"
                  icon="trash-2"
                  label="Remove from library"
                  onClick={() => void remove(o)}
                />
              </span>
            </li>
          ))}
        </ul>
      )}

      {nextCursor ? (
        <div className={styles.more}>
          <Button size="sm" variant="secondary" loading={loading} onClick={() => void useLibrary.getState().loadMore()}>
            Load more
          </Button>
        </div>
      ) : null}
    </section>
  );
}
