import { useMemo, useState, type RefObject } from "react";
import { Banner, Button, ClickIn, EmptyState, IconButton, Meter, Spinner, Stepper, Switch, TextField, cx } from "@/components";
import { MediaPlayer, Timeline, type ContentRect, type MediaPlayerHandle, type MediaSourceState, type Marker } from "@/components/media";
import { CueList, type RowAction } from "./CueList";
import { CueOverlay } from "./CueOverlay";
import { isDirty, type EditorTab } from "./editor";
import { countMatches, type CueRow } from "./logic";
import { MAX_MARKERS } from "./logic";
import type { Prefs } from "./options";
import { RunStatus } from "./RunStatus";
import type { JobRun } from "./useJobRun";
import styles from "./SubtitlesView.module.css";

export function TabBar({ tabs, activeId, onSelect }: { tabs: EditorTab[]; activeId: string; onSelect: (id: string) => void }) {
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
          onClick={() => onSelect(t.id)}
        >
          {t.label}
          {isDirty(t) && <span className={styles.dot} aria-label="Unsaved changes" data-tip="This track has changes you haven't saved" />}
        </button>
      ))}
    </div>
  );
}

export interface EditStepProps {
  mediaPath: string | null;
  media: MediaSourceState;
  playerRef: RefObject<MediaPlayerHandle | null>;
  playheadMs: number;
  playing: boolean;
  filmstripUrl?: string;
  waveform?: number[];
  tabs: EditorTab[];
  activeId: string;
  rows: CueRow[];
  activeIndex: number;
  prefs: Prefs;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  blocker: string | null;
  save: JobRun;
  focusId?: string;
  onFocused: () => void;
  onSelectTab: (id: string) => void;
  onTime: (ms: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onSeek: (ms: number) => void;
  onPatch: (id: string, patch: Partial<Omit<CueRow, "id">>, key?: string) => void;
  onRowAction: (action: RowAction, id: string, caret: number) => void;
  onInsertFirst: () => void;
  onShift: (deltaMs: number) => void;
  onReplace: (find: string, replacement: string, matchCase: boolean) => number;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onPickMedia: () => void;
}

/** Step 2: player with cue overlay and timeline on the left, the cue list on the right. */
export function EditStep(p: EditStepProps) {
  const [lateBy, setLateBy] = useState(0);
  const [find, setFind] = useState("");
  const [repl, setRepl] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [replaced, setReplaced] = useState<number | null>(null);

  const info = p.media.source?.info;
  const kind = info?.video ? "video" : "audio";
  const current = p.rows[p.activeIndex];

  const markers = useMemo<Marker[]>(() => {
    const stride = Math.max(1, Math.ceil(p.rows.length / MAX_MARKERS));
    const out: Marker[] = [];
    for (let i = 0; i < p.rows.length; i += stride) {
      const r = p.rows[i];
      if (r) out.push({ id: r.id, startMs: r.startMs, endMs: r.endMs, tone: i === p.activeIndex ? "accent" : "muted" });
    }
    return out;
  }, [p.rows, p.activeIndex]);

  const matches = useMemo(() => countMatches(p.rows, find, matchCase), [p.rows, find, matchCase]);

  const overlay = (rect: ContentRect) => (
    <CueOverlay rect={rect} text={current?.text ?? ""} style={p.prefs.style} size={p.prefs.size} position={p.prefs.position} font={p.prefs.font} />
  );

  let left;
  if (!p.mediaPath) {
    left = (
      <EmptyState
        icon="film"
        title="No video to preview against"
        body="You can edit without one. Pick the video to see the subtitles on the picture."
        action={
          <Button icon="film" onClick={p.onPickMedia} data-tip="Choose the video to preview the subtitles against">
            Pick the video…
          </Button>
        }
      />
    );
  } else if (p.media.status === "loading" || p.media.status === "idle") {
    left = (
      <div className={styles.center}>
        <Spinner label="Opening the file" /> Opening the file…
      </div>
    );
  } else if (p.media.status === "preparing") {
    left = (
      <div className={styles.center} role="status">
        <div>Preparing a preview copy… {Math.round((p.media.progress ?? 0) * 100)}%</div>
        <Meter value={p.media.progress ?? -1} label="Preview copy" />
      </div>
    );
  } else if (p.media.status === "error") {
    left = (
      <Banner tone="danger" title={p.media.error?.message ?? "Couldn't open the file"} action={<Button size="sm" onClick={p.media.retry} data-tip="Try opening the file again">Try again</Button>}>
        {p.media.error?.hint}
      </Banner>
    );
  } else if (p.media.source) {
    left = (
      <>
        <MediaPlayer
          ref={p.playerRef}
          source={p.media.source}
          kind={kind}
          path={p.mediaPath}
          onTime={p.onTime}
          onPlayingChange={p.onPlayingChange}
          overlay={kind === "video" ? overlay : undefined}
          className={styles.player}
        />
        {kind === "audio" && current && <div className={styles.audioCue} data-tip="The subtitle at the playhead">{current.text}</div>}
        <Timeline
          durationMs={info?.durationMs ?? 0}
          playheadMs={p.playheadMs}
          onSeek={p.onSeek}
          filmstripUrl={p.filmstripUrl}
          waveform={p.waveform}
          markers={markers}
          onMarkerClick={(id) => {
            const r = p.rows.find((x) => x.id === id);
            if (r) p.onSeek(r.startMs);
          }}
          frameMs={info?.video?.fps ? 1000 / info.video.fps : undefined}
          zoomable
        />
      </>
    );
  }

  return (
    <div className={styles.editGrid}>
      <div className={styles.editLeft}>{left}</div>
      <div className={styles.editRight}>
        <TabBar tabs={p.tabs} activeId={p.activeId} onSelect={p.onSelectTab} />
        <div className={styles.toolbar} role="toolbar" aria-label="Subtitle tools" data-tip="Tools for the whole subtitle list">
          <IconButton size="sm" icon="undo-2" label="Undo" data-tip="Undo the last subtitle edit" kbd="Mod+Z" disabled={!p.canUndo} onClick={p.onUndo} />
          <IconButton size="sm" icon="redo-2" label="Redo" data-tip="Redo the edit you just undid" kbd="Mod+Shift+Z" disabled={!p.canRedo} onClick={p.onRedo} />
          <span className={styles.sep} aria-hidden />
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
                  data-tip={lateBy === 0 ? "Enter how late the subtitles are first" : p.rows.length === 0 ? "There are no subtitles to shift" : "Move every subtitle earlier by that amount"}
                  disabled={lateBy === 0 || p.rows.length === 0}
                  onClick={() => {
                    p.onShift(-lateBy);
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
                <Button size="sm" variant="secondary" disabled={matches === 0} data-tip={matches === 0 ? "Nothing matches yet" : "Replace every match in all subtitles; undo brings it back"} onClick={() => setReplaced(p.onReplace(find, repl, matchCase))}>
                  Replace all
                </Button>
              </div>
            </div>
          </ClickIn>
          <span className={styles.grow} />
          <Button size="sm" icon="check" kbd="Mod+S" data-tip={p.blocker ? "Fix the problem shown below first" : p.rows.length === 0 ? "There are no subtitles to save" : "Write the subtitles to a file in your Library"} loading={p.save.busy} disabled={p.rows.length === 0 || p.blocker !== null || p.save.busy} onClick={p.onSave}>
            Save
          </Button>
        </div>
        {p.blocker && (
          <Banner tone="warn" title="Fix this before saving">
            {p.blocker}
          </Banner>
        )}
        <RunStatus run={p.save} runningLabel="Saving…" doneLabel="Saved" />
        {p.rows.length === 0 ? (
          <EmptyState
            icon="captions"
            title="No subtitles yet"
            body="Add the first one and set its timing."
            action={
              <Button icon="plus" onClick={p.onInsertFirst} data-tip="Create the first subtitle, then set its timing">
                Add a subtitle
              </Button>
            }
          />
        ) : (
          <CueList
            rows={p.rows}
            activeIndex={p.activeIndex}
            playing={p.playing}
            maxLine={p.prefs.maxLineChars}
            onPatch={p.onPatch}
            onAction={p.onRowAction}
            onSeek={p.onSeek}
            focusId={p.focusId}
            onFocused={p.onFocused}
          />
        )}
      </div>
    </div>
  );
}
