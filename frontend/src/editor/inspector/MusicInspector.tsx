/** The plain music-bed inspector (SPEC §5.3): which part of the file plays, its volume and fades, and Remove. Edit Studio replaces it with the song inspector. */
import { useEffect, useState } from "react";
import { Button, Section, Slider, Stepper, ToolClickIn } from "@/components";
import type { EditSong } from "@/lib/api";
import { editLength } from "@/viz/edit/types";
import { useProject } from "@/editor/store";
import { useAsMusic } from "../constituents/useUseResult";
import { useEditorProfile } from "../profileContext";
import { addMusic, addMusicFromLibrary, fileDuration, removeMusic } from "../timeline/songFile";
import { editDoc } from "./inspectorState";
import styles from "./inspector.module.css";

const MAX_BED_MS = 600_000;
const MIN_BED_MS = 1000;

export function MusicInspector() {
  const project = useProject();
  const profile = useEditorProfile();
  const path = project?.song?.path ?? "";
  const [fileMs, setFileMs] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    void fileDuration(path).then((d) => live && setFileMs(d));
    return () => {
      live = false;
    };
  }, [path]);
  if (!project) return null;
  if (!project.song)
    return (
      <div className={styles.root} aria-label="Music inspector">
        <Button icon="plus" data-tip="Pick a song or sound file to play under the video; you can trim it and set its volume here" onClick={() => void addMusic()}>
          Add music
        </Button>
        <Button icon="history" variant="secondary" data-tip="Use a song or sound Toolbox already made (the Library)" onClick={() => void addMusicFromLibrary()}>
          From Library…
        </Button>
        <p className={styles.hint}>Music plays under the whole video. You choose which part of the file to use and how loud it is.</p>
      </div>
    );
  const song = project.song;
  const length = song.endMs - song.startMs;
  const total = fileMs > 0 ? fileMs : song.endMs;
  const setSong = (patch: Partial<EditSong>, key: string) => editDoc((p) => (p.song ? { ...p, song: { ...p.song, ...patch } } : p), key);
  const fadeMax = Math.min(10_000, Math.max(0, length));
  const name = song.path.split(/[\\/]/).pop() ?? song.path;
  return (
    <div className={styles.root} aria-label="Music inspector">
      <p className={styles.hint} title={song.path}>{name}</p>
      <Section label="Part" tip="Which part of the music file plays under the video">
        <div className={styles.stack}>
          <div className={styles.row}>
            <span className={styles.label}>Start</span>
            <Stepper
              aria-label="Music start"
              data-tip="Where in the music file it starts, in milliseconds"
              unit="ms"
              min={0}
              max={Math.max(0, song.endMs - MIN_BED_MS)}
              step={100}
              value={song.startMs}
              onChange={(startMs) => setSong({ startMs: Math.round(startMs) }, "music-start")}
            />
          </div>
          <div className={styles.row}>
            <span className={styles.label}>End</span>
            <Stepper
              aria-label="Music end"
              data-tip="Where in the music file it stops, in milliseconds; the video is as long as this part"
              unit="ms"
              min={song.startMs + MIN_BED_MS}
              max={Math.min(total, song.startMs + MAX_BED_MS)}
              step={100}
              value={song.endMs}
              onChange={(endMs) => setSong({ endMs: Math.round(endMs) }, "music-end")}
            />
          </div>
          <p className={styles.hint}>{`The music plays for ${(length / 1000).toFixed(1)} s; the video is ${(editLength(project) / 1000).toFixed(1)} s long.`}</p>
        </div>
      </Section>
      <Section label="Sound" tip="Volume and fades for the music in the export">
        <div className={styles.stack}>
          <span className={styles.label}>Gain</span>
          <Slider data-tip="Make the music louder or quieter in decibels; 0 keeps it as is" aria-label="Music gain" min={-24} max={12} step={0.5} value={song.gainDb} onChange={(gainDb) => setSong({ gainDb }, "song-gain")} format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`} />
          <span className={styles.label}>Fade in</span>
          <Slider data-tip="Fade the music up from silence over this many seconds at the start" aria-label="Fade in" min={0} max={fadeMax} step={100} value={Math.min(song.fadeInMs, fadeMax)} onChange={(fadeInMs) => setSong({ fadeInMs }, "song-fade-in")} format={(v) => `${(v / 1000).toFixed(1)} s`} />
          <span className={styles.label}>Fade out</span>
          <Slider data-tip="Fade the music down to silence over this many seconds at the end" aria-label="Fade out" min={0} max={fadeMax} step={100} value={Math.min(song.fadeOutMs, fadeMax)} onChange={(fadeOutMs) => setSong({ fadeOutMs }, "song-fade-out")} format={(v) => `${(v / 1000).toFixed(1)} s`} />
        </div>
      </Section>
      {/* Edit Studio's song is the analysed one: swapping it would invalidate the analysis. */}
      {profile.song === "optional" && (
        <ToolClickIn host={profile.moduleId} module="stems" inputs={[song.path]} useLabel="Use as music" onUse={(paths) => void useAsMusic(paths)} title="Split into stems" tip="Split this music into vocals, drums, bass and more; Use makes the chosen stem the music" />
      )}
      <Button variant="danger" size="sm" icon="trash-2" data-tip="Take the music out of this video (you can undo it)" onClick={removeMusic}>
        Remove music
      </Button>
    </div>
  );
}
