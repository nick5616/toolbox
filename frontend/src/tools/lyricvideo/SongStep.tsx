import { Banner, Button, DropZone, Icon, Section, SegmentedControl, Spinner, TextField } from "@/components";
import type { MediaSourceState } from "@/components/media";
import { formatMs } from "@/components/media";
import { basename, type Row } from "./logic";
import styles from "./LyricVideoView.module.css";

export interface SongStepProps {
  songPath: string | null;
  media: MediaSourceState;
  coverUrl: string | undefined;
  title: string;
  artist: string;
  onTitle: (t: string) => void;
  onArtist: (a: string) => void;
  audio: string;
  onAudio: (a: string) => void;
  hasInstrumental: boolean;
  rows: Row[];
  onPick: () => void;
  onContinue: () => void;
}

/** Step 1: pick the song, its title/artist and which audio to use. */
export function SongStep(p: SongStepProps) {
  if (!p.songPath) {
    return (
      <div className={styles.sourceEmpty}>
        <DropZone
          id="tool-drop:lyric-video"
          icon="mic-vocal"
          label="Drop a song"
          hint="Turn a song and its lyrics into a video with the words on screen."
        >
          <div className={styles.buttonRow}>
            <Button icon="plus" onClick={p.onPick}>
              Choose a song…
            </Button>
          </div>
        </DropZone>
      </div>
    );
  }
  const info = p.media.source?.info;
  const ready = p.media.status === "ready";
  return (
    <div className={styles.songBody}>
      <div className={styles.songCard}>
        <div className={styles.cover} aria-label="Cover art">
          {p.coverUrl ? <img src={p.coverUrl} alt="" /> : <Icon name="music" size={32} />}
        </div>
        <div className={styles.songInfo}>
          <div className={styles.fileName} title={p.songPath}>
            {basename(p.songPath)}
          </div>
          <div className={styles.fileMeta}>
            {p.media.status === "loading" && (
              <>
                <Spinner size={12} /> Reading the file…
              </>
            )}
            {p.media.status === "preparing" && "Preparing a preview copy…"}
            {p.media.status === "error" && (p.media.error?.message ?? "Couldn't read this file")}
            {info && `${formatMs(info.durationMs)}${info.hasCover ? " · has cover art" : " · no cover art"}`}
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={p.onPick}>
          Change
        </Button>
      </div>

      {p.media.status === "error" && (
        <Banner tone="danger" title={p.media.error?.message ?? "Couldn't open this song"} action={<Button size="sm" onClick={p.media.retry}>Try again</Button>}>
          {p.media.error?.hint}
        </Banner>
      )}

      <Section label="Title and artist">
        <div className={styles.form}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Title</span>
            <TextField aria-label="Title" value={p.title} onChange={(e) => p.onTitle(e.target.value)} placeholder="Song title" />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Artist</span>
            <TextField aria-label="Artist" value={p.artist} onChange={(e) => p.onArtist(e.target.value)} placeholder="Artist" />
          </label>
          <span className={styles.hint}>Shown on the title card at the start of the video.</span>
        </div>
      </Section>

      <Section label="Audio in the video">
        <div className={styles.form}>
          <SegmentedControl
            aria-label="Audio"
            value={p.audio}
            options={[
              { value: "original", label: "Original" },
              { value: "instrumental", label: "Instrumental (karaoke)" },
            ]}
            onChange={p.onAudio}
          />
          {p.audio === "instrumental" && (
            <span className={styles.hint}>
              Makes a vocals-free version on the AI engine{p.hasInstrumental ? " (already made for this song)" : ""}.
            </span>
          )}
        </div>
      </Section>

      <div className={styles.footer}>
        <Button onClick={p.onContinue} disabled={!ready}>
          {p.rows.length > 0 ? "Continue to Lyrics" : "Next: Lyrics"}
        </Button>
      </div>
    </div>
  );
}
