import { useEffect, useRef, useState } from "react";
import { Banner, Button, IconButton, Spinner, TextField, toast } from "@/components";
import { LibraryService, type Output, type OutputDetail } from "@/lib/api";
import { copyText } from "@/lib/copy";
import { toAppError } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { openTool } from "@/lib/openTool";
import { isNotImplemented } from "@/state/library";
import { FileActions } from "@/tools/_kit/FileActions";
import { BigPreview } from "./BigPreview";
import { baseOf, dirOf, fromOutput, fromPath, isInside, type LibItem } from "./items";
import { ItemThumb } from "./previews/ItemThumb";
import styles from "./Library.module.css";

export interface TrashState {
  available: boolean;
  /** Why Delete is off. */
  reason: string;
}

export interface GoTarget {
  path: string;
  outputId: string;
  /** The output row, when the panel already has it (a generation, a result). */
  output?: Output;
}

export interface DetailPanelProps {
  item: LibItem;
  libraryRoot: string;
  moduleName: (id: string) => string;
  hasTool: (id: string) => boolean;
  trash: TrashState;
  /** F2 pressed in the view: start renaming. */
  renameNonce: number;
  onClose: () => void;
  /** Select another file (made from/into, a generation). */
  onGo: (t: GoTarget) => void;
  onForget: (item: LibItem) => void;
  onTrash: (item: LibItem) => void;
  onRenamed: (o: Output) => void;
}

const MAX_OPTION_ROWS = 12;

/** The job's options as key/value rows (scalars; nested values as short JSON). */
export function optionRows(json: string): [string, string][] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return [];
    return Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== "" && x !== null && x !== undefined)
      .slice(0, MAX_OPTION_ROWS)
      .map(([k, x]) => {
        const s = typeof x === "object" ? JSON.stringify(x) : String(x);
        return [k, s.length > 60 ? `${s.slice(0, 57)}…` : s];
      });
  } catch {
    return [];
  }
}

function fail(e: unknown): void {
  const err = toAppError(e);
  toast({ tone: "danger", title: err.message, description: err.hint });
}

function Thumbs({ children }: { children: React.ReactNode }) {
  return <div className={styles.thumbRow}>{children}</div>;
}

function LinkThumb({ item, label, onClick, current }: { item: LibItem; label: string; onClick: () => void; current?: boolean }) {
  return (
    <button type="button" className={styles.linkThumb} aria-label={label} aria-current={current ? "true" : undefined} data-tip={item.path} onClick={onClick}>
      <span className={styles.linkImg}>
        <ItemThumb item={item} />
      </span>
      <span className={styles.linkName}>{item.name}</span>
    </button>
  );
}

/** Everything about one file: big preview, details, lineage, generations and actions. */
export function DetailPanel({ item, libraryRoot, moduleName, hasTool, trash, renameNonce, onClose, onGo, onForget, onTrash, onRenamed }: DetailPanelProps) {
  const [detail, setDetail] = useState<OutputDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable" | "error">("loading");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.name);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    setState("loading");
    LibraryService.Detail(item.outputId || item.path)
      .then((d) => {
        if (!alive) return;
        setDetail(d);
        setState("ready");
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setDetail(null);
        setState(isNotImplemented(e) ? "unavailable" : "error");
      });
    return () => {
      alive = false;
    };
  }, [item.outputId, item.path, item.name]);

  useEffect(() => {
    setEditing(false);
  }, [item.key]);

  const canRename = item.registered && !item.missing && item.outputId !== "";
  useEffect(() => {
    if (renameNonce > 0 && canRename) {
      setDraft(item.name);
      setEditing(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renameNonce]);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const commitRename = async () => {
    const name = draft.trim();
    if (!name || name === item.name) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      const out = await LibraryService.Rename(item.outputId, name);
      onRenamed(out);
      setEditing(false);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const chain = detail?.chain ?? [];
  const chainAt = Math.min(Math.max(detail?.chainAt ?? 0, 0), Math.max(0, chain.length - 1));
  const madeFrom = detail?.madeFrom ?? [];
  const madeInto = detail?.madeInto ?? [];
  const rows = detail ? optionRows(detail.options) : [];
  const folder = dirOf(item.path);
  const tool = item.moduleId;
  const go = (o: Output) => onGo({ path: o.path, outputId: o.id, output: o });

  return (
    <aside className={styles.detail} aria-label="Details">
      <header className={styles.detailHead}>
        {editing ? (
          <TextField
            ref={input}
            size="sm"
            aria-label="File name"
            value={draft}
            disabled={busy}
            wrapperClassName={styles.renameField}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitRename();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setEditing(false);
              }
            }}
            onBlur={() => void commitRename()}
          />
        ) : (
          <h2 className={styles.detailName} data-tip={item.path}>
            {item.name}
          </h2>
        )}
        {!editing ? (
          <IconButton
            size="sm"
            icon="pencil"
            label="Rename"
            data-tip={canRename ? "Rename this file (F2); it stays in its folder" : "Only files a tool made can be renamed here"}
            data-tip-kbd="F2"
            disabled={!canRename}
            onClick={() => {
              setDraft(item.name);
              setEditing(true);
            }}
          />
        ) : null}
        <IconButton size="sm" icon="x" label="Close details" data-tip="Close the details (Esc)" onClick={onClose} />
      </header>

      <div className={styles.detailBody}>
        <div className={styles.bigBox}>
          <BigPreview item={item} />
        </div>

        <dl className={styles.meta}>
          <dt>Folder</dt>
          <dd>
            <button type="button" className={styles.linkBtn} data-tip={`${folder}\nClick to show it in your file manager`} onClick={() => void LibraryService.RevealPath(item.path).catch(fail)}>
              {baseOf(folder) || folder}
            </button>
          </dd>
          <dt>Size</dt>
          <dd>{item.missing ? "Missing" : formatBytes(item.sizeBytes)}</dd>
          {detail && detail.width > 0 ? (
            <>
              <dt>Dimensions</dt>
              <dd>
                {detail.width} × {detail.height}
              </dd>
            </>
          ) : null}
          {item.at ? (
            <>
              <dt>Created</dt>
              <dd>{new Date(item.at).toLocaleString()}</dd>
            </>
          ) : null}
          <dt>Tool</dt>
          <dd>{tool ? moduleName(tool) : "Not from a job"}</dd>
        </dl>

        {state === "loading" ? (
          <div className={styles.loadingLine}>
            <Spinner />
          </div>
        ) : null}
        {state === "unavailable" ? <Banner tone="info">Settings and lineage aren't available yet in this build.</Banner> : null}
        {state === "error" ? <Banner tone="warn">Couldn't read the details of this file.</Banner> : null}

        {state === "ready" && detail ? (
          <>
            {detail.summary || rows.length > 0 ? (
              <section className={styles.sect} aria-label="Settings">
                <h3 className={styles.sectTitle}>Settings</h3>
                {detail.summary ? <p className={styles.summary}>{detail.summary}</p> : null}
                {!detail.summary && rows.length > 0 ? (
                  <dl className={styles.meta}>
                    {rows.map(([k, v]) => (
                      <div key={k} className={styles.metaRow}>
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </section>
            ) : null}

            <section className={styles.sect} aria-label="Made from">
              <h3 className={styles.sectTitle}>Made from</h3>
              {madeFrom.length === 0 ? (
                <p className={styles.note}>{detail.unknown ? "Origin unknown." : "No inputs recorded."}</p>
              ) : (
                <Thumbs>
                  {madeFrom.map((p) =>
                    isInside(libraryRoot, p) ? (
                      <LinkThumb key={p} item={fromPath(p)} label={`Go to ${baseOf(p)}`} onClick={() => onGo({ path: p, outputId: "" })} />
                    ) : (
                      <div key={p} className={styles.linkThumb}>
                        <span className={styles.linkImg}>
                          <ItemThumb item={fromPath(p)} />
                        </span>
                        <span className={styles.linkName} data-tip={p}>
                          {baseOf(p)}
                        </span>
                        <Button size="sm" variant="ghost" data-tip="Show this input in your file manager" onClick={() => void LibraryService.RevealPath(p).catch(fail)}>
                          Reveal input
                        </Button>
                      </div>
                    ),
                  )}
                </Thumbs>
              )}
            </section>

            {madeInto.length > 0 ? (
              <section className={styles.sect} aria-label="Made into">
                <h3 className={styles.sectTitle}>Made into</h3>
                <Thumbs>
                  {madeInto.map((o) => (
                    <LinkThumb key={o.id} item={fromOutput(o)} label={`Go to ${o.name}`} onClick={() => go(o)} />
                  ))}
                </Thumbs>
              </section>
            ) : null}

            {chain.length > 1 ? (
              <section className={styles.sect} aria-label="Generations">
                <h3 className={styles.sectTitle}>
                  Generations <span className={styles.mono}>{chainAt + 1} of {chain.length}</span>
                </h3>
                <input
                  type="range"
                  className={styles.scrubber}
                  aria-label="Generation"
                  min={0}
                  max={chain.length - 1}
                  step={1}
                  value={chainAt}
                  onChange={(e) => {
                    const o = chain[Number(e.target.value)];
                    if (o) go(o);
                  }}
                />
                <Thumbs>
                  {chain.map((o, i) => (
                    <LinkThumb key={o.id} item={fromOutput(o)} label={`Generation ${i + 1}: ${o.name}`} current={i === chainAt} onClick={() => go(o)} />
                  ))}
                </Thumbs>
                <div className={styles.chainActions}>
                  {hasTool("paint") ? (
                    <Button size="sm" variant="secondary" icon="brush" data-tip="Open this generation in Paint+" onClick={() => void openTool("paint", [item.path])}>
                      Open in Paint+
                    </Button>
                  ) : null}
                  {hasTool("gif") ? (
                    <Button size="sm" variant="secondary" icon="film" data-tip="Make a GIF or a contact sheet from the whole strip" onClick={() => void openTool("gif", chain.map((o) => o.path))}>
                      Export strip as GIF / contact sheet
                    </Button>
                  ) : null}
                </div>
              </section>
            ) : null}
          </>
        ) : null}
      </div>

      <footer className={styles.detailActions} aria-label="Actions">
        <FileActions outputId={item.outputId || undefined} path={item.path} disabled={item.missing} moduleId="library" />
        <IconButton
          size="sm"
          icon="copy"
          label="Copy path"
          data-tip={item.missing ? "The file is missing" : "Copy the full file path to the clipboard"}
          disabled={item.missing}
          onClick={() => void copyText(item.path, { what: "path" })}
        />
        {tool && hasTool(tool) ? (
          <Button size="sm" variant="ghost" icon="external-link" data-tip={`Open this file in ${moduleName(tool)}`} onClick={() => void openTool(tool, [item.path])}>
            Open in {moduleName(tool)}
          </Button>
        ) : null}
        {item.registered ? (
          <Button size="sm" variant="ghost" icon="x" data-tip="Forget this entry (you can undo); the file itself is not deleted" onClick={() => onForget(item)}>
            Forget
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="danger"
          icon="trash-2"
          disabled={!trash.available}
          data-tip={trash.available ? "Move this file to the Recycle Bin (you can restore it from there)" : trash.reason}
          onClick={() => onTrash(item)}
        >
          Delete
        </Button>
      </footer>
    </aside>
  );
}
