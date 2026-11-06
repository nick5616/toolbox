/**
 * The pop-out preview: the designer's own Preview over a replica of the
 * Visualizer store. It plays the song itself and loads the analysis from the
 * cache by the host's analyze options; the playhead goes back to the host.
 */
import { useEffect, useRef, useState } from "react";
import { Banner, Spinner } from "@/components";
import type { MediaPlayerHandle } from "@/components/media";
import { useVisualsAnalysis } from "@/components/viz";
import { useShortcut } from "@/lib/shortcuts";
import { Preview } from "@/blocks/visuals/designer/Preview";
import { useVisualizer } from "./store";
import styles from "./PreviewPart.module.css";

/** Seeks when the host's playhead differs from the local clock by more than this. */
export const SEEK_THRESHOLD_MS = 250;

/** Calls `seek(hostMs)` when `hostMs` is not one of our own recent reports and is a seek away from `localMs`. Returns whether it did. */
export function followHostSeek(hostMs: number, localMs: number, reported: readonly number[], seek: (ms: number) => void): boolean {
  if (reported.includes(hostMs) || Math.abs(hostMs - localMs) <= SEEK_THRESHOLD_MS) return false;
  seek(hostMs);
  return true;
}

export default function VisualizerPreviewPart() {
  const input = useVisualizer((s) => s.input);
  const show = useVisualizer((s) => s.show);
  const mode = useVisualizer((s) => s.mode);
  const aspect = useVisualizer((s) => s.aspect);
  const analyze = useVisualizer((s) => s.analyze);
  const loaded = useVisualsAnalysis(input, { analyze, auto: false });
  const [timeMs, setTimeMs] = useState(0);
  const ownPlayer = useRef<MediaPlayerHandle>(null);
  const toggleFs = useRef<(() => void) | null>(null);

  // The host's Song Map and meters follow this window's playhead (a few times a second).
  const last = useRef(0);
  const sent = useRef<number[]>([]);
  const timeRef = useRef(timeMs);
  timeRef.current = timeMs;
  useEffect(() => {
    if (Math.abs(timeMs - last.current) < 200) return;
    last.current = timeMs;
    const ms = Math.round(timeMs);
    sent.current = [...sent.current.slice(-15), ms];
    useVisualizer.getState().setPlayheadMs(ms);
  }, [timeMs]);

  // A host seek (a playhead that isn't an echo of ours and is far from our clock) moves this player.
  const hostMs = useVisualizer((s) => s.playheadMs);
  useEffect(() => {
    followHostSeek(hostMs, timeRef.current, sent.current, (ms) => {
      ownPlayer.current?.seek(ms);
      setTimeMs(ms);
    });
  }, [hostMs]);
  useShortcut("f", () => toggleFs.current?.());

  if (!input || !show) return <div className={styles.wait}>Nothing to preview yet.</div>;
  if (loaded.status === "error") {
    return (
      <Banner tone="danger" title={loaded.error?.message ?? "Couldn't load the analysis"}>
        {loaded.error?.hint}
      </Banner>
    );
  }
  if (!loaded.analysis) {
    return (
      <div className={styles.wait}>
        <Spinner size={18} label="Loading" /> Loading the analysis…
      </div>
    );
  }
  return (
    <div className={styles.root}>
      <Preview inputPath={input} analysis={loaded.analysis} show={show} aspect={aspect} mode={mode} hostPlayer={null} ownPlayer={ownPlayer} text="engine" timeMs={timeMs} onTime={setTimeMs} fsRef={toggleFs} />
    </div>
  );
}
