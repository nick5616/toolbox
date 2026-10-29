import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Icon, IconButton, Switch, cx } from "@/components";
import { BoxOverlay, MediaPlayer, Timeline, formatMs, type Marker, type MediaPlayerHandle } from "@/components/media";
import type { MediaSource, RedactTrack } from "@/lib/api";
import { useShortcut } from "@/lib/shortcuts";
import { onRedactAction } from "./commands";
import { TimeField } from "./bits";
import { applyVideoOverlay, overlayAt, removeManual, setManualTime, setTrack, type VideoState } from "./logic";
import styles from "./RedactView.module.css";

export interface VideoReviewProps {
  path: string;
  source: MediaSource;
  tracks: RedactTrack[];
  state: VideoState;
  onState: (s: VideoState) => void;
}

const span = (t: { startMs: number; endMs: number }) => `${formatMs(t.startMs)} – ${formatMs(t.endMs)}`;

/** Player with the tracked boxes over the picture, a track timeline and the track list. */
export function VideoReview({ source, tracks, state, onState, path }: VideoReviewProps) {
  const player = useRef<MediaPlayerHandle>(null);
  const [ms, setMs] = useState(0);
  const [drawMode, setDrawMode] = useState(false);
  const [selected, setSelected] = useState<string | undefined>();
  const durationMs = source.info.durationMs;

  const boxes = useMemo(() => overlayAt(tracks, state, ms), [tracks, state, ms]);
  const markers: Marker[] = useMemo(
    () => [
      ...tracks.map((t, i) => ({ id: t.id, startMs: t.startMs, endMs: t.endMs, label: `${t.kind === "plate" ? "Plate" : "Face"} ${i + 1}`, tone: (state.tracks[t.id] ?? t.enabled) ? ("accent" as const) : ("muted" as const) })),
      ...state.manual.map((b, i) => ({ id: b.id, startMs: b.startMs, endMs: b.endMs, label: `Manual ${i + 1}`, tone: b.enabled ? ("warn" as const) : ("muted" as const) })),
    ],
    [tracks, state],
  );

  const seek = (t: number) => {
    player.current?.seek(t);
    setMs(t);
  };
  const selectedManual = state.manual.find((b) => b.id === selected);
  const setTime = (which: "start" | "end") => {
    if (!selectedManual) return;
    onState(setManualTime(state, selectedManual.id, which, player.current?.currentMs() ?? ms, durationMs));
  };

  useEffect(() => onRedactAction((a) => a === "add-box" && setDrawMode((v) => !v)), []);
  useShortcut("B", () => setDrawMode((v) => !v));
  useShortcut("I", () => setTime("start"), { when: !!selectedManual });
  useShortcut("O", () => setTime("end"), { when: !!selectedManual });
  useShortcut(
    ["Delete", "Backspace"],
    () => {
      if (!selectedManual) return;
      onState(removeManual(state, selectedManual.id));
      setSelected(undefined);
    },
    { when: !!selectedManual },
  );

  return (
    <div className={styles.review}>
      <div className={styles.reviewMain}>
        <MediaPlayer
          ref={player}
          className={styles.player}
          source={source}
          kind="video"
          path={path}
          onTime={setMs}
          overlay={(rect) => (
            <BoxOverlay
              rect={rect}
              boxes={boxes}
              editable
              drawMode={drawMode}
              selectedId={selected}
              onSelect={setSelected}
              onChange={(next) => onState(applyVideoOverlay(state, tracks, boxes, next, player.current?.currentMs() ?? ms, durationMs))}
            />
          )}
        />
        <Timeline durationMs={durationMs} playheadMs={ms} onSeek={seek} markers={markers} onMarkerClick={(id) => {
          const t = tracks.find((x) => x.id === id);
          if (t) seek(t.startMs);
          else setSelected(id);
        }} zoomable />
      </div>

      <aside className={styles.side} aria-label="Tracks">
        <div className={styles.sideHead}>
          <span className={styles.sideTitle}>
            {tracks.filter((t) => state.tracks[t.id] ?? t.enabled).length} of {tracks.length} {tracks.length === 1 ? "track" : "tracks"} on
          </span>
          <Button size="sm" variant={drawMode ? "primary" : "secondary"} icon="square-dashed" kbd="B" aria-pressed={drawMode} onClick={() => setDrawMode((v) => !v)}>
            Add box
          </Button>
        </div>
        {drawMode && <p className={styles.hint}>Drag on the picture to cover something from now for 3 seconds.</p>}
        {tracks.length === 0 ? (
          <p className={styles.hint}>No faces or plates were followed. Add a box by hand where something should be hidden.</p>
        ) : (
          <>
            <p className={styles.hint}>Tracks with only a few hits start switched off; they are often false matches. Click a track to jump to it.</p>
            <ul className={styles.boxList}>
              {tracks.map((t, i) => {
                const on = state.tracks[t.id] ?? t.enabled;
                return (
                  <li key={t.id} className={styles.boxRow} data-testid={`track-${t.id}`}>
                    <Icon name={t.kind === "plate" ? "rectangle-horizontal" : "scan-face"} size={14} />
                    <button type="button" className={styles.trackBtn} onClick={() => seek(t.startMs)}>
                      <span className={styles.boxName}>
                        {t.kind === "plate" ? "Plate" : "Face"} {i + 1}
                      </span>
                      <span className={styles.boxScore}>{span(t)}</span>
                    </button>
                    <span className={styles.boxScore}>{Math.round(t.maxScore * 100)}%</span>
                    <Switch checked={on} aria-label={`Redact track ${i + 1}`} onChange={(v) => onState(setTrack(state, t.id, v))} />
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {state.manual.length > 0 && (
          <>
            <h4 className={styles.subHead}>Boxes added by hand</h4>
            <ul className={styles.boxList}>
              {state.manual.map((b, i) => (
                <li key={b.id} className={cx(styles.manualRow, selected === b.id && styles.boxRowSelected)} onClick={() => setSelected(b.id)}>
                  <div className={styles.manualHead}>
                    <Icon name="square-dashed" size={14} />
                    <span className={styles.boxName}>Manual {i + 1}</span>
                    <Switch checked={b.enabled} aria-label={`Redact manual box ${i + 1}`} onChange={(v) => onState({ ...state, manual: state.manual.map((m) => (m.id === b.id ? { ...m, enabled: v } : m)) })} />
                    <IconButton size="sm" icon="trash-2" label={`Delete manual box ${i + 1}`} onClick={() => onState(removeManual(state, b.id))} />
                  </div>
                  <div className={styles.manualTimes}>
                    <TimeField label={`Manual box ${i + 1} start`} ms={b.startMs} onCommit={(v) => onState(setManualTime(state, b.id, "start", v, durationMs))} />
                    <span className={styles.boxScore}>to</span>
                    <TimeField label={`Manual box ${i + 1} end`} ms={b.endMs} onCommit={(v) => onState(setManualTime(state, b.id, "end", v, durationMs))} />
                  </div>
                </li>
              ))}
            </ul>
            <p className={styles.hint}>Select a manual box and press I or O to set its start or end to the playhead.</p>
          </>
        )}
      </aside>
    </div>
  );
}
