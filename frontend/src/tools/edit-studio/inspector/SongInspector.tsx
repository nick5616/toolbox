/** The Inspector for the song track: range, gain, fades, cut offset (§14.8). */
import { Button, Section, Slider } from "@/components";
import type { EditSong } from "@/lib/api";
import { editDoc, openRangePicker } from "./inspectorState";
import { useProject } from "../store";
import styles from "./inspector.module.css";

export function formatClock(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

/** "Cuts land N frames early/late" for a cut offset in frames. */
export function cutOffsetText(frames: number): string {
  if (frames === 0) return "Cuts land exactly on the markers.";
  const n = Math.abs(frames);
  return `Cuts land ${n} frame${n === 1 ? "" : "s"} ${frames < 0 ? "early" : "late"}.`;
}

export function SongInspector() {
  const project = useProject();
  if (!project?.song) return <p className={styles.empty}>Choose a song first.</p>;
  const song = project.song;
  const length = song.endMs - song.startMs;
  const setSong = (patch: Partial<EditSong>, key: string) => editDoc((p) => (p.song ? { ...p, song: { ...p.song, ...patch } } : p), key);
  const fadeMax = Math.min(10_000, Math.max(0, length));
  return (
    <div className={styles.root} aria-label="Song inspector">
      <div className={styles.head}>
        <h2 className={styles.title}>Song</h2>
      </div>
      <Section label="Range" action={<Button size="sm" onClick={openRangePicker}>Change range…</Button>}>
        <div className={styles.stack}>
          <div className={styles.row}>
            <span className={styles.label}>From</span>
            <span className={styles.mono}>{formatClock(song.startMs)}</span>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>To</span>
            <span className={styles.mono}>{formatClock(song.endMs)}</span>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>Edit length</span>
            <span className={styles.mono}>{formatClock(length)}</span>
          </div>
        </div>
      </Section>
      <Section label="Sound">
        <div className={styles.stack}>
          <span className={styles.label}>Gain</span>
          <Slider aria-label="Song gain" min={-24} max={12} step={0.5} value={song.gainDb} onChange={(gainDb) => setSong({ gainDb }, "song-gain")} format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`} />
          <span className={styles.label}>Fade in</span>
          <Slider aria-label="Fade in" min={0} max={fadeMax} step={100} value={Math.min(song.fadeInMs, fadeMax)} onChange={(fadeInMs) => setSong({ fadeInMs }, "song-fade-in")} format={(v) => `${(v / 1000).toFixed(1)} s`} />
          <span className={styles.label}>Fade out</span>
          <Slider aria-label="Fade out" min={0} max={fadeMax} step={100} value={Math.min(song.fadeOutMs, fadeMax)} onChange={(fadeOutMs) => setSong({ fadeOutMs }, "song-fade-out")} format={(v) => `${(v / 1000).toFixed(1)} s`} />
        </div>
      </Section>
      <Section label="Cut timing">
        <div className={styles.stack}>
          <span className={styles.label}>Cut offset</span>
          <Slider
            aria-label="Cut offset"
            min={-3}
            max={3}
            step={1}
            value={project.cutOffsetFrames}
            onChange={(cutOffsetFrames) => editDoc((p) => ({ ...p, cutOffsetFrames }), "cut-offset")}
            format={(v) => `${v > 0 ? "+" : ""}${v} fr`}
          />
          <p className={styles.hint}>{cutOffsetText(project.cutOffsetFrames)}</p>
        </div>
      </Section>
    </div>
  );
}
