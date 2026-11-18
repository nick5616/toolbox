import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Icon, Modal, SegmentedControl, Select, Spinner, TextField, cx, toast } from "@/components";
import { ComposerService, FilesService, LibraryService, LibrarySort, OutputKind, type Output, type ProjectInfo } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useModules } from "@/state/modules";
import { cachedSourceThumb, loadSourceThumb } from "@/blocks/sources/sourceThumbs";
import { libraryKey, normExts, offersCompositions, type LibraryPickOptions } from "./options";
import styles from "./LibraryPickerDialog.module.css";

// From Library…: files Toolbox already made (Library outputs of any tool) and,
// for pictures, saved Photo Composer compositions. A composition is exported
// into Library › Compositions first, so the pick is a real file the user can
// find again. Shared by every tool that takes files (blocks/library-picker).

const PAGE = 200;
/** The same size as the Sources grid's tiles, so both share one cache. */
const THUMB_DIM = 256;

/** Hidden modules that write Library files, by the tool the user knows them as. */
const HIDDEN_TOOL_NAMES: Record<string, string> = { "lan-receive": "Local File Transfer" };
type Tab = "library" | "compositions";

export interface LibraryPickerDialogProps extends LibraryPickOptions {
  onAdd: (paths: string[]) => void;
  onClose: () => void;
}

const extOf = (p: string) => {
  const i = p.lastIndexOf(".");
  return i < 0 ? "" : p.slice(i).toLowerCase();
};

/**
 * The last listing shown, per (extensions, search, tool), and the tool lists:
 * opening the dialog again shows them at once while they are listed again.
 */
const lastPages = new Map<string, { items: Output[]; next: string }>();
const lastTools = new Map<string, string[]>();

/** Forgets the remembered listings (tests). */
export function clearLibraryPickerCache(): void {
  lastPages.clear();
  lastTools.clear();
}

function useSeen(ref: React.RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}

const KIND_ICON: Record<string, string> = {
  [OutputKind.KindAudio]: "music",
  [OutputKind.KindVideo]: "film",
  [OutputKind.KindImage]: "image",
  [OutputKind.KindDocument]: "file-text",
};

function OutputThumb({ output }: { output: Output }) {
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useSeen(ref);
  const pictured = output.kind === OutputKind.KindVideo || output.kind === OutputKind.KindImage;
  const kind = output.kind === OutputKind.KindVideo ? "clip" : "photo";
  const [url, setUrl] = useState(() => (pictured ? cachedSourceThumb(output.path, kind, THUMB_DIM) : ""));
  useEffect(() => {
    if (!pictured || !seen || output.missing || cachedSourceThumb(output.path, kind, THUMB_DIM)) return;
    let off = false;
    loadSourceThumb(output.path, kind, THUMB_DIM).then(
      (u) => !off && setUrl(u),
      () => undefined,
    );
    return () => {
      off = true;
    };
  }, [pictured, seen, output.path, output.missing, kind]);
  return (
    <span ref={ref} className={styles.thumb}>
      {url ? <img src={url} alt="" draggable={false} /> : <Icon name={KIND_ICON[output.kind] ?? "file"} size={20} />}
    </span>
  );
}

function CompositionThumb({ project }: { project: ProjectInfo }) {
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useSeen(ref);
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!seen || !project.thumb) return;
    let off = false;
    FilesService.ImageThumb(project.thumb, THUMB_DIM).then(
      (u) => !off && setUrl(u),
      () => undefined,
    );
    return () => {
      off = true;
    };
  }, [seen, project.thumb, project.updatedAt]);
  return (
    <span ref={ref} className={styles.thumb}>
      {url ? <img src={url} alt="" draggable={false} /> : <Icon name="layers" size={20} />}
    </span>
  );
}

const toggle = (set: ReadonlySet<string>, key: string, multiple: boolean): Set<string> => {
  if (!multiple) return set.has(key) ? new Set() : new Set([key]);
  const n = new Set(set);
  if (n.has(key)) n.delete(key);
  else n.add(key);
  return n;
};

export function LibraryPickerDialog({ title, exts: rawExts, multiple = true, have: rawHave, compositions: wantComps, confirmLabel, onAdd, onClose }: LibraryPickerDialogProps) {
  const exts = useMemo(() => normExts(rawExts), [rawExts]);
  const extsKey = exts.join(",");
  const have = useMemo(() => new Set([...(rawHave ?? [])].map(libraryKey)), [rawHave]);
  const showComps = offersCompositions(exts, wantComps);

  const [tab, setTab] = useState<Tab>("library");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Output[]>(() => lastPages.get(`${extsKey}||`)?.items ?? []);
  const [next, setNext] = useState(() => lastPages.get(`${extsKey}||`)?.next ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [files, setFiles] = useState<ReadonlySet<string>>(new Set());
  const [comps, setComps] = useState<ReadonlySet<string>>(new Set());
  const [compositions, setCompositions] = useState<ProjectInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState("");
  const [tools, setTools] = useState<string[]>(() => lastTools.get(extsKey) ?? []);
  const modules = useModules((s) => s.byId);

  // Search as you type, a moment after the last key.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 200);
    return () => clearTimeout(t);
  }, [search]);

  // Saved compositions (pictures only).
  useEffect(() => {
    if (!showComps) return;
    let off = false;
    ComposerService.List().then(
      (list) => !off && setCompositions(list ?? []),
      () => undefined,
    );
    return () => {
      off = true;
    };
  }, [showComps]);

  // The tools that made matching files, for the tool filter (from the newest 500).
  useEffect(() => {
    let off = false;
    LibraryService.Query({ moduleId: "", search: "", kinds: [], exts, since: 0, until: 0, sort: LibrarySort.SortNewest, folder: "", limit: 500, cursor: "" }).then(
      (page) => {
        if (off) return;
        const ids = new Set((page.items ?? []).filter((o) => !o.missing && (exts.length === 0 || exts.includes(extOf(o.path)))).map((o) => o.moduleId));
        const list = [...ids].filter((id) => id !== "");
        lastTools.set(extsKey, list);
        setTools(list);
      },
      () => undefined,
    );
    return () => {
      off = true;
    };
    // exts is memoised on extsKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extsKey]);

  const fetchPage = async (cursor: string): Promise<{ items: Output[]; next: string }> => {
    const page = await LibraryService.Query({ moduleId: tool, search: query, kinds: [], exts, since: 0, until: 0, sort: LibrarySort.SortNewest, folder: "", limit: PAGE, cursor });
    return {
      items: (page.items ?? []).filter((o) => !o.missing && (exts.length === 0 || exts.includes(extOf(o.path)))),
      next: page.nextCursor,
    };
  };

  useEffect(() => {
    let off = false;
    const key = `${extsKey}|${query}|${tool}`;
    const shown = lastPages.get(key);
    if (shown) {
      setItems(shown.items);
      setNext(shown.next);
    }
    setLoading(true);
    fetchPage("").then(
      (p) => {
        if (off) return;
        lastPages.set(key, p);
        while (lastPages.size > 8) {
          const oldest = lastPages.keys().next();
          if (oldest.done) break;
          lastPages.delete(oldest.value);
        }
        setItems(p.items);
        setNext(p.next);
        setError("");
        setLoading(false);
      },
      (e) => {
        if (off) return;
        setItems([]);
        setNext("");
        setError(toAppError(e).message);
        setLoading(false);
      },
    );
    return () => {
      off = true;
    };
    // fetchPage only reads query, tool and exts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, tool, extsKey]);

  const more = async () => {
    setLoading(true);
    try {
      const p = await fetchPage(next);
      setItems((cur) => cur.concat(p.items));
      setNext(p.next);
    } catch (e) {
      toast({ tone: "danger", title: toAppError(e).message });
    } finally {
      setLoading(false);
    }
  };

  const shownComps = useMemo(() => {
    const q = query.toLowerCase();
    return q ? compositions.filter((c) => c.name.toLowerCase().includes(q)) : compositions;
  }, [compositions, query]);

  const count = files.size + comps.size;

  const confirm = async (pickedFiles: ReadonlySet<string> = files, pickedComps: ReadonlySet<string> = comps) => {
    if (pickedFiles.size + pickedComps.size === 0 || busy) return;
    setBusy(true);
    const paths = [...pickedFiles];
    let failed = 0;
    for (const c of compositions.filter((p) => pickedComps.has(p.id))) {
      try {
        const out = await ComposerService.Export(c.id);
        paths.push(out.path);
      } catch (e) {
        failed++;
        const err = toAppError(e);
        toast({
          tone: "danger",
          title: `${c.name}: ${err.message}`,
          description: err.hint || "Open it in Photo Composer and save it once",
        });
      }
    }
    setBusy(false);
    if (paths.length > 0) onAdd(paths);
    if (failed === 0 || paths.length > 0) onClose();
  };

  // Picking one file: choosing a tile replaces the pick (files and compositions alike).
  const pickFile = (path: string) => {
    if (!multiple) setComps(new Set());
    setFiles((s) => toggle(s, path, multiple));
  };
  const pickComp = (id: string) => {
    if (!multiple) setFiles(new Set());
    setComps((s) => toggle(s, id, multiple));
  };

  const toolName = (id: string) => modules[id]?.name ?? HIDDEN_TOOL_NAMES[id] ?? id;
  const toolOptions = [{ value: "", label: "Every tool" }, ...tools.map((id) => ({ value: id, label: toolName(id) })).sort((a, b) => a.label.localeCompare(b.label))];
  const label = busy ? "Adding…" : (confirmLabel ?? (multiple ? (count > 0 ? `Add ${count}` : "Add") : "Use"));
  const pictures = exts.length > 0 && exts.every((e) => PICTURE_EXTS.has(e));

  return (
    <Modal title={title ?? (multiple ? "Add from Library" : "Choose from Library")} confirmLabel={label} confirmDisabled={count === 0 || busy} onConfirm={() => void confirm()} onClose={onClose} wide>
      <div className={styles.bar}>
        {showComps && (
          <SegmentedControl
            size="sm"
            value={tab}
            onChange={setTab}
            aria-label="Show"
            options={[
              { value: "library", label: "Made in Toolbox", tip: "Files any tool saved to the Library" },
              { value: "compositions", label: "Compositions", tip: "Your saved Photo Composer compositions" },
            ]}
          />
        )}
        <TextField
          size="sm"
          icon="search"
          placeholder="Search"
          aria-label="Search the Library"
          data-tip="Type part of a name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          wrapperClassName={styles.search}
        />
        {tab === "library" && <Select size="sm" aria-label="Made with" value={tool} onChange={setTool} options={toolOptions} className={styles.tool} />}
        {loading && <Spinner />}
      </div>

      <div className={styles.pane}>
        {tab === "library" ? (
          error ? (
            <p className={styles.note} role="alert">
              {error}
            </p>
          ) : items.length === 0 && !loading ? (
            <p className={styles.note}>{query || tool ? "Nothing matches." : `No ${pictures ? "pictures" : "files this tool can use"} in the Library yet.`}</p>
          ) : (
            <>
              <ul className={styles.grid} aria-label="Library files">
                {items.map((o) => {
                  const added = have.has(libraryKey(o.path));
                  const on = files.has(o.path);
                  return (
                    <li key={o.id}>
                      <button
                        type="button"
                        className={cx(styles.card, on && styles.on)}
                        aria-pressed={on}
                        disabled={added}
                        title={o.path}
                        data-tip={added ? "Already added" : `Made with ${toolName(o.moduleId)}${multiple ? "" : " (double-click to use it)"}`}
                        onClick={() => pickFile(o.path)}
                        onDoubleClick={() => !multiple && void confirm(new Set([o.path]), new Set())}
                      >
                        <OutputThumb output={o} />
                        <span className={styles.name}>{o.name}</span>
                        <span className={styles.sub}>{added ? "Added" : toolName(o.moduleId)}</span>
                        {on && (
                          <span className={styles.check}>
                            <Icon name="check" size={12} />
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {next && (
                <Button size="sm" variant="ghost" disabled={loading} onClick={() => void more()} data-tip="List older files">
                  Show more
                </Button>
              )}
            </>
          )
        ) : shownComps.length === 0 ? (
          <p className={styles.note}>{query ? "Nothing matches." : "No compositions yet. Make one in Photo Composer."}</p>
        ) : (
          <>
            <p className={styles.note}>Each one is saved as a picture in Library › Compositions and added from there.</p>
            <ul className={styles.grid} aria-label="Compositions">
              {shownComps.map((p) => {
                const on = comps.has(p.id);
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      className={cx(styles.card, on && styles.on)}
                      aria-pressed={on}
                      data-tip={multiple ? "Add this composition's picture" : "Use this composition's picture (double-click to use it)"}
                      onClick={() => pickComp(p.id)}
                      onDoubleClick={() => !multiple && void confirm(new Set(), new Set([p.id]))}
                    >
                      <CompositionThumb project={p} />
                      <span className={styles.name}>{p.name}</span>
                      <span className={styles.sub}>Composition</span>
                      {on && (
                        <span className={styles.check}>
                          <Icon name="check" size={12} />
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}

const PICTURE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".heif"]);
