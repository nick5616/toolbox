import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { Badge, Button, ClickIn, ClickInHost, EmptyState, Icon, IconButton, MenuButton, SegmentedControl, Select, TextField, toast, type MenuItem } from "@/components";
import { LibraryService, ModulesService, OutputKind } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { startPathsDrag } from "@/lib/fileDrag";
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

/**
 * Ready modules that accept `path` (or the files in it), as menu items that hand the
 * file(s) off, plus pipelines that take at least one of them.
 */
export async function sendToItems(path: string | string[]): Promise<MenuItem[]> {
  const paths = Array.isArray(path) ? path : [path];
  const many = paths.length > 1;
  const res = await ModulesService.Match(paths);
  const tools: MenuItem[] = (res.matches ?? [])
    .filter((m) => isReady(m.module))
    .flatMap((m) => {
      const inputs = many && m.paths && m.paths.length > 0 ? m.paths : paths;
      const suffix = many ? ` (${inputs.length} files)` : "";
      // "Open in <tool>" plus "…(new window)"; names come from the match so they're right even before the store fills.
      return openToolItems(m.module.id, inputs, "send").map((it, i) => ({
        ...it,
        label: i === 0 ? `Open in ${m.module.name}${suffix}` : `Open in ${m.module.name} (new window)${suffix}`,
        icon: i === 0 ? m.module.icon : "app-window",
      }));
    });
  // --- pipelines ---
  const pipelines: MenuItem[] = usePipelines
    .getState()
    .entries.map((e) => ({ e, ok: paths.filter((p) => inputAccepted(e.check.accepts, p)) }))
    .filter(({ ok }) => ok.length > 0)
    .map(({ e, ok }) => ({
      id: `pipeline:${e.pipeline.id}`,
      label: `Pipeline: ${e.pipeline.name}`,
      icon: "workflow",
      onSelect: () => openPipelineRunSheet(e.pipeline.id, ok),
    }));
  // --- add to post ---
  const postModule = useModules.getState().byId["post-builder"];
  if (!many && postModule && isReady(postModule) && acceptsPath(postModule.accepts.extensions, paths[0] ?? "")) {
    tools.push({
      id: "add-to-post",
      label: "Add to post…",
      icon: "gallery-horizontal-end",
      onSelect: () => void toolAction("addToPost")(paths[0] ?? ""),
    });
  }
  // --- end add to post ---
  return pipelines.length > 0 ? [...tools, ...pipelines] : tools;
  // --- end pipelines ---
}

type TypeChip = "all" | "audio" | "video" | "image" | "document" | "other";

const TYPE_OPTIONS: { value: TypeChip; label: string; tip: string }[] = [
  { value: "all", label: "All", tip: "Every type of file" },
  { value: "audio", label: "Audio", tip: "Only audio files" },
  { value: "video", label: "Video", tip: "Only videos" },
  { value: "image", label: "Images", tip: "Only images" },
  { value: "document", label: "Documents", tip: "Only documents and PDFs" },
  { value: "other", label: "Other", tip: "Everything else" },
];

function matchesType(chip: TypeChip, kind: string): boolean {
  if (chip === "all") return true;
  if (chip === "other") return kind !== "audio" && kind !== "video" && kind !== "image" && kind !== "document";
  return kind === chip;
}

/** How long a forgotten entry can be brought back before it's really removed. */
const FORGET_UNDO_MS = 6000;

export function LibraryView() {
  const items = useLibrary((s) => s.items);
  const nextCursor = useLibrary((s) => s.nextCursor);
  const loading = useLibrary((s) => s.loading);
  const modules = useModules((s) => s.list);
  const byId = useModules((s) => s.byId);

  const [search, setSearch] = useState("");
  const [moduleId, setModuleId] = useState("");
  const [type, setType] = useState<TypeChip>("all");
  /** The focused row. */
  const [activeId, setActiveId] = useState("");
  /** The selected rows (click, Shift/Mod-click, Mod+A). */
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef("");
  /** Entries forgotten but not yet removed (the Undo window). */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());
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

  const visible = useMemo(() => items.filter((o) => !hidden.has(o.id) && matchesType(type, o.kind)), [items, hidden, type]);

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

  // On unmount: finish pending removals, then restore the unfiltered first page for other views.
  useEffect(() => {
    const timers = pending.current;
    return () => {
      const ids = [...timers.keys()];
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      void Promise.all(ids.map((id) => useLibrary.getState().remove(id).catch(() => undefined))).then(() => useLibrary.getState().refresh({}));
    };
  }, []);

  // Drop selection of rows that are gone (filters, forgets).
  useEffect(() => {
    setSelection((cur) => {
      if (cur.size === 0) return cur;
      const ids = new Set(visible.map((o) => o.id));
      const next = new Set([...cur].filter((id) => ids.has(id)));
      return next.size === cur.size ? cur : next;
    });
  }, [visible]);

  useShortcut("/", () => searchRef.current?.focus());
  useShortcut("Mod+A", () => setSelection(new Set(visible.map((o) => o.id))), { when: visible.length > 0 });
  useShortcut("Escape", () => setSelection(new Set()), { when: selection.size > 0, preventDefault: false });

  const active: OutputView | undefined = visible.find((o) => o.id === activeId);
  /** What an action on "the selection" applies to: the selected rows, else the focused row. */
  const targets: OutputView[] = selection.size > 0 ? visible.filter((o) => selection.has(o.id)) : active ? [active] : [];
  const bulk = selection.size > 1 ? targets : [];

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

  /** Hides the entries now and removes them for real after the Undo window. The files are never touched. */
  const forget = (os: OutputView[]) => {
    if (os.length === 0) return;
    const ids = os.map((o) => o.id);
    setHidden((h) => new Set([...h, ...ids]));
    setSelection((s) => new Set([...s].filter((id) => !ids.includes(id))));
    const unhide = () => setHidden((h) => new Set([...h].filter((id) => !ids.includes(id))));
    const timer = setTimeout(() => {
      for (const id of ids) pending.current.delete(id);
      void Promise.all(ids.map((id) => useLibrary.getState().remove(id).catch(fail))).then(unhide);
    }, FORGET_UNDO_MS);
    for (const id of ids) pending.current.set(id, timer);
    toast({
      title: os.length === 1 ? `Forgot ${os[0]?.name ?? "1 file"}` : `Forgot ${os.length} files`,
      description: "Only the entry is removed; the file stays where it is.",
      duration: FORGET_UNDO_MS,
      action: {
        label: "Undo",
        onClick: () => {
          clearTimeout(timer);
          for (const id of ids) pending.current.delete(id);
          unhide();
        },
      },
    });
  };

  useShortcut(
    "Mod+Shift+R",
    () => {
      for (const o of targets) if (!o.missing) void reveal(o);
    },
    { when: targets.length > 0, allowInInputs: true },
  );

  const focusRow = (id: string) => {
    setActiveId(id);
    listRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus();
  };

  const selectRange = (toId: string) => {
    const a = visible.findIndex((o) => o.id === (anchor.current || toId));
    const b = visible.findIndex((o) => o.id === toId);
    if (a < 0 || b < 0) return new Set([toId]);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return new Set(visible.slice(lo, hi + 1).map((o) => o.id));
  };

  const onRowClick = (e: MouseEvent, o: OutputView) => {
    setActiveId(o.id);
    if (e.shiftKey) {
      setSelection(selectRange(o.id));
    } else if (e.metaKey || e.ctrlKey) {
      setSelection((s) => {
        const next = new Set(s);
        if (next.has(o.id)) next.delete(o.id);
        else next.add(o.id);
        return next;
      });
      anchor.current = o.id;
    } else {
      setSelection(new Set([o.id]));
      anchor.current = o.id;
    }
  };

  const onDragStart = (e: DragEvent, o: OutputView) => {
    if (o.missing) {
      e.preventDefault();
      return;
    }
    const picked = selection.has(o.id) && selection.size > 1 ? visible.filter((x) => selection.has(x.id) && !x.missing) : [o];
    startPathsDrag(e, picked.map((x) => x.path));
  };

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
    const onRow = (e.target as HTMLElement).dataset.id !== undefined;
    if (!onRow) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (active && !active.missing) void open(active);
      return;
    }
    e.preventDefault();
    const idx = visible.findIndex((o) => o.id === activeId);
    const next = e.key === "ArrowDown" ? Math.min(visible.length - 1, idx + 1) : Math.max(0, idx - 1);
    const target = visible[next];
    if (!target) return;
    if (e.shiftKey) {
      setSelection(selectRange(target.id));
    } else {
      setSelection(new Set([target.id]));
      anchor.current = target.id;
    }
    focusRow(target.id);
  };

  const filterSummary = moduleId ? (byId[moduleId]?.name ?? moduleId) : "All tools";

  const rovingId = active ? active.id : (visible[0]?.id ?? "");

  return (
    <ClickInHost className={styles.root}>
      <section className={styles.section} aria-label="Library">
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

        <div className={styles.typeBar}>
          <SegmentedControl size="sm" aria-label="File type" value={type} onChange={setType} options={TYPE_OPTIONS} />
          {bulk.length > 0 ? (
            <div className={styles.bulk} role="toolbar" aria-label="Selected files">
              <span className={styles.bulkCount}>{bulk.length} selected</span>
              <MenuButton
                size="sm"
                variant="secondary"
                icon="send"
                label="Send to…"
                tip="Send the selected files to a tool or pipeline that can use them"
                emptyLabel="No tools accept these files"
                items={() => sendToItems(bulk.filter((o) => !o.missing).map((o) => o.path))}
              />
              <Button
                size="sm"
                variant="secondary"
                icon="folder-open"
                data-tip="Show the selected files in your file manager"
                onClick={() => {
                  for (const o of bulk) if (!o.missing) void reveal(o);
                }}
              >
                {revealLabel}
              </Button>
              <Button size="sm" variant="secondary" icon="trash-2" data-tip="Forget these entries; the files themselves are not deleted" onClick={() => forget(bulk)}>
                Forget
              </Button>
            </div>
          ) : null}
        </div>

        {visible.length === 0 ? (
          <EmptyState icon="history" title={items.length === 0 ? "Your outputs will appear here." : "No files of this type."} size="lg" />
        ) : (
          <ul ref={listRef} className={styles.list} role="listbox" aria-label="Outputs" aria-multiselectable="true" onKeyDown={onListKey}>
            {visible.map((o) => (
              <li
                key={o.id}
                data-id={o.id}
                role="option"
                aria-selected={selection.has(o.id)}
                tabIndex={o.id === rovingId ? 0 : -1}
                draggable={!o.missing}
                className={`${styles.row} ${o.missing ? styles.missing : ""} ${selection.has(o.id) || o.id === activeId ? styles.selected : ""}`}
                onClick={(e) => onRowClick(e, o)}
                onFocus={() => setActiveId(o.id)}
                onDragStart={(e) => onDragStart(e, o)}
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
                      icon="send"
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
                    label="Forget"
                    data-tip="Forget this entry (you can undo); the file itself is not deleted"
                    onClick={() => forget([o])}
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
