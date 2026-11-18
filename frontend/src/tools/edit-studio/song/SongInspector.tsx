/** The Inspector for the song track: range, gain, fades, cut offset (§14.8). */
import { pickFromLibrary } from "@/blocks/library-picker";
import { Button, Section, Slider, toast } from "@/components";
import { FilesService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useUI } from "@/state/ui";
import { useNewEditRequest } from "@/editor/home/newEditRequest";
import { SONG_EXTENSIONS } from "@/editor/transport/logic";
import type { EditSong } from "@/lib/api";
import { editDoc, openRangePicker } from "@/editor/inspector/inspectorState";
import { useEditStudio, useProject } from "@/editor/store";
import styles from "@/editor/inspector/inspector.module.css";

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

/** Picks another song; the replace dialog asks whether to keep the clips. */
async function changeSong(fromLibrary = false): Promise<void> {
  try {
    const picked = fromLibrary
      ? await pickFromLibrary({ title: "Pick a song from Library", exts: SONG_EXTENSIONS, multiple: false, have: useEditStudio.getState().history?.present.song ? [useEditStudio.getState().history?.present.song?.path ?? ""] : undefined })
      : ((await FilesService.PickWith("Pick a song", SONG_EXTENSIONS, false)) ?? []);
    const p = picked[0];
    if (p) useNewEditRequest.getState().askSong(p);
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
  }
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
      <Section label="Range" tip="Which part of the song the edit uses" action={<Button size="sm" data-tip="Pick a different start and end in the song; clips keep their place on the timeline" onClick={openRangePicker}>Change range…</Button>}>
        <div className={styles.stack}>
          <div className={styles.row} data-tip="Where in the full song the edit starts (minutes:seconds)">
            <span className={styles.label}>From</span>
            <span className={styles.mono}>{formatClock(song.startMs)}</span>
          </div>
          <div className={styles.row} data-tip="Where in the full song the edit ends (minutes:seconds)">
            <span className={styles.label}>To</span>
            <span className={styles.mono}>{formatClock(song.endMs)}</span>
          </div>
          <div className={styles.row} data-tip="How long the finished video is (minutes:seconds)">
            <span className={styles.label}>Edit length</span>
            <span className={styles.mono}>{formatClock(length)}</span>
          </div>
        </div>
      </Section>
      <Section label="Analysis" tip="The beats, drops and sections found in the song" action={<Button size="sm" data-tip="Run the song analysis again, e.g. to add lyrics; your clips and markers are kept" onClick={() => useEditStudio.getState().setReanalyze(true)}>Analyze again…</Button>}>
        <p className={styles.hint}>Analyze again to add the lyrics or pick up a newer AI engine. Your clips and markers are kept.</p>
      </Section>
      <Section label="Sound" tip="Volume and fades for the song in the export">
        <div className={styles.stack}>
          <span className={styles.label}>Gain</span>
          <Slider data-tip="Make the song louder or quieter in decibels; 0 keeps it as is" aria-label="Song gain" min={-24} max={12} step={0.5} value={song.gainDb} onChange={(gainDb) => setSong({ gainDb }, "song-gain")} format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`} />
          <span className={styles.label}>Fade in</span>
          <Slider data-tip="Fade the song up from silence over this many seconds at the start" aria-label="Fade in" min={0} max={fadeMax} step={100} value={Math.min(song.fadeInMs, fadeMax)} onChange={(fadeInMs) => setSong({ fadeInMs }, "song-fade-in")} format={(v) => `${(v / 1000).toFixed(1)} s`} />
          <span className={styles.label}>Fade out</span>
          <Slider data-tip="Fade the song down to silence over this many seconds at the end" aria-label="Fade out" min={0} max={fadeMax} step={100} value={Math.min(song.fadeOutMs, fadeMax)} onChange={(fadeOutMs) => setSong({ fadeOutMs }, "song-fade-out")} format={(v) => `${(v / 1000).toFixed(1)} s`} />
        </div>
      </Section>
      <Section label="Song file" tip="Use a different song, or split this one into stems">
        <div className={styles.stack}>
          <Button size="sm" icon="music" data-tip="Pick a different song; you choose whether to keep your clips" onClick={() => void changeSong()}>
            Change song…
          </Button>
          <Button size="sm" icon="history" data-tip="Pick a different song from files Toolbox already made (the Library); you choose whether to keep your clips" onClick={() => void changeSong(true)}>
            Song from Library…
          </Button>
          <Button size="sm" icon="audio-lines" data-tip="Open the Stems tool to separate the song into vocals, drums, bass and other" onClick={() => useUI.getState().handOff({ moduleId: "stems", inputs: [song.path] })}>
            Split into stems…
          </Button>
        </div>
      </Section>
    </div>
  );
}
