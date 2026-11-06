import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Badge, Button, ClickIn, ClickInHost, EmptyState, Icon, IconButton, MenuButton, Select, TextField, toast, type MenuItem } from "@/components";
import { LibraryService, ModulesService, OutputKind } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { openToolItems } from "@/lib/openTool";
import { revealLabel } from "@/lib/platform";
import { useShortcut } from "@/lib/shortcuts";
import { useLibrary, type OutputView } from "@/state/library";
import { isReady, useModules } from "@/state/modules";
// --- pipelines ---
import { usePipelines } from "@/state/pipelines";
import { inputAccepted } from "@/tools/pipelines/RunSheetModel";
import { openPipelineRunSheet } from "@/shell/dropRouting";
// --- end pipelines ---
// --- add to post ---
import { toolAction } from "@/lib/toolActions";
import { acceptsPath } from "@/tools/_kit/accepts";
// --- end add to post ---
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
export async function sendToItems(path: string): Promise<MenuItem[]> {
  const res = await ModulesService.Match([path]);
  const tools: MenuItem[] = (res.matches ?? [])
    .filter((m) => isReady(m.module))
    .flatMap((m) =>
      // "Open in <tool>" plus "…(new window)"; names come from the match so they're right even before the store fills.
      openToolItems(m.module.id, [path], "send").map((it, i) => ({
        ...it,
        label: i === 0 ? `Open in ${m.module.name}` : `Open in ${m.module.name} (new window)`,
        icon: i === 0 ? m.module.icon : "app-window",
      })),
    );
  // --- pipelines ---
  const pipelines: MenuItem[] = usePipelines
    .getState()
    .entries.filter((e) => inputAccepted(e.check.accepts, path))
    .map((e) => ({
      id: `pipeline:${e.pipeline.id}`,
      label: `Pipeline: ${e.pipeline.name}`,
      icon: "workflow",
      onSelect: () => openPipelineRunSheet(e.pipeline.id, [path]),
    }));
  // --- add to post ---
  const postModule = useModules.getState().byId["post-builder"];
  if (postModule && isReady(postModule) && acceptsPath(postModule.accepts.extensions, path)) {
    tools.push({
      id: "add-to-post",
      label: "Add to post…",
      icon: "gallery-horizontal-end",
      onSelect: () => void toolAction("addToPost")(path),
    });
  }
  // --- end add to post ---
  return pipelines.length > 0 ? [...tools, ...pipelines] : tools;
  // --- end pipelines ---
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

  const filterSummary = moduleId ? (byId[moduleId]?.name ?? moduleId) : "All tools";

  const rovingId = selected ? selected.id : (items[0]?.id ?? "");

  return (
    <ClickInHost className={styles.root}>
      <section className={styles.section} aria-label="Recent">
      <header className={styles.header}>
        <TextField
          ref={searchRef}
          icon="search"
          size="sm"
          placeholder="Search outputs"
          aria-label="Search outputs"
          data-tip="Search by file name. Press / to focus"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          wrapperClassName={styles.search}
        />
        <ClickIn icon="list-filter" title="Filters" summary={filterSummary} tip="Show only files made by one tool" className={styles.filters} width={320}>
          <div className={styles.drawerBody}>
            <Select
              value={moduleId}
              onChange={setModuleId}
              aria-label="Filter by tool"
              data-tip="Show only files made by one tool"
              options={moduleOptions}
            />
            {moduleId ? (
              <Button size="sm" variant="secondary" icon="x" data-tip="Show files from every tool again" onClick={() => setModuleId("")}>
                Clear filters
              </Button>
            ) : null}
          </div>
        </ClickIn>
        <IconButton
          icon="folder-open"
          label="Open library folder"
          data-tip="Open your library folder, where all outputs are saved, in the file manager"
          onClick={() => void LibraryService.OpenLibraryFolder("").catch(fail)}
        />
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
              <span className={styles.kind} data-tip="File type">
                <Icon name={kindIcon[o.kind] ?? "file"} size={16} />
              </span>
              <span className={styles.name} data-tip={o.path}>
                {o.name}
              </span>
              {o.missing ? <Badge tone="warn" tip="This file was moved or deleted outside the app">MISSING</Badge> : null}
              <span className={styles.module} data-tip="The tool that made this file">{byId[o.moduleId]?.name ?? o.moduleId}</span>
              <span className={styles.mono} data-tip="File size">{o.missing ? "" : formatBytes(o.sizeBytes)}</span>
              <span className={styles.mono} data-tip="When it was made">{formatRelativeTime(o.createdAt)}</span>
              <span className={styles.actions}>
                <IconButton
                  size="sm"
                  icon="folder-open"
                  label={revealLabel}
                  data-tip={o.missing ? "The file is missing" : "Show this file in your file manager"}
                  data-tip-kbd="Mod+Shift+R"
                  disabled={o.missing}
                  onClick={() => void reveal(o)}
                />
                {!o.missing && (
                  <MenuButton
                    size="sm"
                    variant="ghost"
                    icon="external-link"
                    label="Send to…"
                    tip="Send this file to another tool that can use it, or to a pipeline"
                    emptyLabel="No tools accept this file"
                    items={() => sendToItems(o.path)}
                  />
                )}
                <IconButton
                  size="sm"
                  icon="external-link"
                  label="Open"
                  data-tip={o.missing ? "The file is missing" : "Open with your default app (double-click or Enter also works)"}
                  disabled={o.missing}
                  onClick={() => void open(o)}
                />
                <IconButton
                  size="sm"
                  icon="copy"
                  label="Copy path"
                  data-tip={o.missing ? "The file is missing" : "Copy the full file path to the clipboard"}
                  disabled={o.missing}
                  onClick={() => void copyPath(o)}
                />
                <IconButton
                  size="sm"
                  icon="trash-2"
                  label="Remove from library"
                  data-tip="Forget this entry; the file itself is not deleted"
                  onClick={() => void remove(o)}
                />
              </span>
            </li>
          ))}
        </ul>
      )}

      {nextCursor ? (
        <div className={styles.more}>
          <Button size="sm" variant="secondary" loading={loading} data-tip="Show older outputs" onClick={() => void useLibrary.getState().loadMore()}>
            Load more
          </Button>
        </div>
      ) : null}
      </section>
    </ClickInHost>
  );
}
