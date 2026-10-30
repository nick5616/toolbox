import { useState, type ReactNode } from "react";
import { Banner, Button, IconButton, MenuButton, Section, SegmentedControl, Select, TextArea, TextField, Kbd } from "@/components";
import { Timeline, type Marker } from "@/components/media";
import { LyricSource, type Language } from "@/lib/api";
import { DepsGate } from "@/tools/_kit";
import { LyricSheet, type LyricSheetProps } from "./LyricSheet";
import { LOW_MATCH, OKAY_MATCH, parseMs, type Row } from "./logic";
import type { Prefs } from "./options";
import { RunStatus } from "./RunStatus";
import type { JobRun } from "./useJobRun";
import styles from "./LyricVideoView.module.css";

export interface LyricsStepProps {
  moduleId: string;
  prefs: Prefs;
  setPrefs: (next: Prefs | ((p: Prefs) => Prefs)) => void;
  languages: Language[];
  text: string;
  onText: (t: string) => void;
  lyricsPath: string;
  onPickLyricsFile: () => void;
  gen: JobRun;
  /** True when the AI engine is needed and missing. */
  engineBlocked: boolean;
  onGetTimings: () => void;
  /** The lyric player (rendered by the view so its ref and time are shared). */
  player: ReactNode;
  durationMs: number;
  playheadMs: number;
  waveform: number[] | undefined;
  onSeek: (ms: number) => void;
  rows: Row[];
  sheet: Omit<LyricSheetProps, "rows" | "activeIndex">;
  activeIndex: number;
  /** Fraction of lyric words the aligner matched (null when not from an alignment). */
  matched: number | null;
  /** The last timing run returned no lyrics. */
  noLyrics: boolean;
  blocker: string;
  blank: number;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onInsert: () => void;
  onDelete: () => void;
  canDelete: boolean;
  onShiftAll: (deltaMs: number) => void;
  tapping: boolean;
  tapLine: string;
  onTapStart: () => void;
  onTapEnd: () => void;
  lrc: JobRun;
  onExportLrc: () => void;
  onContinue: () => void;
}

const SOURCE_OPTIONS: Array<{ value: LyricSource; label: string }> = [
  { value: LyricSource.SourceDetect, label: "Detect from the song" },
  { value: LyricSource.SourceAlign, label: "Paste lyrics" },
  { value: LyricSource.SourceFile, label: "From a file" },
];

function basenameOf(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** Step 2: get timed lyrics, then fix them in the sheet. */
export function LyricsStep(p: LyricsStepProps) {
  const { prefs, setPrefs } = p;
  const [shift, setShift] = useState("");
  const source = prefs.source;
  const languageOptions = [{ value: "", label: "Auto-detect" }, ...p.languages.map((l) => ({ value: l.code, label: l.name }))];
  const hasRows = p.rows.length > 0;
  const textOk = source !== "align" || p.text.trim() !== "";
  const fileOk = source !== "file" || p.lyricsPath !== "";
  const canGet = textOk && fileOk && !p.gen.busy && !p.engineBlocked;
  const markers: Marker[] = p.rows.map((r) => ({ id: r.id, startMs: r.startMs, endMs: r.endMs, label: r.text, tone: r.id === p.sheet.selectedId ? "accent" : "neutral" }));

  const applyShift = (sign: 1 | -1) => {
    const ms = parseMs(shift);
    const amount = ms === null ? 100 : Math.abs(ms);
    p.onShiftAll(sign * amount);
  };

  return (
    <div className={styles.lyricsBody}>
      <Section label="Where do the lyrics come from?">
        <div className={styles.form}>
          <SegmentedControl
            aria-label="Lyrics source"
            value={source}
            options={SOURCE_OPTIONS}
            onChange={(v) => setPrefs((o) => ({ ...o, source: v }))}
          />
          {source === "align" && (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Lyrics (recommended)</span>
              <TextArea
                aria-label="Lyrics"
                minRows={5}
                maxRows={12}
                maxLength={20000}
                value={p.text}
                placeholder="Paste the words, one line per row"
                onChange={(e) => p.onText(e.target.value)}
              />
              <span className={styles.hint}>Paste the words and Toolbox times them to the song.</span>
            </label>
          )}
          {source === "detect" && (
            <div className={styles.hint}>Listens to the isolated vocals. It works best on clear singing; pasting the lyrics is more reliable.</div>
          )}
          {source === "file" && (
            <div className={styles.buttonRow}>
              <Button variant="secondary" icon="file-text" onClick={p.onPickLyricsFile}>
                Choose a .lrc, .srt, .vtt or .txt…
              </Button>
              <span className={styles.muted}>{p.lyricsPath ? basenameOf(p.lyricsPath) : "No file chosen"}</span>
            </div>
          )}
          {source !== "file" && (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Sung language</span>
              <Select aria-label="Sung language" value={prefs.language} options={languageOptions} onChange={(language) => setPrefs((o) => ({ ...o, language }))} />
            </label>
          )}
          <DepsGate moduleId={p.moduleId} />
          <div className={styles.buttonRow}>
            <Button icon="wand-sparkles" onClick={p.onGetTimings} loading={p.gen.busy} disabled={!canGet}>
              Get timings
            </Button>
          </div>
          <RunStatus run={p.gen} runningLabel="Timing the lyrics…" showResult={false} />
        </div>
      </Section>

      {p.noLyrics && (
        <Banner tone="warn" title="No lyrics were found">
          Try pasting the lyrics, or choose a lyrics file. You can also add lines by hand below.
        </Banner>
      )}
      {p.matched !== null && p.matched < LOW_MATCH && (
        <Banner tone="warn" title="Couldn't follow the song well — check the timings">
          Only {Math.round(p.matched * 100)}% of the words matched what was sung. Use tap to sync or the nudge buttons to fix the lines.
        </Banner>
      )}
      {p.matched !== null && p.matched >= LOW_MATCH && p.matched < OKAY_MATCH && (
        <Banner tone="info" title="Some lines may be off">
          {Math.round(p.matched * 100)}% of the words matched. Lines marked in orange look suspicious.
        </Banner>
      )}

      <Section label="Lyric lines">
        <div className={styles.sheetTools}>
          <Button size="sm" variant="secondary" icon="plus" onClick={p.onInsert} disabled={p.tapping}>
            Insert line
          </Button>
          <Button size="sm" variant="secondary" icon="trash-2" onClick={p.onDelete} disabled={!p.canDelete || p.tapping}>
            Delete
          </Button>
          <IconButton size="sm" icon="undo-2" label="Undo" disabled={!p.canUndo} onClick={p.onUndo} />
          <IconButton size="sm" icon="redo-2" label="Redo" disabled={!p.canRedo} onClick={p.onRedo} />
          <span className={styles.shiftGroup}>
            <IconButton size="sm" icon="minus" label="Shift all earlier" disabled={!hasRows || p.tapping} onClick={() => applyShift(-1)} />
            <TextField
              size="sm"
              mono
              aria-label="Shift all by (ms)"
              wrapperClassName={styles.shiftField}
              value={shift}
              placeholder="100"
              inputMode="numeric"
              onChange={(e) => setShift(e.target.value)}
            />
            <span className={styles.muted}>ms</span>
            <IconButton size="sm" icon="plus" label="Shift all later" disabled={!hasRows || p.tapping} onClick={() => applyShift(1)} />
          </span>
          <span className={styles.spacer} />
          {p.tapping ? (
            <Button size="sm" icon="square" onClick={p.onTapEnd}>
              Stop tapping
            </Button>
          ) : (
            <Button size="sm" icon="pointer" onClick={p.onTapStart} disabled={!hasRows}>
              Tap to sync
            </Button>
          )}
          <MenuButton
            label="More"
            icon="chevron-down"
            size="sm"
            items={() => [{ id: "lrc", label: "Export .lrc", icon: "file-text", disabled: !hasRows || !!p.blocker || p.lrc.busy, onSelect: p.onExportLrc }]}
          />
        </div>

        {p.tapping && (
          <div className={styles.tapBar} role="status" aria-live="polite">
            <span>
              Press <Kbd combo="Space" /> as each line starts: <strong>{p.tapLine || "…"}</strong>
            </span>
            <span className={styles.muted}>
              <Kbd combo="Backspace" /> back a line · <Kbd combo="Escape" /> done
            </span>
          </div>
        )}

        {p.blocker && hasRows && (
          <Banner tone="danger" title={p.blocker} />
        )}
        {p.blank > 0 && hasRows && !p.blocker && <div className={styles.muted}>{p.blank} empty {p.blank === 1 ? "line is" : "lines are"} skipped.</div>}

        <RunStatus run={p.lrc} runningLabel="Writing the .lrc…" doneLabel="Saved the .lrc" />

        {p.player}
        {p.durationMs > 0 && (
          <Timeline
            durationMs={p.durationMs}
            playheadMs={p.playheadMs}
            onSeek={p.onSeek}
            markers={markers}
            zoomable
            {...(p.waveform ? { waveform: p.waveform } : {})}
          />
        )}

        {hasRows ? (
          <LyricSheet rows={p.rows} activeIndex={p.activeIndex} {...p.sheet} />
        ) : (
          <div className={styles.emptySheet}>
            No lyrics yet. Get timings above, or
            <Button size="sm" variant="ghost" onClick={p.onInsert}>
              add a line by hand
            </Button>
          </div>
        )}
      </Section>

      <div className={styles.footer}>
        <Button onClick={p.onContinue} disabled={!hasRows || !!p.blocker || p.tapping}>
          Continue to Visuals
        </Button>
      </div>
    </div>
  );
}
