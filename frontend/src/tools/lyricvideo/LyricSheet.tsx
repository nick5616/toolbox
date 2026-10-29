import { memo, useEffect, useRef, useState } from "react";
import { IconButton, TextField, TimecodeInput, cx } from "@/components";
import { formatMs, parseTimecodeMs } from "@/components/media";
import type { Row } from "./logic";
import styles from "./LyricVideoView.module.css";

export const ROW_HEIGHT = 48;
/** Above this many lines only the visible window is rendered. */
export const WINDOW_THRESHOLD = 150;
const OVERSCAN = 8;
const FALLBACK_VIEWPORT = 480;
export const NUDGE_MS = 100;

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
  row: Row;
  index: number;
  active: boolean;
  selected: boolean;
  tapNext: boolean;
  outOfOrder: boolean;
  suspect: boolean;
  onSelect: (id: string) => void;
  onStart: (id: string, ms: number) => void;
  onNudge: (id: string, deltaMs: number) => void;
  onText: (id: string, text: string) => void;
  onPlay: (ms: number) => void;
}

const SheetRow = memo(function SheetRow({ row, index, active, selected, tapNext, outOfOrder, suspect, onSelect, onStart, onNudge, onText, onPlay }: RowProps) {
  const n = index + 1;
  return (
    <div
      role="listitem"
      data-testid="lyric-row"
      data-active={active || undefined}
      data-suspect={suspect || undefined}
      className={cx(styles.sheetRow, active && styles.rowActive, selected && styles.rowSelected, tapNext && styles.rowTap, suspect && styles.rowSuspect)}
      style={{ height: ROW_HEIGHT }}
      onFocus={() => onSelect(row.id)}
      onClick={() => onSelect(row.id)}
    >
      <span className={styles.rowNum}>{n}</span>
      <TimeField value={row.startMs} label={`Line ${n} start`} onCommit={(ms) => onStart(row.id, ms)} />
      <TextField
        size="sm"
        wrapperClassName={styles.rowText}
        aria-label={`Line ${n} text`}
        value={row.text}
        placeholder="(empty line)"
        invalid={outOfOrder}
        onChange={(e) => onText(row.id, e.target.value)}
      />
      <IconButton size="sm" icon="minus" label={`Line ${n} 0.1 s earlier`} onClick={() => onNudge(row.id, -NUDGE_MS)} />
      <IconButton size="sm" icon="plus" label={`Line ${n} 0.1 s later`} onClick={() => onNudge(row.id, NUDGE_MS)} />
      <IconButton size="sm" icon="play" label={`Play from line ${n}`} onClick={() => onPlay(row.startMs)} />
    </div>
  );
});

export interface LyricSheetProps {
  rows: Row[];
  /** The line the playhead has reached (-1 when none). */
  activeIndex: number;
  selectedId: string;
  /** The line tap-to-sync will stamp next (-1 when not tapping). */
  tapIndex: number;
  suspect: Set<string>;
  outOfOrder: number;
  onSelect: (id: string) => void;
  onStart: (id: string, ms: number) => void;
  onNudge: (id: string, deltaMs: number) => void;
  onText: (id: string, text: string) => void;
  onPlay: (ms: number) => void;
}

/** The editable list of timed lyric lines (windowed when long). */
export function LyricSheet(p: LyricSheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT);
  const windowed = p.rows.length > WINDOW_THRESHOLD;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight || FALLBACK_VIEWPORT);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the line being stamped (or sung) in view.
  const follow = p.tapIndex >= 0 ? p.tapIndex : p.activeIndex;
  useEffect(() => {
    const el = ref.current;
    if (!el || follow < 0) return;
    const top = follow * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + viewport) el.scrollTop = top + ROW_HEIGHT - viewport;
  }, [follow, viewport]);

  const first = windowed ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0;
  const last = windowed ? Math.min(p.rows.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN) : p.rows.length;
  const slice = p.rows.slice(first, last);

  return (
    <div
      ref={ref}
      role="list"
      aria-label="Lyric lines"
      className={styles.sheet}
      onScroll={windowed ? (e) => setScrollTop(e.currentTarget.scrollTop) : undefined}
    >
      <div style={windowed ? { height: p.rows.length * ROW_HEIGHT, position: "relative" } : undefined}>
        <div style={windowed ? { position: "absolute", top: first * ROW_HEIGHT, left: 0, right: 0 } : undefined}>
          {slice.map((row, i) => {
            const index = first + i;
            return (
              <SheetRow
                key={row.id}
                row={row}
                index={index}
                active={index === p.activeIndex}
                selected={row.id === p.selectedId}
                tapNext={index === p.tapIndex}
                outOfOrder={index === p.outOfOrder}
                suspect={p.suspect.has(row.id)}
                onSelect={p.onSelect}
                onStart={p.onStart}
                onNudge={p.onNudge}
                onText={p.onText}
                onPlay={p.onPlay}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
