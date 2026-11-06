import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Banner, Button, ClickIn, ClickInHost, ConfirmDialog, EmptyState, IconButton, MenuButton, SegmentedControl, Select, TextField, cx, toast } from "@/components";
import { LibraryService, LibrarySort, type Output } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { NARROW_QUERY, useMediaQuery } from "@/lib/media";
import { openTool } from "@/lib/openTool";
import { isMac, revealLabel } from "@/lib/platform";
import { useShortcut } from "@/lib/shortcuts";
import {
  DEFAULT_FILTERS,
  isNotImplemented,
  useLibrary,
  type CardSize,
  type DateRange,
  type LibraryViewMode,
  type TypeChip,
} from "@/state/library";
import { isReady, useModules } from "@/state/modules";
import { useSettings } from "@/state/settings";
import { ByToolView } from "./ByToolView";
import { DetailPanel, type GoTarget, type TrashState } from "./DetailPanel";
import { FolderView } from "./FolderView";
import { GridView } from "./GridView";
import { ListView } from "./ListView";
import { fromEntry, fromOutput, fromPath, type LibItem } from "./items";
import { sendToItems } from "./sendTo";
import styles from "./Library.module.css";

export { sendToItems };

function fail(e: unknown): void {
  const err = toAppError(e);
  toast({ tone: "danger", title: err.message, description: err.hint });
}

const TYPE_OPTIONS: { value: TypeChip; label: string; tip: string }[] = [
  { value: "all", label: "All", tip: "Every type of file" },
  { value: "audio", label: "Audio", tip: "Only audio files" },
  { value: "video", label: "Video", tip: "Only videos" },
  { value: "image", label: "Images", tip: "Only images" },
  { value: "document", label: "Documents", tip: "Only documents and PDFs" },
  { value: "other", label: "Other", tip: "Everything else" },
];

const VIEW_OPTIONS: { value: LibraryViewMode; label: string; tip: string }[] = [
  { value: "grid", label: "Grid", tip: "Thumbnail cards" },
  { value: "list", label: "List", tip: "Dense rows" },
  { value: "folders", label: "Folders", tip: "Your library folder as it is on disk" },
  { value: "bytool", label: "By tool", tip: "One section per tool" },
];

const SIZE_OPTIONS: { value: CardSize; label: string; tip: string }[] = [
  { value: "s", label: "S", tip: "Small cards" },
  { value: "m", label: "M", tip: "Medium cards" },
  { value: "l", label: "L", tip: "Large cards" },
];

const RANGE_OPTIONS: { value: DateRange; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
];

const SORT_OPTIONS: { value: LibrarySort; label: string }[] = [
  { value: LibrarySort.SortNewest, label: "Newest first" },
  { value: LibrarySort.SortOldest, label: "Oldest first" },
  { value: LibrarySort.SortName, label: "Name" },
  { value: LibrarySort.SortSize, label: "Largest first" },
];

/** How long a forgotten entry can be brought back before it's really removed. */
const FORGET_UNDO_MS = 6000;
const SEARCH_DEBOUNCE_MS = 200;

const binName = isMac ? "Trash" : "Recycle Bin";

export function LibraryView() {
  const view = useLibrary((s) => s.view);
  const size = useLibrary((s) => s.size);
  const filters = useLibrary((s) => s.filters);
  const folder = useLibrary((s) => s.folder);
  const list = useLibrary((s) => s.list);
  const listNext = useLibrary((s) => s.listNext);
  const listLoading = useLibrary((s) => s.listLoading);
  const unavailable = useLibrary((s) => s.unavailable);
  const target = useLibrary((s) => s.target);
  const folders = useLibrary((s) => s.folders);
  const foldersUnavailable = useLibrary((s) => s.foldersUnavailable);
  const modules = useModules((s) => s.list);
  const byId = useModules((s) => s.byId);
  const libraryDir = useSettings((s) => s.settings.libraryDir);
  const narrow = useMediaQuery(NARROW_QUERY);

  const [searchText, setSearchText] = useState(filters.search);
  /** The selected items (click, Shift/Mod-click, Mod+A). */
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [activeKey, setActiveKey] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const [renameNonce, setRenameNonce] = useState(0);
  /** A file reached by a link (made from, a generation) that the list doesn't hold. */
  const [extra, setExtra] = useState<LibItem | null>(null);
  const anchor = useRef("");
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const pending = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [trashOk, setTrashOk] = useState<TrashState>({ available: false, reason: `Checking whether files can be moved to the ${binName}…` });
  const [confirm, setConfirm] = useState<LibItem[] | null>(null);
  const [dirItems, setDirItems] = useState<LibItem[]>([]);
  const [dirTruncated, setDirTruncated] = useState(false);
  const [dirLoading, setDirLoading] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const newestWanted = useRef<{ nonce: number; list: unknown } | null>(null);

  const moduleName = useCallback((id: string) => byId[id]?.name ?? id, [byId]);
  const moduleIcon = useCallback((id: string) => byId[id]?.icon ?? "box", [byId]);
  const hasTool = useCallback((id: string) => {
    const m = byId[id];
    return !!m && isReady(m);
  }, [byId]);

  const moduleOptions = useMemo(() => [{ value: "", label: "All tools" }, ...modules.filter(isReady).map((m) => ({ value: m.id, label: m.name }))], [modules]);

  // --- data ---

  useEffect(() => {
    if (view === "folders") return;
    void useLibrary.getState().query().catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, view === "bytool", view === "folders"]);

  useEffect(() => {
    if (view === "folders" || view === "bytool") void useLibrary.getState().loadFolders().catch(fail);
  }, [view, refreshNonce]);

  // The detail panel needs the library root to tell library inputs from outside ones.
  const needRoot = detailOpen && folders === null && !foldersUnavailable;
  useEffect(() => {
    if (needRoot) void useLibrary.getState().loadFolders().catch(() => undefined);
  }, [needRoot]);

  useEffect(() => {
    let alive = true;
    LibraryService.TrashAvailable()
      .then((ok) => {
        if (alive) setTrashOk({ available: ok, reason: `Moving files to the ${binName} isn't available on this computer.` });
      })
      .catch((e: unknown) => {
        if (alive) setTrashOk({ available: false, reason: isNotImplemented(e) ? "Deleting files isn't available yet in this build." : `Moving files to the ${binName} isn't available.` });
      });
    return () => {
      alive = false;
    };
  }, []);

  // The selected folder's contents (Folders view). A change to the list (live added/removed) re-reads it.
  useEffect(() => {
    if (view !== "folders") return;
    let alive = true;
    setDirLoading(true);
    const t = setTimeout(() => {
      LibraryService.ListDir(folder, 5000)
        .then((l) => {
          if (!alive) return;
          setDirItems((l.entries ?? []).map(fromEntry));
          setDirTruncated(l.truncated);
        })
        .catch((e: unknown) => {
          if (!alive) return;
          setDirItems([]);
          if (!isNotImplemented(e)) fail(e);
        })
        .finally(() => alive && setDirLoading(false));
    }, 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [view, folder, refreshNonce, list]);

  // Search: typed text becomes a server filter after a short pause.
  useEffect(() => {
    if (searchText === useLibrary.getState().filters.search) return;
    const t = setTimeout(() => useLibrary.getState().setFilters({ search: searchText }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchText]);
  useEffect(() => {
    setSearchText(filters.search);
  }, [filters.search]);

  // On unmount: finish pending removals.
  useEffect(() => {
    const timers = pending.current;
    return () => {
      const ids = [...timers.keys()];
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const id of ids) void useLibrary.getState().remove(id).catch(() => undefined);
    };
  }, []);

  // --- what is on screen ---

  const visibleList = useMemo(() => list.filter((o) => !hidden.has(o.id)).map(fromOutput), [list, hidden]);
  const folderItems = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    return dirItems.filter((i) => {
      if (hidden.has(i.outputId)) return false;
      if (q && !i.name.toLowerCase().includes(q)) return false;
      if (filters.type !== "all" && !i.isDir) {
        const other = i.kind !== "audio" && i.kind !== "video" && i.kind !== "image" && i.kind !== "document";
        if (filters.type === "other" ? !other : i.kind !== filters.type) return false;
      }
      return true;
    });
  }, [dirItems, hidden, filters.search, filters.type]);

  const byKey = useMemo(() => {
    const m = new Map<string, LibItem>();
    if (extra) m.set(extra.key, extra);
    for (const i of dirItems) m.set(i.key, i);
    for (const i of visibleList) m.set(i.key, i);
    return m;
  }, [extra, dirItems, visibleList]);

  const shownItems = view === "folders" ? folderItems : visibleList;
  const active = byKey.get(activeKey);
  const targets: LibItem[] = selection.size > 0 ? [...selection].map((k) => byKey.get(k)).filter((i): i is LibItem => !!i && !i.isDir) : active && !active.isDir ? [active] : [];
  const bulk = selection.size > 1 ? targets : [];
  const detailItem = detailOpen && selection.size <= 1 && active && !active.isDir ? active : null;

  // Drop selection of items that are gone (filters, forgets, deletes).
  useEffect(() => {
    setSelection((cur) => {
      if (cur.size === 0) return cur;
      const next = new Set([...cur].filter((k) => byKey.has(k)));
      return next.size === cur.size ? cur : next;
    });
    setActiveKey((k) => (k && !byKey.has(k) ? "" : k));
  }, [byKey]);

  // --- selection ---

  const domKeys = (): string[] => [...(bodyRef.current?.querySelectorAll<HTMLElement>("[data-lib-key]") ?? [])].map((n) => n.dataset.libKey ?? "").filter(Boolean);

  const selectRange = (toKey: string): Set<string> => {
    const keys = domKeys();
    const a = keys.indexOf(anchor.current || toKey);
    const b = keys.indexOf(toKey);
    if (a < 0 || b < 0) return new Set([toKey]);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return new Set(keys.slice(lo, hi + 1));
  };

  const focusKey = (key: string) => {
    setActiveKey(key);
    const sel = `[data-lib-key="${CSS.escape(key)}"]`;
    // Wait a frame: the roving tab stop moves first.
    requestAnimationFrame(() => bodyRef.current?.querySelector<HTMLElement>(sel)?.focus());
    bodyRef.current?.querySelector<HTMLElement>(sel)?.focus();
  };

  const onItemClick = (e: MouseEvent, item: LibItem) => {
    setActiveKey(item.key);
    if (e.shiftKey) {
      setSelection(selectRange(item.key));
    } else if (e.metaKey || e.ctrlKey) {
      setSelection((s) => {
        const next = new Set(s);
        if (next.has(item.key)) next.delete(item.key);
        else next.add(item.key);
        return next;
      });
      anchor.current = item.key;
    } else {
      setSelection(new Set([item.key]));
      anchor.current = item.key;
      if (!item.isDir) setDetailOpen(true);
    }
  };

  const select = (item: LibItem) => {
    setActiveKey(item.key);
    setSelection(new Set([item.key]));
    anchor.current = item.key;
    setDetailOpen(true);
  };

  /** Selects a file by link: the list's own item when it has it, else one built from the link. */
  const go = (t: GoTarget) => {
    const known = [...byKey.values()].find((i) => (t.outputId && i.outputId === t.outputId) || i.path === t.path);
    if (known) return select(known);
    const item = t.output ? fromOutput(t.output) : { ...fromPath(t.path), outputId: t.outputId, key: t.outputId || `path:${t.path}`, registered: t.outputId !== "" };
    setExtra(item);
    select(item);
  };

  // Deep links (openLibrary): a file, an output, or "the newest of this tool".
  useEffect(() => {
    if (!target) return;
    const st = useLibrary.getState();
    st.clearTarget();
    if (target.path || target.outputId) {
      go({ path: target.path ?? "", outputId: target.outputId ?? "" });
    } else {
      newestWanted.current = { nonce: target.nonce, list: st.list };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  useEffect(() => {
    const w = newestWanted.current;
    if (!w || listLoading || list === w.list) return;
    newestWanted.current = null;
    const first = list.find((o) => !hidden.has(o.id));
    if (first) select(fromOutput(first));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, listLoading]);

  // --- actions ---

  const reveal = (i: LibItem) => (i.outputId ? LibraryService.Reveal(i.outputId) : LibraryService.RevealPath(i.path)).catch(fail);
  const open = (i: LibItem) => {
    if (i.isDir) {
      useLibrary.getState().setFolder(i.rel);
      setSelection(new Set());
      setActiveKey("");
      return;
    }
    return (i.outputId ? LibraryService.Open(i.outputId) : LibraryService.RevealPath(i.path)).catch(fail);
  };

  /** Hides the entries now and removes them for real after the Undo window. The files are never touched. */
  const forget = (items: LibItem[]) => {
    const os = items.filter((i) => i.outputId);
    if (os.length === 0) return;
    const ids = os.map((o) => o.outputId);
    setHidden((h) => new Set([...h, ...ids]));
    setSelection((s) => new Set([...s].filter((k) => !ids.includes(k))));
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

  const askTrash = (items: LibItem[]) => {
    const files = items.filter((i) => !i.isDir);
    if (files.length === 0 || !trashOk.available) return;
    setConfirm(files);
  };

  const doTrash = async (items: LibItem[]) => {
    setConfirm(null);
    try {
      const ids = items.filter((i) => i.outputId).map((i) => i.outputId);
      const paths = items.filter((i) => !i.outputId).map((i) => i.path);
      const res = await LibraryService.Trash(ids, paths);
      const gone = new Set(res.trashed ?? []);
      const goneItems = items.filter((i) => gone.has(i.path));
      const goneIds = goneItems.filter((i) => i.outputId).map((i) => i.outputId);
      if (goneIds.length > 0) useLibrary.getState().removeLocal(goneIds);
      const goneKeys = new Set(goneItems.map((i) => i.key));
      setDirItems((d) => d.filter((i) => !goneKeys.has(i.key)));
      setSelection((s) => new Set([...s].filter((k) => !goneKeys.has(k))));
      if (goneItems.length > 0) {
        toast({
          tone: "success",
          title: goneItems.length === 1 ? `Moved ${goneItems[0]?.name ?? "1 file"} to the ${binName}` : `Moved ${goneItems.length} files to the ${binName}`,
          description: `You can restore ${goneItems.length === 1 ? "it" : "them"} from the ${binName}.`,
        });
        if (view === "folders" || view === "bytool") void useLibrary.getState().loadFolders().catch(() => undefined);
      }
      const failed = Object.entries(res.failed ?? {});
      if (failed.length > 0) {
        const [p, why] = failed[0] ?? ["", ""];
        toast({ tone: "warn", title: `${failed.length === 1 ? "1 file" : `${failed.length} files`} couldn't be deleted`, description: `${p.split(/[\\/]/).pop() ?? p}: ${why}` });
      }
    } catch (e) {
      fail(e);
    }
  };

  const onRenamed = (o: Output) => {
    useLibrary.getState().replaceLocal(o);
    setDirItems((d) => d.map((i) => (i.outputId === o.id ? { ...fromOutput(o), isDir: false, rel: i.rel } : i)));
    setExtra((x) => (x && x.outputId === o.id ? fromOutput(o) : x));
    // The key is the output id, so the selection stays; path-keyed entries don't rename.
  };

  const saveCopies = async (items: LibItem[]) => {
    const ids = items.filter((i) => i.outputId).map((i) => i.outputId);
    if (ids.length === 0) return;
    try {
      const dir = await LibraryService.SaveCopies(ids);
      if (dir) toast({ tone: "success", title: `Saved ${ids.length === 1 ? "a copy" : `${ids.length} copies`} to ${dir}` });
    } catch (e) {
      fail(e);
    }
  };

  const refreshAll = () => {
    setRefreshNonce((n) => n + 1);
    if (view !== "folders") void useLibrary.getState().query().catch(fail);
    void useLibrary.getState().loadPlaces().catch(() => undefined);
  };

  // --- keyboard ---

  useShortcut("/", () => searchRef.current?.focus());
  useShortcut("Mod+A", () => setSelection(new Set(domKeys())), { when: shownItems.length > 0 });
  useShortcut(
    "Escape",
    () => {
      if (detailOpen && !confirm) setDetailOpen(false);
      else setSelection(new Set());
    },
    { when: (selection.size > 0 || detailOpen) && !confirm, preventDefault: false },
  );
  useShortcut(
    "Mod+Shift+R",
    () => {
      for (const o of targets) if (!o.missing) void reveal(o);
    },
    { when: targets.length > 0, allowInInputs: true },
  );

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const el = e.target as HTMLElement;
    const key = el.dataset.libKey;
    if (!key || el.closest("input, textarea, select")) return; // only on a card itself; buttons keep their own keys
    const item = byKey.get(key);
    if (!item) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const keys = domKeys();
      const idx = keys.indexOf(key);
      const nodes = [...(bodyRef.current?.querySelectorAll<HTMLElement>("[data-lib-key]") ?? [])];
      let cols = 1;
      if (view !== "list") {
        const top = nodes[idx]?.offsetTop ?? 0;
        cols = Math.max(1, nodes.filter((n) => n.offsetTop === top && n.parentElement === nodes[idx]?.parentElement).length);
      }
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? cols : -cols;
      if ((view === "list" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) || idx < 0) return;
      e.preventDefault();
      const next = keys[Math.min(keys.length - 1, Math.max(0, idx + step))];
      if (!next) return;
      if (e.shiftKey) setSelection(selectRange(next));
      else {
        setSelection(new Set([next]));
        anchor.current = next;
      }
      focusKey(next);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!item.missing || item.isDir) void open(item);
    } else if (e.key === " ") {
      e.preventDefault();
      setSelection(new Set([key]));
      setActiveKey(key);
      setDetailOpen((o) => (item.isDir ? false : !o || activeKey !== key));
    } else if (e.key === "Delete") {
      e.preventDefault();
      askTrash(selection.size > 1 ? targets : [item]);
    } else if (e.key === "F2") {
      e.preventDefault();
      setSelection(new Set([key]));
      setActiveKey(key);
      setDetailOpen(true);
      setRenameNonce((n) => n + 1);
    }
  };

  // --- render ---

  const handlers = {
    selection,
    activeKey,
    moduleName,
    onClick: onItemClick,
    onEnterFolder: open,
    dragPaths: (i: LibItem) => (selection.has(i.key) && selection.size > 1 ? targets.filter((t) => !t.missing).map((t) => t.path) : [i.path]),
    onForget: (i: LibItem) => forget([i]),
  };

  const filterSummary = [filters.moduleId ? moduleName(filters.moduleId) : "All tools", filters.range !== "all" ? (RANGE_OPTIONS.find((r) => r.value === filters.range)?.label ?? "") : "", filters.sort !== LibrarySort.SortNewest ? (SORT_OPTIONS.find((r) => r.value === filters.sort)?.label ?? "") : ""]
    .filter(Boolean)
    .join(" · ");
  const filtersOn = filters.moduleId !== "" || filters.range !== "all" || filters.sort !== LibrarySort.SortNewest || filters.search !== "" || filters.type !== "all";
  const libraryRoot = folders?.path || libraryDir;
  const empty = shownItems.length === 0;
  const cardSize = size;

  const body = (() => {
    if (view === "folders") {
      return (
        <FolderView
          root={folders}
          unavailable={foldersUnavailable}
          folder={folder}
          onFolder={(rel) => {
            useLibrary.getState().setFolder(rel);
            setSelection(new Set());
            setActiveKey("");
          }}
          items={folderItems}
          truncated={dirTruncated}
          loading={dirLoading}
          size={cardSize}
          narrow={narrow}
          {...handlers}
        />
      );
    }
    if (empty) {
      return (
        <EmptyState
          icon="history"
          title={listLoading ? "Loading…" : filtersOn ? "Nothing matches these filters." : "Your outputs will appear here."}
          size="lg"
          action={
            filtersOn && !listLoading ? (
              <Button size="sm" variant="secondary" icon="x" data-tip="Show everything again" onClick={() => useLibrary.getState().setFilters({ ...DEFAULT_FILTERS })}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      );
    }
    if (view === "list") return <ListView items={visibleList} {...handlers} />;
    if (view === "bytool") {
      return (
        <ByToolView
          items={visibleList}
          root={folders}
          size={cardSize}
          moduleIcon={moduleIcon}
          isTool={hasTool}
          onShowAll={(moduleId) => {
            useLibrary.getState().setFilters({ moduleId });
            useLibrary.getState().setView("grid");
          }}
          onOpenFolder={(_m, f) => void (f.rel ? LibraryService.OpenLibraryFolder(f.rel) : LibraryService.OpenLibraryFolder("")).catch(fail)}
          onOpenTool={(id) => void openTool(id)}
          onFolder={(rel) => {
            useLibrary.getState().setFolder(rel);
            useLibrary.getState().setView("folders");
          }}
          {...handlers}
        />
      );
    }
    return <GridView items={visibleList} size={cardSize} label="Outputs" {...handlers} />;
  })();

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
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            wrapperClassName={styles.search}
          />
          <SegmentedControl size="sm" aria-label="View" value={view} onChange={(v) => useLibrary.getState().setView(v)} options={VIEW_OPTIONS} />
          {view !== "list" ? <SegmentedControl size="sm" aria-label="Card size" value={size} onChange={(v) => useLibrary.getState().setSize(v)} options={SIZE_OPTIONS} /> : null}
          <ClickIn icon="list-filter" title="Filters" summary={filterSummary} tip="Filter by tool and date, and choose the order" className={styles.filters} width={320}>
            <div className={styles.drawerBody}>
              <Select value={filters.moduleId} onChange={(moduleId) => useLibrary.getState().setFilters({ moduleId })} aria-label="Filter by tool" data-tip="Show only files made by one tool" options={moduleOptions} />
              <Select value={filters.range} onChange={(range) => useLibrary.getState().setFilters({ range })} aria-label="Filter by date" data-tip="Show only files made in this period" options={RANGE_OPTIONS} />
              <Select value={filters.sort} onChange={(sort) => useLibrary.getState().setFilters({ sort })} aria-label="Sort by" data-tip="The order of the files" options={SORT_OPTIONS} />
              {filtersOn ? (
                <Button size="sm" variant="secondary" icon="x" data-tip="Show files from every tool again" onClick={() => useLibrary.getState().setFilters({ ...DEFAULT_FILTERS })}>
                  Clear filters
                </Button>
              ) : null}
            </div>
          </ClickIn>
          <IconButton icon="refresh-cw" label="Refresh" data-tip="Look at the library folder again" onClick={refreshAll} />
          <IconButton
            icon="folder-open"
            label="Open library folder"
            data-tip="Open your library folder, where all outputs are saved, in the file manager"
            onClick={() => void LibraryService.OpenLibraryFolder("").catch(fail)}
          />
        </header>

        <div className={styles.typeBar}>
          <SegmentedControl size="sm" aria-label="File type" value={filters.type} onChange={(type) => useLibrary.getState().setFilters({ type })} options={TYPE_OPTIONS} />
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
              <Button size="sm" variant="secondary" icon="download" disabled={!bulk.some((o) => o.outputId && !o.missing)} data-tip="Copy the selected files into a folder you choose" onClick={() => void saveCopies(bulk.filter((o) => !o.missing))}>
                Save copies to a folder…
              </Button>
              <Button size="sm" variant="secondary" icon="x" data-tip="Forget these entries; the files themselves are not deleted" onClick={() => forget(bulk)}>
                Forget
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon="trash-2"
                disabled={!trashOk.available}
                data-tip={trashOk.available ? `Move the selected files to the ${binName}` : trashOk.reason}
                onClick={() => askTrash(bulk)}
              >
                Delete
              </Button>
            </div>
          ) : null}
        </div>

        {unavailable && view !== "folders" ? <Banner tone="info">Showing your recent files only. Search by type, date and order will work once the library index is ready.</Banner> : null}

        <div className={cx(styles.main, detailItem && !narrow && styles.withDetail)}>
          <div ref={bodyRef} className={styles.scroll} onKeyDown={onKeyDown}>
            {body}
            {view !== "folders" && listNext ? (
              <div className={styles.more}>
                <Button size="sm" variant="secondary" loading={listLoading} data-tip="Show older outputs" onClick={() => void useLibrary.getState().loadMoreList().catch(fail)}>
                  Load more
                </Button>
              </div>
            ) : null}
          </div>
          {detailItem ? (
            <div className={cx(styles.detailWrap, narrow && styles.detailDrawer)}>
              <DetailPanel
                item={detailItem}
                libraryRoot={libraryRoot}
                moduleName={moduleName}
                hasTool={hasTool}
                trash={trashOk}
                renameNonce={renameNonce}
                onClose={() => setDetailOpen(false)}
                onGo={go}
                onForget={(i) => forget([i])}
                onTrash={(i) => askTrash([i])}
                onRenamed={onRenamed}
              />
            </div>
          ) : null}
        </div>
      </section>
      <ConfirmDialog
        open={confirm !== null}
        tone="danger"
        title={confirm && confirm.length === 1 ? `Move ${confirm[0]?.name ?? "this file"} to the ${binName}?` : `Move ${confirm?.length ?? 0} files to the ${binName}?`}
        body={
          confirm ? (
            <>
              {confirm.length > 1 ? <p>{confirm.slice(0, 5).map((i) => i.name).join(", ")}{confirm.length > 5 ? `, and ${confirm.length - 5} more` : ""} ({formatBytes(confirm.reduce((n, i) => n + i.sizeBytes, 0))}).</p> : null}
              <p>{`You can restore ${confirm.length === 1 ? "it" : "them"} from the ${binName}.`}</p>
            </>
          ) : undefined
        }
        confirmLabel={confirm && confirm.length === 1 ? "Delete file" : `Delete ${confirm?.length ?? 0} files`}
        onConfirm={() => confirm && void doTrash(confirm)}
        onCancel={() => setConfirm(null)}
      />
    </ClickInHost>
  );
}
