/**
 * Transport bar and the playback clock (Phase 9 SPEC §14.7, Phase 21 §B1).
 * The clock runs on AudioContext time (`editor/audio`), so Play works with or
 * without a song and clip sounds are mixed with it. The `PlayerController`
 * (./player.ts) is registered here for the shortcuts and the palette.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { pickFromLibrary } from "@/blocks/library-picker";
import { Banner, Button, IconButton, MenuButton, toast } from "@/components";
import { useMediaSource } from "@/components/media";
import { EditStudioService, FilesService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { HEADER_PX } from "@/editor/geometry";
import { useEditStudio, useProject } from "@/editor/store";
import { buildProjectAudio, audioLengthMs } from "@/editor/audio/project";
import { createAudioEngine, useAudioLoading, type AudioEngine } from "@/editor/audio/engine";
import { fitPps, formatTimecode, keepsRange, parseTimecode, SONG_EXTENSIONS } from "./logic";
import { createPlayer, registerPlayer, seekTo } from "./player";
import styles from "./Transport.module.css";

/** The playhead readout: HH:MM:SS:FF; click to type a time, Enter seeks. Its own component so only it re-renders per frame. */
function Timecode({ fps, lengthMs }: { fps: number; lengthMs: number }) {
  const playheadMs = useEditStudio((s) => s.playheadMs);
  const [text, setText] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (text !== null) input.current?.select();
  }, [text === null]); // eslint-disable-line react-hooks/exhaustive-deps -- select once when editing starts

  const commit = () => {
    if (text === null) return;
    const ms = parseTimecode(text, fps);
    if (ms === null) {
      setInvalid(true);
      return;
    }
    seekTo(Math.min(ms, lengthMs));
    setText(null);
    setInvalid(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation(); // typing must not trigger the editor's shortcuts
    if (e.key === "Enter") commit();
    else if (e.key === "Escape") {
      setText(null);
      setInvalid(false);
    }
  };
  return (
    <span className={styles.timeWrap}>
      {text === null ? (
        <button type="button" className={styles.time} aria-label="Time" data-tip="Playhead time (hours:minutes:seconds:frames). Click to type a time and press Enter to jump there" onClick={() => setText(formatTimecode(playheadMs, fps))}>
          {formatTimecode(playheadMs, fps)}
        </button>
      ) : (
        <input
          ref={input}
          className={styles.timeInput}
          aria-label="Go to time"
          aria-invalid={invalid || undefined}
          data-tip="Type a time as hours:minutes:seconds:frames (or plain seconds) and press Enter. Escape cancels"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setInvalid(false);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            setText(null);
            setInvalid(false);
          }}
          spellCheck={false}
          autoComplete="off"
        />
      )}
      <span className={styles.total} data-tip="Total length of the edit">
        / {formatTimecode(lengthMs, fps)}
      </span>
    </span>
  );
}

export function Transport() {
  const project = useProject();
  const song = project?.song ?? null;
  const D = project ? audioLengthMs(project) : 0;
  const media = useMediaSource(song?.path ?? null);
  const playing = useEditStudio((s) => s.playing);
  const snap = useEditStudio((s) => s.snap);
  const pps = useEditStudio((s) => s.pps);
  const quality = useEditStudio((s) => s.previewQuality);
  const scrubAudio = useEditStudio((s) => s.scrubAudio);
  const sources = useEditStudio((s) => s.sources);
  const loadingAudio = useAudioLoading();
  const rootRef = useRef<HTMLDivElement>(null);

  const live = useRef({ D, songPath: song?.path ?? "", sources });
  live.current = { D, songPath: song?.path ?? "", sources };
  const engineRef = useRef<AudioEngine | null>(null);

  // The audio engine, the clock and the controller live while the transport does.
  useEffect(() => {
    const engine = createAudioEngine({
      length: () => live.current.D,
      resolve: (path) => live.current.sources[path]?.audio || (path === live.current.songPath ? path : null),
    });
    engineRef.current = engine;
    const player = createPlayer({ clock: engine.clock, mixer: engine.mixer });
    const unregister = registerPlayer(player);
    engine.mixer?.setScrubAudio(useEditStudio.getState().scrubAudio);
    return () => {
      unregister();
      player.dispose();
      engine.dispose();
      engineRef.current = null;
      useEditStudio.getState().setPlaying(false);
    };
  }, []);

  // The mixer plays what the document says.
  useEffect(() => {
    if (project) engineRef.current?.mixer?.setProject(buildProjectAudio(project, sources));
  }, [project, sources]);
  useEffect(() => {
    engineRef.current?.mixer?.setScrubAudio(scrubAudio);
  }, [scrubAudio]);

  const toggle = () => {
    const st = useEditStudio.getState();
    st.setPlaying(!st.playing);
  };

  const missing = !!song && media.status === "error";
  const [finding, setFinding] = useState(false);
  const findSong = async (fromLibrary = false) => {
    if (!project?.song || finding) return;
    setFinding(true);
    try {
      const picked = fromLibrary
        ? await pickFromLibrary({ title: "Find the song in Library", exts: SONG_EXTENSIONS, multiple: false })
        : ((await FilesService.PickWith("Find the song", SONG_EXTENSIONS, false)) ?? []);
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

  const zoom = (factor: number) => {
    const st = useEditStudio.getState();
    st.setView(st.pps * factor, st.scrollMs);
  };
  const fit = () => {
    const w = (rootRef.current?.clientWidth ?? 0) - HEADER_PX;
    useEditStudio.getState().setView(fitPps(w, D), 0);
  };
  const moreItems = useCallback(
    () => [
      {
        id: "scrub",
        label: scrubAudio ? "Scrub audio: on" : "Scrub audio: off",
        icon: scrubAudio ? "volume-2" : "volume-x",
        tip: "Play a short grain of sound when you drag the playhead or step by a frame",
        onSelect: () => useEditStudio.getState().setScrubAudio(!scrubAudio),
      },
    ],
    [scrubAudio],
  );

  if (!project) return null;
  return (
    <div className={styles.bar} ref={rootRef} role="toolbar" aria-label="Transport">
      <IconButton icon={playing ? "pause" : "play"} label={playing ? "Pause" : "Play"} data-tip={playing ? "Pause playback" : "Play the edit from the playhead (clip sounds and the song)"} kbd="Space" onClick={toggle} />
      <Timecode fps={project.fps} lengthMs={D} />
      {loadingAudio && (
        <span className={styles.loading} role="status" aria-label="Loading audio" data-tip="Decoding the edit's sound so it can play">
          <span className={styles.dot} /> Loading audio
        </span>
      )}
      <Button size="sm" variant={quality === "draft" ? "secondary" : "ghost"} icon="gauge" aria-pressed={quality === "draft"} data-tip={quality === "draft" ? "Draft preview: smaller and faster while you edit. Click for full quality" : "Full-quality preview. Click for a smaller, faster draft preview"} onClick={() => useEditStudio.getState().setPreviewQuality(quality === "draft" ? "full" : "draft")}>
        {quality === "draft" ? "Draft" : "Full"}
      </Button>
      <Button size="sm" variant={snap ? "secondary" : "ghost"} icon="grid-3x3" aria-pressed={snap} data-tip={snap ? "Snap is on: clips and the playhead stick to markers and clip edges (Alt skips it while dragging)" : "Snap is off: clips move freely instead of sticking to markers and clip edges"} onClick={() => useEditStudio.getState().setSnap(!snap)}>
        Snap
      </Button>
      <span className={styles.spacer} />
      <IconButton icon="zoom-out" label="Zoom out" size="sm" data-tip={pps <= 6 ? "Fully zoomed out" : "Show more of the timeline (the wheel over the timeline also zooms)"} onClick={() => zoom(1 / 1.5)} disabled={pps <= 6} />
      <IconButton icon="zoom-in" label="Zoom in" size="sm" data-tip={pps >= 800 ? "Fully zoomed in" : "Show less of the timeline in more detail (the wheel over the timeline also zooms)"} onClick={() => zoom(1.5)} disabled={pps >= 800} />
      <Button size="sm" variant="secondary" data-tip="Zoom so the whole edit fits the timeline" onClick={fit}>
        Fit
      </Button>
      <MenuButton label="More transport options" icon="ellipsis" variant="ghost" size="sm" items={moreItems} tip="More playback options" />
      {missing && (
        <Banner
          tone="warn"
          title="The song file is missing"
          action={
            <>
              <Button size="sm" data-tip="Pick the song file again; markers and clips are kept" onClick={() => void findSong()} disabled={finding}>
                Find the song…
              </Button>
              <Button size="sm" variant="secondary" icon="history" data-tip="Pick the song from files Toolbox already made (the Library); markers and clips are kept" onClick={() => void findSong(true)} disabled={finding}>
                From Library…
              </Button>
            </>
          }
          className={styles.banner}
        >
          Playback needs it. Markers and clips are kept.
        </Banner>
      )}
    </div>
  );
}
