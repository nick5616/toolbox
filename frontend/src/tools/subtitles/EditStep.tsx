import { useMemo, useState, type RefObject } from "react";
import { Banner, Button, EmptyState, IconButton, Meter, Spinner, Stepper, Switch, TextField, cx } from "@/components";
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
          className={cx(styles.tab, t.id === activeId && styles.tabOn)}
          onClick={() => onSelect(t.id)}
        >
          {t.label}
          {isDirty(t) && <span className={styles.dot} aria-label="Unsaved changes" />}
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
  const [findOpen, setFindOpen] = useState(false);
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
          <Button icon="film" onClick={p.onPickMedia}>
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
      <Banner tone="danger" title={p.media.error?.message ?? "Couldn't open the file"} action={<Button size="sm" onClick={p.media.retry}>Try again</Button>}>
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
        {kind === "audio" && current && <div className={styles.audioCue}>{current.text}</div>}
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
        <div className={styles.toolbar} role="toolbar" aria-label="Subtitle tools">
          <IconButton size="sm" icon="undo-2" label="Undo" kbd="Mod+Z" disabled={!p.canUndo} onClick={p.onUndo} />
          <IconButton size="sm" icon="redo-2" label="Redo" kbd="Mod+Shift+Z" disabled={!p.canRedo} onClick={p.onRedo} />
          <span className={styles.sep} aria-hidden />
          <span className={styles.shiftLabel} id="shift-label">
            Subtitles are late by
          </span>
          <Stepper aria-labelledby="shift-label" value={lateBy} step={100} min={-600000} max={600000} unit="ms" onChange={setLateBy} />
          <Button
            size="sm"
            variant="secondary"
            disabled={lateBy === 0 || p.rows.length === 0}
            onClick={() => {
              p.onShift(-lateBy);
              setLateBy(0);
            }}
          >
            Shift
          </Button>
          <span className={styles.sep} aria-hidden />
          <IconButton size="sm" icon="search" label="Find and replace" pressed={findOpen} onClick={() => setFindOpen((o) => !o)} />
          <span className={styles.grow} />
          <Button size="sm" icon="check" kbd="Mod+S" loading={p.save.busy} disabled={p.rows.length === 0 || p.blocker !== null || p.save.busy} onClick={p.onSave}>
            Save
          </Button>
        </div>
        {findOpen && (
          <div className={styles.findRow}>
            <TextField size="sm" aria-label="Find" placeholder="Find" value={find} onChange={(e) => { setFind(e.target.value); setReplaced(null); }} />
            <TextField size="sm" aria-label="Replace with" placeholder="Replace with" value={repl} onChange={(e) => setRepl(e.target.value)} />
            <Switch checked={matchCase} onChange={setMatchCase} label="Match case" />
            <span className={styles.muted}>{replaced !== null ? `Replaced ${replaced}` : find ? `${matches} found` : ""}</span>
            <Button size="sm" variant="secondary" disabled={matches === 0} onClick={() => setReplaced(p.onReplace(find, repl, matchCase))}>
              Replace all
            </Button>
          </div>
        )}
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
              <Button icon="plus" onClick={p.onInsertFirst}>
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
