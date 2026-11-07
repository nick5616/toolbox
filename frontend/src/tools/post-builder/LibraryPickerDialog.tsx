import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Icon, SegmentedControl, Select, Spinner, TextField, cx, toast } from "@/components";
import { ComposerService, LibraryService, LibrarySort, OutputKind, type Output, type ProjectInfo } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useModules } from "@/state/modules";
import { loadSourceThumb } from "@/blocks/sources/sourceThumbs";
import { Modal } from "./Modal";
import { ProjectThumb } from "./ProjectThumb";
import styles from "./LibraryPickerDialog.module.css";

// Sources → From Library…: pictures and videos Toolbox already made (Library
// outputs of any tool) and saved Photo Composer compositions, added to the
// post's pool as extras. A composition is exported into Library › Compositions
// first, so the source is a real file the user can find again.

const PAGE = 200;

/** Hidden modules that write Library files, by the tool the user knows them as. */
const HIDDEN_TOOL_NAMES: Record<string, string> = { "lan-receive": "Local File Transfer" };
type Tab = "library" | "compositions";

export interface LibraryPickerDialogProps {
  /** Extensions the pool accepts (lowercase, with the dot). */
  exts: readonly string[];
  /** Paths already in the pool (shown as added). */
  have: ReadonlySet<string>;
  compositions: ProjectInfo[];
  onAdd: (paths: string[]) => void;
  onClose: () => void;
}

const extOf = (p: string) => {
  const i = p.lastIndexOf(".");
  return i < 0 ? "" : p.slice(i).toLowerCase();
};

/** The key a path is compared by (Windows paths are case-insensitive). */
export const poolKey = (p: string) => p.replace(/\//g, "\\").toLowerCase();

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

function OutputThumb({ output }: { output: Output }) {
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useSeen(ref);
  const [url, setUrl] = useState("");
  const kind = output.kind === OutputKind.KindVideo ? "clip" : "photo";
  useEffect(() => {
    if (!seen || output.missing) return;
    let off = false;
    loadSourceThumb(output.path, kind, 256).then(
      (u) => !off && setUrl(u),
      () => undefined,
    );
    return () => {
      off = true;
    };
  }, [seen, output.path, output.missing, kind]);
  return (
    <span ref={ref} className={styles.thumb}>
      {url ? <img src={url} alt="" draggable={false} /> : <Icon name={kind === "clip" ? "film" : "image"} size={20} />}
    </span>
  );
}

export function LibraryPickerDialog({ exts, have, compositions, onAdd, onClose }: LibraryPickerDialogProps) {
  const [tab, setTab] = useState<Tab>("library");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Output[]>([]);
  const [next, setNext] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [files, setFiles] = useState<ReadonlySet<string>>(new Set());
  const [comps, setComps] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const modules = useModules((s) => s.byId);

  // Search as you type, a moment after the last key.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 200);
    return () => clearTimeout(t);
  }, [search]);

  // The tools that made pictures or videos, for the tool filter (from the newest 500).
  useEffect(() => {
    let off = false;
    LibraryService.Query({ moduleId: "", search: "", kinds: [OutputKind.KindImage, OutputKind.KindVideo], since: 0, until: 0, sort: LibrarySort.SortNewest, folder: "", limit: 500, cursor: "" }).then(
      (page) => {
        if (off) return;
        const ids = new Set((page.items ?? []).filter((o) => !o.missing && exts.includes(extOf(o.path))).map((o) => o.moduleId));
        setTools([...ids].filter((id) => id !== ""));
      },
      () => undefined,
    );
    return () => {
      off = true;
    };
  }, [exts]);

  const fetchPage = async (cursor: string): Promise<{ items: Output[]; next: string }> => {
    const page = await LibraryService.Query({
      moduleId: tool,
      search: query,
      kinds: [OutputKind.KindImage, OutputKind.KindVideo],
      since: 0,
      until: 0,
      sort: LibrarySort.SortNewest,
      folder: "",
      limit: PAGE,
      cursor,
    });
    return {
      items: (page.items ?? []).filter((o) => !o.missing && exts.includes(extOf(o.path))),
      next: page.nextCursor,
    };
  };

  useEffect(() => {
    let off = false;
    setLoading(true);
    fetchPage("").then(
      (p) => {
        if (off) return;
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
  }, [query, tool]);

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

  const toggle = (set: ReadonlySet<string>, key: string): Set<string> => {
    const n = new Set(set);
    if (n.has(key)) n.delete(key);
    else n.add(key);
    return n;
  };

  const count = files.size + comps.size;

  const confirm = async () => {
    if (count === 0 || busy) return;
    setBusy(true);
    const paths = [...files];
    let failed = 0;
    for (const c of compositions.filter((p) => comps.has(p.id))) {
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

  const toolName = (id: string) => modules[id]?.name ?? HIDDEN_TOOL_NAMES[id] ?? id;
  const toolOptions = [{ value: "", label: "Every tool" }, ...tools.map((id) => ({ value: id, label: toolName(id) })).sort((a, b) => a.label.localeCompare(b.label))];

  return (
    <Modal
      title="Add from Library"
      confirmLabel={busy ? "Adding…" : count > 0 ? `Add ${count} to sources` : "Add to sources"}
      confirmDisabled={count === 0 || busy}
      onConfirm={() => void confirm()}
      onClose={onClose}
      wide
    >
      <div className={styles.bar}>
        <SegmentedControl
          size="sm"
          value={tab}
          onChange={setTab}
          aria-label="Show"
          options={[
            {
              value: "library",
              label: "Made in Toolbox",
              tip: "Pictures and videos any tool saved to the Library",
            },
            {
              value: "compositions",
              label: "Compositions",
              tip: "Your saved Photo Composer compositions",
            },
          ]}
        />
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
            <p className={styles.note}>{query || tool ? "Nothing matches." : "No pictures or videos in the Library yet."}</p>
          ) : (
            <>
              <ul className={styles.grid} aria-label="Library pictures and videos">
                {items.map((o) => {
                  const added = have.has(poolKey(o.path));
                  const on = files.has(o.path);
                  return (
                    <li key={o.id}>
                      <button
                        type="button"
                        className={cx(styles.card, on && styles.on)}
                        aria-pressed={on}
                        disabled={added}
                        title={o.path}
                        data-tip={added ? "Already in this post's sources" : `Made with ${toolName(o.moduleId)}`}
                        onClick={() => setFiles((s) => toggle(s, o.path))}
                      >
                        <OutputThumb output={o} />
                        <span className={styles.name}>{o.name}</span>
                        <span className={styles.sub}>{added ? "In sources" : toolName(o.moduleId)}</span>
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
                <Button size="sm" variant="ghost" disabled={loading} onClick={() => void more()} data-tip="List older pictures and videos">
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
                      data-tip="Add this composition's picture to the sources"
                      onClick={() => setComps((s) => toggle(s, p.id))}
                    >
                      <ProjectThumb project={p} className={styles.thumb} />
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
