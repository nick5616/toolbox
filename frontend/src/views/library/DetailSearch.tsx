import { useEffect, useMemo, useState } from "react";
import { Button, Icon, TextField, toast } from "@/components";
import { SearchService, type LabelCount, type MediaLabel, type MediaText } from "@/lib/api";
import { copyText } from "@/lib/copy";
import { toAppError } from "@/lib/errors";
import { openTool } from "@/lib/openTool";
import { useSearch } from "@/state/search";
import { extOf, previewKind, type LibItem } from "./items";
import { SOURCE_TITLES, formatMoment, highlightParts, textBlock } from "./searchHits";
import styles from "./Search.module.css";

/** How many auto labels "In this picture" shows (the user's own always show). */
export const MAX_AUTO_LABELS = 8;
export const MAX_LABEL_LENGTH = 40;

function fail(e: unknown): void {
  const err = toAppError(e);
  toast({ tone: "danger", title: err.message, description: err.hint });
}

/** The labels to show: your own first, then the strongest auto ones (≤ 8). Hidden labels never show. */
export function visibleLabels(labels: readonly MediaLabel[]): MediaLabel[] {
  const user = labels.filter((l) => l.source === "user");
  const auto = labels
    .filter((l) => l.source === "auto")
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_AUTO_LABELS);
  return [...user, ...auto];
}

/** Completions for "+ Label": the vocabulary and your own labels that start with (or contain) what was typed. */
export function completions(typed: string, things: readonly LabelCount[], have: readonly MediaLabel[]): LabelCount[] {
  const q = typed.trim().toLowerCase();
  if (!q) return [];
  const taken = new Set(have.map((l) => l.label));
  return things
    .filter((l) => !taken.has(l.label) && l.display.toLowerCase().includes(q))
    .sort((a, b) => Number(b.display.toLowerCase().startsWith(q)) - Number(a.display.toLowerCase().startsWith(q)) || Number(b.user) - Number(a.user) || b.count - a.count)
    .slice(0, 6);
}

function AddLabel({ path, have }: { path: string; have: readonly MediaLabel[] }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const things = useSearch((s) => s.things);
  useEffect(() => {
    if (open && things === null) void useSearch.getState().loadThings().catch(() => undefined);
  }, [open, things]);
  const options = useMemo(() => completions(text, things ?? [], have), [text, things, have]);
  const add = (label: string) => {
    const v = label.trim().slice(0, MAX_LABEL_LENGTH);
    if (!v) return;
    // Typing a vocabulary word's display name uses the vocabulary label, so it is the same label everywhere.
    const known = (things ?? []).find((l) => !l.user && l.display.toLowerCase() === v.toLowerCase());
    useSearch
      .getState()
      .setLabel(path, known ? known.label : v, true)
      .then(() => {
        setText("");
        setOpen(false);
      })
      .catch(fail);
  };
  if (!open) {
    return (
      <Button size="sm" variant="ghost" icon="plus" data-tip="Add a label of your own to this file" onClick={() => setOpen(true)}>
        Label
      </Button>
    );
  }
  return (
    <div className={styles.addLabel}>
      <TextField
        size="sm"
        autoFocus
        aria-label="New label"
        placeholder="Add a label"
        maxLength={MAX_LABEL_LENGTH}
        value={text}
        data-tip="Type a label and press Enter. Up to 40 characters"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(text);
          } else if (e.key === "Escape") {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {options.length > 0 ? (
        <div className={styles.completions} role="listbox" aria-label="Label suggestions">
          {options.map((o) => (
            <button key={`${o.user ? "u" : "v"}:${o.label}`} type="button" role="option" aria-selected={false} className={styles.chip} data-tip={o.user ? "One of your labels" : "A label Toolbox knows"} onClick={() => add(o.label)}>
              {o.user ? <span className={styles.chipDot} aria-hidden="true" /> : null}
              {o.display}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** "In this picture": up to 8 labels, strongest first; × hides one, a click filters by it, "+ Label" adds your own. */
export function InThisPicture({ item, onFilter }: { item: LibItem; onFilter: (label: string) => void }) {
  const version = useSearch((s) => s.indexedVersion);
  const cached = useSearch((s) => s.labelCache[item.path]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    void useSearch.getState().loadLabels(item.path).catch(() => setFailed(true));
  }, [item.path, version]);
  const labels = useMemo(() => visibleLabels(cached ?? []), [cached]);
  return (
    <section className={styles.chipSection} aria-label="In this picture">
      <h3 className={styles.sectTitleLocal}>In this picture</h3>
      <div className={styles.chipWrap}>
        {labels.map((l) => (
          <span key={`${l.source}:${l.label}`} className={styles.labelChip}>
            <button
              type="button"
              className={styles.labelBtn}
              data-tip={l.source === "user" ? `${l.display}: your label. Click to show every file with it` : `${l.display}: ${Math.round(l.score * 100)}% sure. Click to show every file with it`}
              onClick={() => onFilter(l.label)}
            >
              {l.source === "user" ? <span className={styles.chipDot} aria-hidden="true" data-testid="user-dot" /> : null}
              {l.display}
            </button>
            <button
              type="button"
              className={styles.labelX}
              aria-label={`Remove label ${l.display}`}
              data-tip={l.source === "user" ? "Remove your label" : "This isn't in the picture: hide this label for good"}
              onClick={() => void useSearch.getState().setLabel(item.path, l.label, false).catch(fail)}
            >
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        {cached && labels.length === 0 && !failed ? <span className={styles.srcLabel}>No labels yet</span> : null}
        <AddLabel path={item.path} have={cached ?? []} />
      </div>
    </section>
  );
}

/** The `[m:ss]` / `p. N` that says where a chunk came from. */
export function chunkPrefix(c: MediaText, kind: string, ext: string): string {
  if (c.pos < 0) return "";
  if (c.source === "speech" || c.source === "subs" || (c.source === "ocr" && kind === "video")) return `[${formatMoment(c.pos)}]`;
  if (ext === "pdf" || ext === "pptx" || ext === "odp" || c.source === "pdf") return `p. ${c.pos + 1}`;
  return "";
}

function Line({ prefix, text, query, onClick }: { prefix: string; text: string; query: string; onClick?: () => void }) {
  const body = (
    <>
      {prefix ? <span className={styles.stamp}>{prefix}</span> : null}
      {highlightParts(text, query).map((p, i) => (p.bold ? <mark key={i} className={styles.mark}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  );
  return onClick ? (
    <button type="button" className={styles.line} data-tip="Jump there" onClick={onClick}>
      {body}
    </button>
  ) : (
    <span className={styles.line}>{body}</span>
  );
}

const GROUP_ORDER = ["speech", "subs", "ocr", "pdf", "doc"];

/** "Text in this file", grouped by where it was found, with Copy, Save and "Read again". */
export function TextInFile({ item, query, onSeek }: { item: LibItem; query: string; onSeek: (pos: number) => void }) {
  const version = useSearch((s) => s.indexedVersion);
  const cached = useSearch((s) => s.textCache[item.path]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void useSearch.getState().loadTexts(item.path).catch(() => undefined);
  }, [item.path, version]);
  const kind = previewKind(item);
  const ext = extOf(item.path);
  const texts = useMemo(() => (cached ?? []).filter((t) => t.source !== "caption"), [cached]);
  const groups = useMemo(() => {
    const m = new Map<string, MediaText[]>();
    for (const t of texts) {
      const a = m.get(t.source);
      if (a) a.push(t);
      else m.set(t.source, [t]);
    }
    return [...m.entries()].sort((a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0]));
  }, [texts]);
  const hasSpeech = groups.some(([s]) => s === "speech" || s === "subs");
  const seekable = (c: MediaText): boolean => c.pos >= 0 && (kind === "video" || kind === "audio" || kind === "pdf");

  const saveAs = async (format: "txt" | "srt") => {
    setBusy(true);
    try {
      const dst = await SearchService.SaveText(item.path, format);
      if (dst) toast({ tone: "success", title: `Saved ${dst}` });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const readAgain = async () => {
    setBusy(true);
    try {
      await SearchService.ReadAgain(item.path);
      toast({ title: "Reading this file again", description: "New text appears here when it's done." });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const all = groups.map(([s, cs]) => textBlock(cs, s === "speech" || s === "subs")).join("\n\n");
  return (
    <section className={styles.chipSection} aria-label="Text in this file">
      <h3 className={styles.sectTitleLocal}>Text in this file</h3>
      {texts.length === 0 ? (
        <p className={styles.srcLabel}>{cached ? "No text found in this file." : "Looking…"}</p>
      ) : (
        <div className={styles.textBox} tabIndex={0} role="region" aria-label="Found text" data-testid="found-text">
          {groups.map(([source, chunks]) => (
            <div key={source}>
              <p className={styles.srcLabel}>{SOURCE_TITLES[source] ?? source}</p>
              {chunks.map((c, i) => (
                <Line key={`${c.pos}:${i}`} prefix={chunkPrefix(c, kind, ext)} text={c.text} query={query} onClick={seekable(c) ? () => onSeek(c.pos) : undefined} />
              ))}
            </div>
          ))}
        </div>
      )}
      <div className={styles.actionRow}>
        <Button size="sm" variant="secondary" icon="copy" disabled={texts.length === 0} data-tip={texts.length === 0 ? "There is no text to copy" : "Copy all the text of this file"} onClick={() => void copyText(all, { what: "text" })}>
          Copy
        </Button>
        <Button size="sm" variant="secondary" icon="download" disabled={texts.length === 0 || busy} data-tip={texts.length === 0 ? "There is no text to save" : "Save the text as a .txt file"} onClick={() => void saveAs("txt")}>
          Save as .txt…
        </Button>
        {hasSpeech ? (
          <Button size="sm" variant="secondary" icon="captions" disabled={busy} data-tip="Save what is said as subtitles (.srt)" onClick={() => void saveAs("srt")}>
            Save as .srt…
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" icon="rotate-cw" disabled={busy} data-tip="Read the pictures or listen to the speech of this file again" onClick={() => void readAgain()}>
          Read again
        </Button>
      </div>
    </section>
  );
}

/** The caption Caption Writer wrote, when there is one. */
export function CaptionSection({ item }: { item: LibItem }) {
  const version = useSearch((s) => s.indexedVersion);
  const cached = useSearch((s) => s.textCache[item.path]);
  useEffect(() => {
    void useSearch.getState().loadTexts(item.path).catch(() => undefined);
  }, [item.path, version]);
  const caps = (cached ?? []).filter((t) => t.source === "caption");
  if (caps.length === 0) return null;
  return (
    <section className={styles.chipSection} aria-label="Caption">
      <h3 className={styles.sectTitleLocal}>Caption</h3>
      {caps.map((c, i) => (
        <p key={i} className={styles.caption}>
          {c.text}
        </p>
      ))}
      <div className={styles.actionRow}>
        <Button size="sm" variant="secondary" icon="captions" data-tip="Open this file in Caption Writer to change the caption" onClick={() => void openTool("captions", [item.path])}>
          Open in Caption Writer
        </Button>
      </div>
    </section>
  );
}
