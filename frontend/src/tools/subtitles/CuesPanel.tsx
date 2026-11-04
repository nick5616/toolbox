import { useMemo, useState } from "react";
import { Banner, Button, ClickIn, EmptyState, Stepper, Switch, TextField, cx } from "@/components";
import { CueList } from "./CueList";
import { isDirty } from "./editor";
import { useBlocker, useRows } from "./hooks";
import { activeCueIndex, countMatches } from "./logic";
import { useSubtitles } from "./store";
import styles from "./SubtitlesView.module.css";

function TabBar() {
  const tabs = useSubtitles((s) => s.editor.tabs);
  const activeId = useSubtitles((s) => s.editor.activeId);
  const selectTab = useSubtitles((s) => s.selectTab);
  if (tabs.length < 2) return null;
  return (
    <div role="tablist" aria-label="Subtitle tracks" className={styles.tabs}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === activeId}
          data-tip="Switch to this subtitle track"
          className={cx(styles.tab, t.id === activeId && styles.tabOn)}
          onClick={() => selectTab(t.id)}
        >
          {t.label}
          {isDirty(t) && <span className={styles.dot} aria-label="Unsaved changes" data-tip="This track has changes you haven't saved" />}
        </button>
      ))}
    </div>
  );
}

/** The cue list: the main editing surface (also a panel that pops out). */
export function CuesPanel() {
  const rows = useRows();
  const blocker = useBlocker();
  const playheadMs = useSubtitles((s) => s.playheadMs);
  const playing = useSubtitles((s) => s.playing);
  const maxLine = useSubtitles((s) => s.prefs.maxLineChars);
  const focusId = useSubtitles((s) => s.focusId);
  const patchCue = useSubtitles((s) => s.patchCue);
  const rowAction = useSubtitles((s) => s.rowAction);
  const seek = useSubtitles((s) => s.seek);
  const clearFocus = useSubtitles((s) => s.clearFocus);
  const insertFirst = useSubtitles((s) => s.insertFirst);
  const shift = useSubtitles((s) => s.shift);
  const replaceAll = useSubtitles((s) => s.replaceAll);

  const [lateBy, setLateBy] = useState(0);
  const [find, setFind] = useState("");
  const [repl, setRepl] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [replaced, setReplaced] = useState<number | null>(null);
  const activeIndex = useMemo(() => activeCueIndex(rows, playheadMs), [rows, playheadMs]);
  const matches = useMemo(() => countMatches(rows, find, matchCase), [rows, find, matchCase]);

  return (
    <div className={styles.cuesBox}>
      <TabBar />
      <div className={styles.toolbar} role="toolbar" aria-label="Subtitle tools" data-tip="Tools for the whole subtitle list">
        <ClickIn variant="icon" icon="clock" title="Shift timing" tip="If every subtitle comes too late or too early, move them all together" width={320}>
          <div className={styles.drawerForm}>
            <span className={styles.shiftLabel} id="shift-label" data-tip="If every subtitle comes too late, enter by how much and press Shift to move them all earlier (use a negative number if they are early)">
              Subtitles are late by
            </span>
            <Stepper aria-labelledby="shift-label" data-tip="How many milliseconds late the subtitles are" value={lateBy} step={100} min={-600000} max={600000} unit="ms" onChange={setLateBy} />
            <div>
              <Button
                size="sm"
                variant="secondary"
                data-tip={lateBy === 0 ? "Enter how late the subtitles are first" : rows.length === 0 ? "There are no subtitles to shift" : "Move every subtitle earlier by that amount"}
                disabled={lateBy === 0 || rows.length === 0}
                onClick={() => {
                  shift(-lateBy);
                  setLateBy(0);
                }}
              >
                Shift
              </Button>
            </div>
          </div>
        </ClickIn>
        <ClickIn variant="icon" icon="search" title="Find and replace" tip="Search the subtitle text and replace it everywhere" width={320}>
          <div className={styles.drawerForm}>
            <TextField size="sm" aria-label="Find" data-tip="The text to look for in the subtitles" placeholder="Find" value={find} onChange={(e) => { setFind(e.target.value); setReplaced(null); }} />
            <TextField size="sm" aria-label="Replace with" data-tip="What to put instead; leave empty to delete the matches" placeholder="Replace with" value={repl} onChange={(e) => setRepl(e.target.value)} />
            <Switch tip="Only match text with the same upper and lower case" checked={matchCase} onChange={setMatchCase} label="Match case" />
            <span className={styles.muted} data-tip="How many places match, or how many were replaced">{replaced !== null ? `Replaced ${replaced}` : find ? `${matches} found` : ""}</span>
            <div>
              <Button
                size="sm"
                variant="secondary"
                disabled={matches === 0}
                data-tip={matches === 0 ? "Nothing matches yet" : "Replace every match in all subtitles; undo brings it back"}
                onClick={() => {
                  setReplaced(matches);
                  replaceAll(find, repl, matchCase);
                }}
              >
                Replace all
              </Button>
            </div>
          </div>
        </ClickIn>
      </div>
      {blocker && (
        <Banner tone="warn" title="Fix this before saving">
          {blocker}
        </Banner>
      )}
      {rows.length === 0 ? (
        <EmptyState
          icon="captions"
          title="No subtitles yet"
          body="Add the first one and set its timing."
          action={
            <Button icon="plus" onClick={insertFirst} data-tip="Create the first subtitle, then set its timing">
              Add a subtitle
            </Button>
          }
        />
      ) : (
        <CueList rows={rows} activeIndex={activeIndex} playing={playing} maxLine={maxLine} onPatch={patchCue} onAction={rowAction} onSeek={seek} focusId={focusId || undefined} onFocused={clearFocus} />
      )}
    </div>
  );
}
