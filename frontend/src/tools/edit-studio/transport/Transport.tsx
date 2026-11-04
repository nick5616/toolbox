/**
 * Transport bar and the playback clock (Phase 9 SPEC §14.7). A hidden audio
 * MediaPlayer on the song is the clock: its time becomes the playhead, the
 * volume follows the gain and fades, playback stops at D. Keyboard shortcuts
 * reach the player through ./player.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banner, Button, IconButton, Select, Stepper, toast } from "@/components";
import { MediaPlayer, formatMs, useMediaSource, type MediaPlayerHandle } from "@/components/media";
import { EditStudioService, FilesService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { editLength, MARKER_LANES, type MarkerLane } from "@/viz/edit/types";
import { HEADER_PX } from "../geometry";
import { useEditStudio, useProject } from "../store";
import { fitPps, keepsRange, SONG_EXTENSIONS, songVolume, visibleLanes } from "./logic";
import { registerPlayer, type PlayerController } from "./player";
import styles from "./Transport.module.css";



export function Transport() {
  const project = useProject();
  const song = project?.song ?? null;
  const D = project ? editLength(project) : 0;
  const media = useMediaSource(song?.path ?? null);
  const playing = useEditStudio((s) => s.playing);
  const playheadMs = useEditStudio((s) => s.playheadMs);
  const activeLane = useEditStudio((s) => s.activeLane);
  const snap = useEditStudio((s) => s.snap);
  const safeZones = useEditStudio((s) => s.safeZones);
  const pps = useEditStudio((s) => s.pps);
  const handle = useRef<MediaPlayerHandle>(null);
  const hiddenRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const clock = useRef(0);
  const rate = useRef(1);
  const live = useRef({ song, D });
  live.current = { song, D };

  const startMs = song?.startMs ?? 0;
  const source = useMemo(
    () => (media.source && song ? { ...media.source, info: { ...media.source.info, startMs, durationMs: D } } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- song only matters through startMs and D
    [media.source, startMs, D, !!song],
  );

  const el = useCallback((): HTMLMediaElement | null => hiddenRef.current?.querySelector("audio, video") ?? null, []);
  const setRate = useCallback(
    (r: number) => {
      rate.current = r;
      const m = el();
      if (m) m.playbackRate = r;
    },
    [el],
  );

  const onTime = useCallback(
    (ms: number) => {
      clock.current = ms;
      const { song: s, D: d } = live.current;
      if (!s) return;
      const st = useEditStudio.getState();
      if (d > 0 && ms >= d) {
        if (handle.current?.playing()) handle.current.pause();
        st.setPlayhead(d);
        return;
      }
      st.setPlayhead(ms);
      const m = el();
      if (m) m.volume = songVolume(s, ms, d);
    },
    [el],
  );

  const ctrl = useMemo<PlayerController>(
    () => ({
      play: () => {
        setRate(1);
        handle.current?.play();
      },
      pause: () => handle.current?.pause(),
      toggle: () => (handle.current?.playing() ? handle.current.pause() : (setRate(1), handle.current?.play())),
      seek: (ms) => {
        const t = Math.max(0, live.current.D > 0 ? Math.min(ms, live.current.D) : ms);
        if (handle.current) handle.current.seek(t);
        else useEditStudio.getState().setPlayhead(t);
      },
      setRate,
      rate: () => rate.current,
    }),
    [setRate],
  );
  useEffect(() => registerPlayer(ctrl), [ctrl]);

  // The store's `playing` (anyone may set it) drives the audio.
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    if (playing && !h.playing()) ctrl.play();
    else if (!playing && h.playing()) h.pause();
  }, [playing, ctrl]);

  // A playhead moved from outside (ruler click, marker jump) seeks the audio.
  useEffect(() => {
    if (Math.abs(playheadMs - clock.current) > 60) handle.current?.seek(Math.min(playheadMs, live.current.D || playheadMs));
  }, [playheadMs]);

  // A new source (or range start) puts the audio where the playhead is.
  const url = source?.url ?? "";
  useEffect(() => {
    if (url) handle.current?.seek(useEditStudio.getState().playheadMs);
  }, [url, startMs]);

  const onPlayingChange = useCallback(
    (p: boolean) => {
      useEditStudio.getState().setPlaying(p);
      if (!p) setRate(1);
    },
    [setRate],
  );

  const missing = !!song && media.status === "error";
  const [finding, setFinding] = useState(false);
  const findSong = async () => {
    if (!project?.song || finding) return;
    setFinding(true);
    try {
      const picked = (await FilesService.PickWith("Find the song", SONG_EXTENSIONS, false)) ?? [];
      const path = picked[0];
      if (!path) return;
      const info = (await EditStudioService.Probe([path]))?.[0];
      const dur = info?.durationMs ?? 0;
      const cur = project.song;
      const keep = keepsRange(dur, cur);
      const next = { ...cur, path, ...(keep ? {} : { startMs: 0, endMs: Math.min(dur, 600_000) }) };
      useEditStudio.getState().edit({ ...project, song: next }, "song-path");
      media.retry();
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    } finally {
      setFinding(false);
    }
  };

  const laneOptions = useMemo(() => {
    const shown = project ? visibleLanes(project) : [];
    const lanes: MarkerLane[] = shown.includes(activeLane) ? shown : MARKER_LANES.filter((l) => l === activeLane || shown.includes(l));
    return lanes.map((l) => ({ value: l, label: l }));
  }, [project, activeLane]);

  const zoom = (factor: number) => {
    const st = useEditStudio.getState();
    st.setView(st.pps * factor, st.scrollMs);
  };
  const fit = () => {
    const w = (rootRef.current?.clientWidth ?? 0) - HEADER_PX;
    useEditStudio.getState().setView(fitPps(w, D), 0);
  };

  if (!project) return null;
  return (
    <div className={styles.bar} ref={rootRef} role="toolbar" aria-label="Transport">
      <div ref={hiddenRef} hidden>
        {source && <MediaPlayer ref={handle} source={source} kind="audio" keyboard={false} onTime={onTime} onPlayingChange={onPlayingChange} />}
      </div>
      <IconButton icon={playing ? "pause" : "play"} label={playing ? "Pause" : "Play"} data-tip={!source ? "The song isn't loaded yet, or its file is missing" : playing ? "Pause the song and the preview" : "Play the edit with the song from the playhead"} kbd="Space" disabled={!source} onClick={() => ctrl.toggle()} />
      <span className={styles.time} aria-label="Time" data-tip="Playhead time / total length of the edit (minutes:seconds.tenths)">
        {formatMs(playheadMs)} / {formatMs(D)}
      </span>
      <label className={styles.field} data-tip="The marker lane that Snap, marker jumps, Slice and Cut to beat follow">
        <span className={styles.label}>Lane</span>
        <Select<MarkerLane> size="sm" aria-label="Active lane" data-tip="The marker lane that Snap, marker jumps, Slice and Cut to beat follow" value={activeLane} options={laneOptions} onChange={(l) => useEditStudio.getState().setActiveLane(l)} />
      </label>
      <Button size="sm" variant={snap ? "primary" : "secondary"} icon="grid-3x3" aria-pressed={snap} data-tip={snap ? "Snap is on: clips and the playhead stick to markers and clip edges (Alt skips it while dragging)" : "Snap is off: clips move freely instead of sticking to markers and clip edges"} onClick={() => useEditStudio.getState().setSnap(!snap)}>
        Snap
      </Button>
      <label className={styles.field} data-tip="Shift every beat-synced cut earlier or later by this many frames (-3 to 3), to feel tighter on the music">
        <span className={styles.label}>Cut offset</span>
        <Stepper
          aria-label="Cut offset in frames"
          value={project.cutOffsetFrames}
          min={-3}
          max={3}
          onChange={(v) => useEditStudio.getState().edit({ ...project, cutOffsetFrames: Math.max(-3, Math.min(3, Math.round(v))) }, "cut-offset")}
        />
      </label>
      <span className={styles.spacer} />
      <IconButton icon="zoom-out" label="Zoom out" size="sm" data-tip={pps <= 6 ? "Fully zoomed out" : "Show more of the timeline (the wheel over the timeline also zooms)"} onClick={() => zoom(1 / 1.5)} disabled={pps <= 6} />
      <IconButton icon="zoom-in" label="Zoom in" size="sm" data-tip={pps >= 800 ? "Fully zoomed in" : "Show less of the timeline in more detail (the wheel over the timeline also zooms)"} onClick={() => zoom(1.5)} disabled={pps >= 800} />
      <Button size="sm" variant="secondary" data-tip="Zoom so the whole edit fits the timeline" onClick={fit}>
        Fit
      </Button>
      <IconButton icon="frame" label="Safe zones" data-tip="Shade the parts of the picture that Instagram's buttons and captions cover (tall and portrait shapes)" size="sm" pressed={safeZones} onClick={() => useEditStudio.getState().setSafeZones(!safeZones)} />
      {missing && (
        <Banner
          tone="warn"
          title="The song file is missing"
          action={
            <Button size="sm" data-tip="Pick the song file again; markers and clips are kept" onClick={() => void findSong()} disabled={finding}>
              Find the song…
            </Button>
          }
          className={styles.banner}
        >
          Playback needs it. Markers and clips are kept.
        </Banner>
      )}
    </div>
  );
}
