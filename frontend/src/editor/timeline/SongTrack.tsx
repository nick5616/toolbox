/** The song track (Phase 9 SPEC §14.5): the range's waveform with draggable fade ramps. Locked: it can't be moved. */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Icon, Tooltip, cx } from "@/components";
import { useWaveform } from "@/blocks/media/useThumbs";
import { editLength } from "@/viz/edit/types";
import { msToX, xToMs } from "@/editor/geometry";
import { useEditStudio, useProject } from "@/editor/store";
import { useEditorProfile } from "../profileContext";
import { collapseDrag } from "./actions";
import { fileDuration } from "./songFile";
import styles from "./TracksPanel.module.css";

export const SONG_ROW_PX = 52;
const BUCKETS = 3000;


export function SongTrack({ timeWidth }: { timeWidth: number }) {
  const optional = useEditorProfile().song === "optional";
  const project = useProject();
  const song = project?.song ?? null;
  const pps = useEditStudio((s) => s.pps);
  const scrollMs = useEditStudio((s) => s.scrollMs);
  const selected = useEditStudio((s) => s.selection?.kind === "song");
  const peaks = useWaveform(song?.path ?? null, BUCKETS);
  const [fileMs, setFileMs] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const D = project ? editLength(project) : 0;

  useEffect(() => {
    if (!song) return;
    let live = true;
    void fileDuration(song.path).then((d) => live && setFileMs(d));
    return () => {
      live = false;
    };
  }, [song]);

  // Waveform: one column per pixel of the visible window.
  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !song || timeWidth <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(timeWidth * dpr);
    cv.height = Math.round(SONG_ROW_PX * dpr);
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = cv.getContext("2d");
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, timeWidth, SONG_ROW_PX);
    const css = getComputedStyle(cv);
    const color = css.getPropertyValue("--fg-subtle").trim() || "#888";
    const n = peaks.length;
    if (!n || fileMs <= 0) return;
    ctx.fillStyle = color;
    const mid = SONG_ROW_PX / 2;
    for (let x = 0; x < timeWidth; x++) {
      const ms = xToMs(x, pps, scrollMs);
      if (ms < 0 || ms > D) continue;
      const songMs = song.startMs + ms;
      const a = Math.floor((songMs / fileMs) * n);
      const b = Math.max(a + 1, Math.floor(((songMs + 1000 / pps) / fileMs) * n));
      let m = 0;
      for (let i = Math.max(0, a); i < Math.min(n, b); i++) m = Math.max(m, peaks[i] ?? 0);
      const h = Math.max(1, m * (SONG_ROW_PX - 8));
      ctx.fillRect(x, mid - h / 2, 1, h);
    }
  }, [peaks, fileMs, song, pps, scrollMs, timeWidth, D]);

  const dragFade = (e: ReactPointerEvent<HTMLElement>, which: "in" | "out") => {
    if (!project?.song) return;
    e.preventDefault();
    e.stopPropagation();
    const base = project.song;
    const rect = () => area.current?.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      const r = rect();
      if (!r) return;
      const st = useEditStudio.getState();
      const ms = xToMs(ev.clientX - r.left, st.pps, st.scrollMs);
      const cur = st.history?.present;
      if (!cur?.song) return;
      const v = which === "in" ? ms : D - ms;
      const fade = Math.round(Math.max(0, Math.min(10_000, D, v)));
      st.edit({ ...cur, song: { ...base, ...cur.song, [which === "in" ? "fadeInMs" : "fadeOutMs"]: fade } }, `fade-${which}`);
    };
    const baseDoc = project;
    const startPast = useEditStudio.getState().history?.past.length ?? 0;
    const onUp = () => {
      collapseDrag(startPast, baseDoc);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  if (!song) return null;
  const x0 = msToX(0, pps, scrollMs);
  const x1 = msToX(D, pps, scrollMs);
  const fin = (song.fadeInMs * pps) / 1000;
  const fout = (song.fadeOutMs * pps) / 1000;
  const name = song.path.split(/[\\/]/).pop() ?? song.path;
  return (
    <div className={cx(styles.row, styles.songRow)} style={{ height: SONG_ROW_PX }} data-song-row>
      <div className={cx(styles.header, selected && styles.headerSelected)} data-tip="The song track: click to select it and set its volume and fades" onPointerDown={() => useEditStudio.getState().select({ kind: "song" })}>
        <Icon name="music" size={14} className={styles.headerIcon} />
        <span className={styles.trackName} data-tip={optional ? `${name}: the music under the video` : `${name}: the song this edit is cut to`}>
          {name}
        </span>
        <Tooltip label="The song track is locked: it always starts at 0 and can't be moved"><Icon name="lock" size={12} title="The song track is locked" /></Tooltip>
      </div>
      <div className={styles.timeArea} ref={area} onPointerDown={() => useEditStudio.getState().select({ kind: "song" })}>
        <canvas ref={canvas} className={styles.songCanvas} data-tip="Waveform of the song range used by this edit; click to select the song track" style={{ width: timeWidth, height: SONG_ROW_PX }} />
        <div className={styles.songRange} style={{ left: Math.max(0, x0), width: Math.max(0, Math.min(timeWidth, x1) - Math.max(0, x0)) }} aria-hidden="true" />
        <svg className={styles.fades} width={timeWidth} height={SONG_ROW_PX} aria-hidden="true">
          {fin > 1 && <polygon points={`${x0},0 ${x0 + fin},0 ${x0},${SONG_ROW_PX}`} className={styles.fadeShape} />}
          {fout > 1 && <polygon points={`${x1},0 ${x1 - fout},0 ${x1},${SONG_ROW_PX}`} className={styles.fadeShape} />}
        </svg>
        <button type="button" className={styles.fadeHandle} style={{ left: x0 + fin - 5, top: 2 }} aria-label="Fade in length" data-tip="Drag right to fade the song in over this long (up to 10 s)" onPointerDown={(e) => dragFade(e, "in")} />
        <button type="button" className={styles.fadeHandle} style={{ left: x1 - fout - 5, top: 2 }} aria-label="Fade out length" data-tip="Drag left to fade the song out over this long (up to 10 s)" onPointerDown={(e) => dragFade(e, "out")} />
      </div>
    </div>
  );
}

