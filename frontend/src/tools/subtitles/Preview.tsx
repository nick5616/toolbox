import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Banner, Button, EmptyState, Meter, Spinner } from "@/components";
import { MediaPlayer, Timeline, useMediaSource, type ContentRect, type Marker, type MediaPlayerHandle } from "@/components/media";
import { MediaService } from "@/lib/api";
import { getWorkspace } from "@/workspace";
import { CueOverlay } from "./CueOverlay";
import { MediaCtx } from "./host";
import { useRows } from "./hooks";
import { MAX_MARKERS, activeCueIndex } from "./logic";
import { MODULE_ID, useSubtitles } from "./store";
import { MediaFromLibraryButton } from "./library";
import styles from "./SubtitlesView.module.css";

/** A replica reports time at most this often (every report is a relay message). */
const REPLICA_REPORT_MS = 120;

/**
 * The picture (or audio) with the current cue drawn on it and the timeline
 * under it. The main window's copy shares the media the view opened; a popped
 * out copy opens its own. Time and play/pause travel through the store:
 * whichever window has the player reports into it, and every player runs the
 * commands (seek/play/pause) it hasn't seen.
 */
export function SubtitlesPreview() {
  const shared = useContext(MediaCtx);
  const mediaPath = useSubtitles((s) => s.mediaPath);
  const own = useMediaSource(shared ? null : mediaPath);
  const media = shared ?? own;
  const rows = useRows();
  const playheadMs = useSubtitles((s) => s.playheadMs);
  const prefs = useSubtitles((s) => s.prefs);
  const cmd = useSubtitles((s) => s.cmd);
  const seek = useSubtitles((s) => s.seek);
  const reportTime = useSubtitles((s) => s.reportTime);
  const reportPlaying = useSubtitles((s) => s.reportPlaying);
  const pickMedia = useSubtitles((s) => s.pickMedia);
  const playerRef = useRef<MediaPlayerHandle>(null);
  const [filmstripUrl, setFilmstripUrl] = useState<string | undefined>(undefined);
  const [waveform, setWaveform] = useState<number[] | undefined>(undefined);

  const info = media.source?.info;
  const ready = media.status === "ready" && !!media.source;
  const kind = info?.video ? "video" : "audio";
  const activeIndex = useMemo(() => activeCueIndex(rows, playheadMs), [rows, playheadMs]);
  const current = rows[activeIndex];

  // Run player commands this window hasn't seen (a seek from the cue list, play from the other window).
  const seen = useRef(cmd.n);
  useEffect(() => {
    if (cmd.n === seen.current) return;
    seen.current = cmd.n;
    const p = playerRef.current;
    if (!p) return;
    if (cmd.type === "seek") p.seek(cmd.ms);
    else if (cmd.type === "play") p.play();
    else if (cmd.type === "pause") p.pause();
  }, [cmd]);

  // A window that opens later starts where the playhead is.
  useEffect(() => {
    if (!ready) return;
    const ms = useSubtitles.getState().playheadMs;
    if (ms > 0) playerRef.current?.seek(ms);
  }, [ready]);

  // Timeline decorations, loaded locally (never bridged).
  useEffect(() => {
    setFilmstripUrl(undefined);
    setWaveform(undefined);
    if (!mediaPath || !ready) return;
    let cancelled = false;
    if (kind === "video") {
      MediaService.Filmstrip(mediaPath, 24, 48).then((u) => !cancelled && setFilmstripUrl(u)).catch(() => undefined);
    } else {
      MediaService.Waveform(mediaPath, 800).then((w) => !cancelled && setWaveform(w ?? undefined)).catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [mediaPath, ready, kind]);

  const lastReport = useRef(0);
  const onTime = (ms: number) => {
    if (getWorkspace(MODULE_ID)?.isReplica()) {
      const now = Date.now();
      if (now - lastReport.current < REPLICA_REPORT_MS) return;
      lastReport.current = now;
    }
    reportTime(ms);
  };

  const markers = useMemo<Marker[]>(() => {
    const stride = Math.max(1, Math.ceil(rows.length / MAX_MARKERS));
    const out: Marker[] = [];
    for (let i = 0; i < rows.length; i += stride) {
      const r = rows[i];
      if (r) out.push({ id: r.id, startMs: r.startMs, endMs: r.endMs, tone: i === activeIndex ? "accent" : "muted" });
    }
    return out;
  }, [rows, activeIndex]);

  const overlay = (rect: ContentRect) => <CueOverlay rect={rect} text={current?.text ?? ""} style={prefs.style} size={prefs.size} position={prefs.position} font={prefs.font} />;

  if (!mediaPath) {
    return (
      <EmptyState
        icon="film"
        title="No video to preview against"
        body="You can edit without one. Pick the video to see the subtitles on the picture."
        action={
          <div className={styles.buttonRow}>
            <Button icon="film" onClick={() => void pickMedia()} data-tip="Choose the video to preview the subtitles against">
              Pick the video…
            </Button>
            <MediaFromLibraryButton />
          </div>
        }
      />
    );
  }
  if (media.status === "loading" || media.status === "idle") {
    return (
      <div className={styles.center}>
        <Spinner label="Opening the file" /> Opening the file…
      </div>
    );
  }
  if (media.status === "preparing") {
    return (
      <div className={styles.center} role="status">
        <div>Preparing a preview copy… {Math.round((media.progress ?? 0) * 100)}%</div>
        <Meter value={media.progress ?? -1} label="Preview copy" />
      </div>
    );
  }
  if (media.status === "error" || !media.source) {
    return (
      <Banner tone="danger" title={media.error?.message ?? "Couldn't open the file"} action={<Button size="sm" onClick={media.retry} data-tip="Try opening the file again">Try again</Button>}>
        {media.error?.hint}
      </Banner>
    );
  }
  return (
    <div className={styles.previewMain}>
      <MediaPlayer
        ref={playerRef}
        source={media.source}
        kind={kind}
        path={mediaPath}
        onTime={onTime}
        onPlayingChange={reportPlaying}
        overlay={kind === "video" ? overlay : undefined}
        className={styles.player}
      />
      {kind === "audio" && current && <div className={styles.audioCue} data-tip="The subtitle at the playhead">{current.text}</div>}
      <Timeline
        durationMs={info?.durationMs ?? 0}
        playheadMs={playheadMs}
        onSeek={seek}
        filmstripUrl={filmstripUrl}
        waveform={waveform}
        markers={markers}
        onMarkerClick={(id) => {
          const r = rows.find((x) => x.id === id);
          if (r) seek(r.startMs);
        }}
        frameMs={info?.video?.fps ? 1000 / info.video.fps : undefined}
        zoomable
      />
    </div>
  );
}
