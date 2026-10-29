import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { MenuButton, TextArea, TimecodeInput, cx, type MenuItem } from "@/components";
import { formatMs, parseTimecodeMs } from "@/components/media";
import { cueIssues, type CueIssues, type CueRow } from "./logic";
import styles from "./CueList.module.css";

export const ROW_HEIGHT = 128;
/** Above this many cues the list renders only the visible window. */
export const WINDOW_THRESHOLD = 200;
const OVERSCAN = 6;

export type RowAction = "split" | "merge" | "insert" | "delete" | "startAtPlayhead" | "endAtPlayhead";

function TimeField({ value, label, onCommit }: { value: number; label: string; onCommit: (ms: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const commit = (revertIfInvalid: boolean) => {
    if (draft === null) return;
    const ms = parseTimecodeMs(draft);
    if (ms === null) {
      if (revertIfInvalid) {
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

interface RowProps {
  row: CueRow;
  index: number;
  active: boolean;
  last: boolean;
  issues: CueIssues;
  onPatch: (id: string, patch: Partial<Omit<CueRow, "id">>, key?: string) => void;
  onAction: (action: RowAction, id: string) => void;
  onSeek: (ms: number) => void;
  onCaret: (id: string, caret: number) => void;
  onNav: (index: number, dir: 1 | -1) => void;
}

const Row = memo(function Row({ row, index, active, last, issues, onPatch, onAction, onSeek, onCaret, onNav }: RowProps) {
  const items = (): MenuItem[] => [
    { id: "split", label: "Split at cursor", icon: "scissors", onSelect: () => onAction("split", row.id) },
    { id: "merge", label: "Merge with next", icon: "arrow-left-right", disabled: last, onSelect: () => onAction("merge", row.id) },
    { id: "insert", label: "Insert after", icon: "plus", onSelect: () => onAction("insert", row.id) },
    { id: "start", label: "Start at playhead", icon: "skip-back", onSelect: () => onAction("startAtPlayhead", row.id) },
    { id: "end", label: "End at playhead", icon: "skip-forward", onSelect: () => onAction("endAtPlayhead", row.id) },
    { id: "delete", label: "Delete", icon: "trash-2", onSelect: () => onAction("delete", row.id) },
  ];

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      onNav(index, e.key === "ArrowDown" ? 1 : -1);
    } else if (mod && e.key === "Enter") {
      e.preventDefault();
      onCaret(row.id, e.currentTarget.selectionStart);
      onAction("split", row.id);
    }
  };
  const trackCaret = (e: { currentTarget: HTMLTextAreaElement }) => onCaret(row.id, e.currentTarget.selectionStart);
  const durationS = Math.max(0, (row.endMs - row.startMs) / 1000);

  return (
    <div
      className={cx(styles.row, active && styles.active, issues.errors.length > 0 && styles.bad)}
      style={{ height: ROW_HEIGHT }}
      data-active={active || undefined}
      data-testid="cue-row"
      onClick={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.seek !== undefined) onSeek(row.startMs);
      }}
    >
      <div className={styles.head} data-seek="">
        <span className={styles.index} data-seek="">
          {index + 1}
        </span>
        <TimeField value={row.startMs} label={`Subtitle ${index + 1} start`} onCommit={(ms) => onPatch(row.id, { startMs: ms }, `start:${row.id}`)} />
        <span className={styles.arrow} aria-hidden data-seek="">
          →
        </span>
        <TimeField value={row.endMs} label={`Subtitle ${index + 1} end`} onCommit={(ms) => onPatch(row.id, { endMs: ms }, `end:${row.id}`)} />
        <span className={styles.dur} data-seek="">
          {durationS.toFixed(1)} s
        </span>
        <span className={styles.menu}>
          <MenuButton label={`Subtitle ${index + 1} actions`} icon="chevron-down" variant="ghost" size="sm" items={items} />
        </span>
      </div>
      <TextArea
        aria-label={`Subtitle ${index + 1} text`}
        data-cue-text={row.id}
        className={styles.text}
        minRows={2}
        maxRows={2}
        value={row.text}
        invalid={issues.errors.length > 0}
        onChange={(e) => onPatch(row.id, { text: e.target.value }, `text:${row.id}`)}
        onKeyDown={onKeyDown}
        onSelect={trackCaret}
        onClick={trackCaret}
        onKeyUp={trackCaret}
      />
      <div className={styles.notes}>
        {issues.errors.map((m) => (
          <span key={m} className={styles.error}>
            {m}
          </span>
        ))}
        {issues.warnings.map((m) => (
          <span key={m} className={styles.warn}>
            {m}
          </span>
        ))}
      </div>
    </div>
  );
});

export interface CueListProps {
  rows: CueRow[];
  activeIndex: number;
  playing: boolean;
  maxLine: number;
  onPatch: RowProps["onPatch"];
  /** `caret` is the last known text position in the cue (or -1). */
  onAction: (action: RowAction, id: string, caret: number) => void;
  onSeek: (ms: number) => void;
  /** Focus this cue's text next time it is rendered (after an insert). */
  focusId?: string;
  onFocused?: () => void;
}

/** The cue list: fixed-height rows, windowed above WINDOW_THRESHOLD cues. */
export function CueList({ rows, activeIndex, playing, maxLine, onPatch, onAction, onSeek, focusId, onFocused }: CueListProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const carets = useRef(new Map<string, number>());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(640);
  const [pendingFocus, setPendingFocus] = useState<string | undefined>(undefined);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewH(el.clientHeight || 640);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const windowed = rows.length > WINDOW_THRESHOLD;
  const first = windowed ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0;
  const last = windowed ? Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_HEIGHT) + OVERSCAN) : rows.length;

  const issues = useMemo(() => {
    const out = new Map<number, CueIssues>();
    for (let i = first; i < last; i++) out.set(i, cueIssues(rows, i, maxLine));
    return out;
  }, [rows, first, last, maxLine]);

  // Keep the playing cue in view.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !playing || activeIndex < 0) return;
    const top = activeIndex * ROW_HEIGHT;
    if (top < el.scrollTop || top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 3);
    }
  }, [activeIndex, playing]);

  const scrollToRow = useCallback((index: number) => {
    const el = scroller.current;
    if (!el) return;
    const top = index * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
    setScrollTop(el.scrollTop);
  }, []);

  useEffect(() => {
    if (focusId) {
      const idx = rows.findIndex((r) => r.id === focusId);
      if (idx >= 0) scrollToRow(idx);
      setPendingFocus(focusId);
      onFocused?.();
    }
  }, [focusId, rows, scrollToRow, onFocused]);

  useEffect(() => {
    if (!pendingFocus) return;
    const ta = scroller.current?.querySelector<HTMLTextAreaElement>(`[data-cue-text="${pendingFocus}"]`);
    if (ta) {
      ta.focus();
      setPendingFocus(undefined);
    }
  }, [pendingFocus, rows, first, last]);

  const onCaret = useCallback((id: string, caret: number) => {
    carets.current.set(id, caret);
  }, []);
  const handleAction = useCallback(
    (action: RowAction, id: string) => onAction(action, id, carets.current.get(id) ?? -1),
    [onAction],
  );
  const onNav = useCallback(
    (index: number, dir: 1 | -1) => {
      const target = rows[index + dir];
      if (!target) return;
      onSeek(target.startMs);
      scrollToRow(index + dir);
      setPendingFocus(target.id);
    },
    [rows, onSeek, scrollToRow],
  );

  return (
    <div
      ref={scroller}
      className={styles.list}
      role="list"
      aria-label="Subtitles"
      onScroll={(e) => windowed && setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: first * ROW_HEIGHT }} aria-hidden />
      {rows.slice(first, last).map((row, k) => {
        const i = first + k;
        return (
          <div role="listitem" key={row.id}>
            <Row
              row={row}
              index={i}
              active={i === activeIndex}
              last={i === rows.length - 1}
              issues={issues.get(i) ?? { errors: [], warnings: [] }}
              onPatch={onPatch}
              onAction={handleAction}
              onSeek={onSeek}
              onCaret={onCaret}
              onNav={onNav}
            />
          </div>
        );
      })}
      <div style={{ height: (rows.length - last) * ROW_HEIGHT }} aria-hidden />
    </div>
  );
}
