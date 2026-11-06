/**
 * The lyric lines (formerly the sheet of the Lyrics step): the timed lines,
 * edited in place, with insert/delete, undo, shift timing, tap to sync and the
 * .lrc export. It is the side of the workspace and pops out into its own
 * window; edits and playback travel to the host window through the store
 * bridge, and a replica never submits the .lrc job.
 */
import { useMemo, useState } from "react";
import { Banner, Button, ClickIn, IconButton, Kbd, MenuButton, Spinner, TextField } from "@/components";
import { LyricAction } from "@/lib/api";
import { getWorkspace } from "@/workspace";
import { LyricSheet } from "./LyricSheet";
import { documentIssues, latestStarted, parseMs, suspectIds, toLines } from "./logic";
import { buildOptions } from "./options";
import { RunStatus } from "./RunStatus";
import { LYRIC_VIDEO_ID, useLyricVideo } from "./store";
import { useJobRun } from "./useJobRun";
import { isActive, useJob } from "@/state/jobs";
import styles from "./panels.module.css";
import oldStyles from "./LyricVideoView.module.css";

/** The "Timing the lyrics…" progress that replaces the sheet while lyrics are being detected. */
function TimingProgress() {
  const id = useLyricVideo((s) => s.jobIds.gen);
  const job = useJob(id);
  if (!job || !isActive(job)) return null;
  return (
    <div className={styles.hint} role="status" aria-live="polite" data-testid="timing-progress">
      <Spinner size={12} /> {job.message || "Timing the lyrics…"} {job.progress > 0 ? `${Math.round(job.progress * 100)}%` : ""}
    </div>
  );
}

export default function LinesPanel() {
  const rows = useLyricVideo((s) => s.rows);
  const selectedId = useLyricVideo((s) => s.selectedId);
  const tapIndex = useLyricVideo((s) => s.tapIndex);
  const playheadMs = useLyricVideo((s) => s.playheadMs);
  const matched = useLyricVideo((s) => s.matched);
  const songPath = useLyricVideo((s) => s.songPath);
  const lrc = useJobRun("lrc");
  const [shift, setShift] = useState("");
  const st = useLyricVideo.getState;
  const replica = getWorkspace(LYRIC_VIDEO_ID)?.isReplica() ?? false;

  const issues = useMemo(() => documentIssues(rows), [rows]);
  const suspect = useMemo(() => (matched !== null && matched < 0.7 ? suspectIds(rows) : new Set<string>()), [matched, rows]);
  const activeIndex = useMemo(() => latestStarted(rows, playheadMs), [rows, playheadMs]);
  const tapping = tapIndex >= 0;
  const tapLine = tapping ? (rows[tapIndex]?.text ?? "") : "";
  const hasRows = rows.length > 0;

  const applyShift = (sign: 1 | -1) => {
    const ms = parseMs(shift);
    st().shiftAll(sign * (ms === null ? 100 : Math.abs(ms)));
  };
  const exportLrc = () => {
    const s = st();
    if (!s.songPath || issues.blocker) return;
    void lrc.start([s.songPath], buildOptions(LyricAction.ActionLRC, s.prefs, s.meta, { lines: toLines(s.rows) }));
  };

  return (
    <div className={styles.lines}>
      <TimingProgress />
      <div className={styles.linesTools}>
        <IconButton size="sm" icon="plus" label="Insert line" data-tip="Add a new line after the selected one" disabled={tapping} onClick={() => st().insertLine()} />
        <IconButton size="sm" icon="trash-2" label="Delete line" data-tip="Delete the selected line" disabled={!rows.some((r) => r.id === selectedId) || tapping} onClick={() => st().deleteSelected()} />
        <ClickIn variant="icon" icon="clock" title="Shift timing" tip="Move every line earlier or later by the same amount to fix a constant offset" width={320}>
          <span className={oldStyles.shiftGroup} style={{ padding: "var(--space-4)" }} data-tip="Move every line earlier or later by the same amount to fix a constant offset">
            <IconButton size="sm" icon="minus" label="Shift all earlier" data-tip="Move every line earlier by the amount in the box (100 ms if empty)" disabled={!hasRows || tapping} onClick={() => applyShift(-1)} />
            <TextField
              size="sm"
              mono
              aria-label="Shift all by (ms)"
              data-tip="Milliseconds to shift all lines by; leave empty for 100"
              wrapperClassName={oldStyles.shiftField}
              value={shift}
              placeholder="100"
              inputMode="numeric"
              onChange={(e) => setShift(e.target.value)}
            />
            <span className={styles.muted}>ms</span>
            <IconButton size="sm" icon="plus" label="Shift all later" data-tip="Move every line later by the amount in the box (100 ms if empty)" disabled={!hasRows || tapping} onClick={() => applyShift(1)} />
          </span>
        </ClickIn>
        {tapping ? (
          <Button size="sm" icon="square" onClick={() => st().endTap()} data-tip="Stop tapping and keep the times you set" data-tip-kbd="Escape">
            Stop tapping
          </Button>
        ) : (
          <Button size="sm" icon="pointer" onClick={() => st().startTap()} disabled={!hasRows} data-tip={hasRows ? "Play the song and press Space as each line starts to set its time" : "Add some lyric lines first"}>
            Tap to sync
          </Button>
        )}
        {!replica && (
          <MenuButton
            label="More"
            icon="ellipsis"
            variant="ghost"
            size="sm"
            items={() => [{ id: "lrc", label: "Export .lrc", tip: "Save the timed lyrics as an .lrc file you can use in music players", icon: "file-text", disabled: !songPath || !hasRows || !!issues.blocker || lrc.busy, onSelect: exportLrc }]}
          />
        )}
      </div>

      {tapping && (
        <div className={styles.tapBar} role="status" aria-live="polite">
          <span>
            Press <Kbd combo="Space" /> as each line starts: <strong>{tapLine || "…"}</strong>
          </span>
          <span className={styles.muted}>
            <Kbd combo="Backspace" /> back a line · <Kbd combo="Escape" /> done
          </span>
        </div>
      )}
      {issues.blocker && hasRows && <Banner tone="danger" title={issues.blocker} />}
      {issues.blank > 0 && hasRows && !issues.blocker && (
        <div className={styles.muted}>
          {issues.blank} empty {issues.blank === 1 ? "line is" : "lines are"} skipped.
        </div>
      )}
      {!replica && <RunStatus run={lrc} runningLabel="Writing the .lrc…" doneLabel="Saved the .lrc" />}

      {hasRows ? (
        <div className={styles.sheetBox}>
          <LyricSheet
            rows={rows}
            activeIndex={activeIndex}
            selectedId={selectedId}
            tapIndex={tapIndex}
            suspect={suspect}
            outOfOrder={issues.firstOutOfOrder}
            onSelect={(id) => st().select(id)}
            onStart={(id, ms) => st().setStart(id, ms)}
            onNudge={(id, d) => st().nudge(id, d)}
            onText={(id, t) => st().setLineText(id, t)}
            onPlay={(ms) => st().playFrom(ms)}
          />
        </div>
      ) : (
        <div className={styles.empty}>
          No lyrics yet. Get timings in the Lyrics panel, or
          <Button size="sm" variant="ghost" onClick={() => st().insertLine()} data-tip="Start the sheet with one empty line">
            add a line by hand
          </Button>
        </div>
      )}
    </div>
  );
}
