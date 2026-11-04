/**
 * The caption word list (§14.9, the Subtitles CueList pattern): one row per
 * line inside the song range with start/end (timeline ms), text and a menu;
 * a row expands to its words. Windowed for long songs.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconButton, MenuButton, TextField, TimecodeInput, cx, type MenuItem } from "@/components";
import { formatMs, parseTimecodeMs } from "@/components/media";
import type { TextLine } from "@/viz/analysis";
import styles from "./WordList.module.css";

export const ROW_HEIGHT = 84;
export const WORD_HEIGHT = 34;
const WORDS_PAD = 12;
/** Above this many rows only the visible window is rendered. */
export const WINDOW_THRESHOLD = 60;
const OVERSCAN = 4;

export type RowAction = "split" | "merge" | "insert" | "delete" | "startAtPlayhead" | "endAtPlayhead";

export interface WordListRow {
  /** Index in the full lines array. */
  index: number;
  line: TextLine;
}

function TimeField({ value, label, tip, onCommit }: { value: number; label: string; tip: string; onCommit: (ms: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const commit = (revert: boolean) => {
    if (draft === null) return;
    const ms = parseTimecodeMs(draft);
    if (ms === null) {
      if (revert) {
        setDraft(null);
        setInvalid(false);
      } else setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(null);
    if (ms !== value) onCommit(ms);
  };
  return (
    <TimecodeInput
      aria-label={label}
      data-tip={tip}
      className={styles.time}
      value={draft ?? formatMs(value)}
      invalid={invalid}
      onChange={(v) => {
        setDraft(v);
        setInvalid(false);
      }}
      onBlur={() => commit(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit(false);
        } else if (e.key === "Escape") {
          setDraft(null);
          setInvalid(false);
        }
      }}
    />
  );
}

export interface WordListHandlers {
  onText(index: number, text: string): void;
  onTime(index: number, t: { startMs?: number; endMs?: number }): void;
  onWordText(index: number, word: number, text: string): void;
  onWordTime(index: number, word: number, t: { startMs?: number; endMs?: number }): void;
  /** `caret` is the last known text position (or -1). */
  onAction(action: RowAction, index: number, caret: number): void;
  onSeek(timelineMs: number): void;
}

interface RowProps extends WordListHandlers {
  row: WordListRow;
  n: number;
  /** song start: timeline ms = song ms - offset */
  offset: number;
  active: boolean;
  last: boolean;
  open: boolean;
  onToggle(index: number): void;
  onCaret(index: number, caret: number): void;
}

const Row = memo(function Row({ row, n, offset, active, last, open, onToggle, onCaret, onText, onTime, onWordText, onWordTime, onAction, onSeek }: RowProps) {
  const { index, line } = row;
  const tl = (songMs: number) => Math.max(0, songMs - offset);
  const items = (): MenuItem[] => [
    { id: "split", label: "Split at cursor", icon: "scissors", tip: "Cut this line in two where the text cursor is (Ctrl+Enter in the text)", onSelect: () => onAction("split", index, -1) },
    { id: "merge", label: "Merge with next", icon: "arrow-left-right", tip: last ? "This is the last line" : "Join this line and the next one into one line", disabled: last, onSelect: () => onAction("merge", index, -1) },
    { id: "insert", label: "Insert after", icon: "plus", tip: "Add an empty line after this one", onSelect: () => onAction("insert", index, -1) },
    { id: "start", label: "Start at playhead", icon: "skip-back", tip: "Make this line appear at the playhead", onSelect: () => onAction("startAtPlayhead", index, -1) },
    { id: "end", label: "End at playhead", icon: "skip-forward", tip: "Make this line disappear at the playhead", onSelect: () => onAction("endAtPlayhead", index, -1) },
    { id: "delete", label: "Delete", icon: "trash-2", tip: "Remove this line from the captions", onSelect: () => onAction("delete", index, -1) },
  ];
  const caret = (e: { currentTarget: HTMLInputElement }) => onCaret(index, e.currentTarget.selectionStart ?? -1);
  return (
    <div className={cx(styles.row, active && styles.active)} data-testid="caption-row" data-active={active || undefined}>
      <div className={styles.main} style={{ height: ROW_HEIGHT }}>
        <div className={styles.head}>
          <IconButton size="sm" variant="ghost" icon={open ? "chevron-down" : "chevron-right"} label={open ? `Hide words of line ${n}` : `Show words of line ${n}`} data-tip={open ? "Hide the individual words of this line" : "Show each word of this line to fix its text and timing"} onClick={() => onToggle(index)} />
          <span className={styles.index} data-tip="Line number">{n}</span>
          <TimeField value={tl(line.startMs)} label={`Line ${n} start`} tip="When this line appears (minutes:seconds); type a new time and press Enter" onCommit={(ms) => onTime(index, { startMs: ms + offset })} />
          <span className={styles.arrow} aria-hidden data-tip="From start to end">
            →
          </span>
          <TimeField value={tl(line.endMs)} label={`Line ${n} end`} tip="When this line disappears (minutes:seconds); type a new time and press Enter" onCommit={(ms) => onTime(index, { endMs: ms + offset })} />
          <span className={styles.menu}>
            <MenuButton data-tip="Split, merge, insert, set times from the playhead or delete this line" label={`Line ${n} actions`} icon="chevron-down" variant="ghost" size="sm" items={items} />
          </span>
        </div>
        <TextField
          size="sm"
          aria-label={`Line ${n} text`}
          data-tip="The words shown for this line; clicking jumps the playhead to it"
          data-line-text={index}
          value={line.text}
          onChange={(e) => onText(index, e.target.value)}
          onFocus={() => onSeek(tl(line.startMs))}
          onSelect={caret}
          onClick={caret}
          onKeyUp={caret}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              onAction("split", index, e.currentTarget.selectionStart ?? -1);
            }
          }}
        />
      </div>
      {open && (
        <div className={styles.words} style={{ height: wordsHeight(line) }}>
          {line.words.length === 0 && <span className={styles.none} data-tip="Words without timing can't be shown one by one">No word times for this line.</span>}
          {line.words.map((w, k) => (
            <div key={k} className={styles.word} style={{ height: WORD_HEIGHT }}>
              <TextField size="sm" data-tip="The text of this word" aria-label={`Line ${n} word ${k + 1}`} value={w.text} onChange={(e) => onWordText(index, k, e.target.value)} />
              <TimeField value={tl(w.startMs)} label={`Line ${n} word ${k + 1} start`} tip="When this word starts being sung (minutes:seconds)" onCommit={(ms) => onWordTime(index, k, { startMs: ms + offset })} />
              <TimeField value={tl(w.endMs)} label={`Line ${n} word ${k + 1} end`} tip="When this word ends (minutes:seconds)" onCommit={(ms) => onWordTime(index, k, { endMs: ms + offset })} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

/** Height of the expanded words block. */
export function wordsHeight(line: TextLine): number {
  return Math.max(1, line.words.length) * WORD_HEIGHT + WORDS_PAD;
}

export interface WordListProps extends WordListHandlers {
  rows: WordListRow[];
  offset: number;
  /** Timeline ms of the playhead (the row it falls in is highlighted). */
  playheadMs: number;
  /** Index (in the full array) to focus next time it renders. */
  focusIndex?: number;
  onFocused?(): void;
}

export function WordList({ rows, offset, playheadMs, focusIndex, onFocused, ...h }: WordListProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const carets = useRef(new Map<number, number>());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(360);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewH(el.clientHeight || 360);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const windowed = rows.length > WINDOW_THRESHOLD;
  const openRow = openIndex === null ? -1 : rows.findIndex((r) => r.index === openIndex);
  const extra = openRow >= 0 ? wordsHeight((rows[openRow] as WordListRow).line) : 0;
  // Row positions assume ROW_HEIGHT each, plus the open row's word block.
  const topOf = (i: number) => i * ROW_HEIGHT + (openRow >= 0 && i > openRow ? extra : 0);
  let first = 0;
  let last = rows.length;
  if (windowed) {
    first = 0;
    while (first < rows.length - 1 && topOf(first + 1) <= scrollTop) first++;
    first = Math.max(0, first - OVERSCAN);
    last = first;
    while (last < rows.length && topOf(last) < scrollTop + viewH) last++;
    last = Math.min(rows.length, last + OVERSCAN);
  }
  const total = rows.length * ROW_HEIGHT + extra;
  const before = first === 0 ? 0 : topOf(first);
  const after = last >= rows.length ? 0 : total - topOf(last);

  useEffect(() => {
    if (focusIndex === undefined) return;
    const pos = rows.findIndex((r) => r.index === focusIndex);
    const el = scroller.current;
    if (pos >= 0 && el) {
      const top = topOf(pos);
      if (top < el.scrollTop || top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - ROW_HEIGHT);
      setScrollTop(el.scrollTop);
    }
    // Focus after the row is in the DOM.
    const t = setTimeout(() => {
      scroller.current?.querySelector<HTMLInputElement>(`[data-line-text="${focusIndex}"]`)?.focus();
    }, 0);
    onFocused?.();
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusIndex]);

  const song = playheadMs + offset;
  return (
    <div ref={scroller} className={styles.list} role="list" aria-label="Caption lines" onScroll={(e) => windowed && setScrollTop(e.currentTarget.scrollTop)}>
      <div style={{ height: before }} aria-hidden />
      {rows.slice(first, last).map((r, k) => (
        <div role="listitem" key={r.index}>
          <Row
            row={r}
            n={first + k + 1}
            offset={offset}
            active={song >= r.line.startMs && song < r.line.endMs}
            last={first + k === rows.length - 1}
            open={openIndex === r.index}
            onToggle={(i) => setOpenIndex((cur) => (cur === i ? null : i))}
            onCaret={(i, c) => carets.current.set(i, c)}
            {...h}
            onAction={(a, i, c) => h.onAction(a, i, c >= 0 ? c : (carets.current.get(i) ?? -1))}
          />
        </div>
      ))}
      <div style={{ height: after }} aria-hidden />
    </div>
  );
}
