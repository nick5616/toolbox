/**
 * The workspace's preview (part `lyric-video.preview`): the approximate HTML
 * picture of the video at the playhead (backdrop, visuals, title card, words).
 * It fits both the width and the height of the room it gets. In the main
 * window it follows the player under it; in a pop-out window it follows the
 * host's playhead and forwards play/pause (the host owns the audio).
 */
import { useEffect, useMemo, useState } from "react";
import { IconButton } from "@/components";
import { formatMs } from "@/components/media";
import { VisualsCanvas } from "@/components/viz";
import { loadRef } from "@/components/viz/useVisualsAnalysis";
import { useElementSize } from "@/lib/useElementSize";
import { getWorkspace } from "@/workspace";
import type { Analysis } from "@/viz/analysis";
import { Preview } from "./Preview";
import { LYRIC_VIDEO_ID, useLyricVideo } from "./store";
import { aspectNumber, previewShow } from "./visuals";
import styles from "./panels.module.css";

/** The analysis the backdrop draws: the host's live one, or (in a window) the one loaded from the host's ref. */
function useBackdropAnalysis(): Analysis | null {
  const hostAnalysis = useLyricVideo((s) => s.listening?.analysis ?? null);
  const ref = useLyricVideo((s) => s.listenRef);
  const [loaded, setLoaded] = useState<{ key: string; analysis: Analysis } | null>(null);
  useEffect(() => {
    if (hostAnalysis || !ref) return;
    let off = false;
    loadRef(ref)
      .then((a) => !off && setLoaded({ key: ref.key, analysis: a }))
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [hostAnalysis, ref]);
  return hostAnalysis ?? (ref && loaded?.key === ref.key ? loaded.analysis : null);
}

/** The picture, sized to fit its room. */
export function PreviewStage() {
  const prefs = useLyricVideo((s) => s.prefs);
  const meta = useLyricVideo((s) => s.meta);
  const rows = useLyricVideo((s) => s.rows);
  const playheadMs = useLyricVideo((s) => s.playheadMs);
  const coverUrl = useLyricVideo((s) => s.coverUrl);
  const imageUrl = useLyricVideo((s) => s.imageUrl);
  const analysis = useBackdropAnalysis();
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const { width, height } = useElementSize(box);
  const look = prefs.look;
  const ratio = aspectNumber(prefs.aspect);
  const show = useMemo(() => (look.background === "visualizer" ? previewShow(look.visuals) : null), [look.background, look.visuals]);
  const w = width > 0 && height > 0 ? Math.floor(Math.min(width, height * ratio)) : 0;
  const lyricLook = useMemo(() => ({ ...look, title: meta.title, artist: meta.artist }), [look, meta]);
  return (
    <div className={styles.fit} ref={setBox} data-testid="preview-fit">
      <div style={w > 0 ? { width: w } : { width: "100%" }}>
        <Preview
          look={lyricLook}
          aspect={prefs.aspect}
          rows={rows}
          ms={playheadMs}
          coverUrl={coverUrl}
          imageUrl={imageUrl}
          backdropNode={
            show && analysis ? <VisualsCanvas show={show} analysis={analysis} timeMs={playheadMs} aspect={ratio} mode="opaque" cover={coverUrl ?? null} /> : undefined
          }
        />
      </div>
    </div>
  );
}

export default function LyricVideoPreviewPart() {
  const playing = useLyricVideo((s) => s.playing);
  const playheadMs = useLyricVideo((s) => s.playheadMs);
  const songPath = useLyricVideo((s) => s.songPath);
  const replica = getWorkspace(LYRIC_VIDEO_ID)?.isReplica() ?? false;
  if (!songPath) return <div className={styles.transport}>Nothing to preview yet.</div>;
  return (
    <div className={styles.partRoot}>
      <PreviewStage />
      {replica && (
        <div className={styles.transport}>
          <IconButton icon={playing ? "pause" : "play"} label={playing ? "Pause" : "Play"} data-tip="Play or pause the song in the main window" onClick={() => useLyricVideo.getState().togglePlay()} />
          <span>{formatMs(playheadMs)}</span>
        </div>
      )}
    </div>
  );
}
