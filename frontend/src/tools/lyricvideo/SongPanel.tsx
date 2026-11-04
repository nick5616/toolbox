/**
 * The Song panel (formerly the Song step): the file, its title and artist (for
 * the title card) and which audio the video carries. Opened by the header's
 * song chip. Picks a file, so it only opens inline.
 */
import { Banner, Button, Section, SegmentedControl, Spinner, TextField, Icon } from "@/components";
import { formatMs, useMediaSource } from "@/components/media";
import { DepsGate } from "@/tools/_kit";
import { useChooseSong } from "./actions";
import { useEngineGate } from "./engine";
import { basename } from "./logic";
import { LYRIC_VIDEO_ID, useLyricVideo } from "./store";
import styles from "./panels.module.css";

export default function SongPanel() {
  const songPath = useLyricVideo((s) => s.songPath);
  const meta = useLyricVideo((s) => s.meta);
  const audio = useLyricVideo((s) => s.prefs.audio);
  const hasInstrumental = useLyricVideo((s) => s.hasInstrumental);
  const coverUrl = useLyricVideo((s) => s.coverUrl);
  const media = useMediaSource(songPath);
  const choose = useChooseSong();
  const gate = useEngineGate("render");
  const info = media.source?.info;
  if (!songPath) return null;
  const st = useLyricVideo.getState;
  return (
    <div className={styles.panel}>
      <div className={styles.songCard}>
        <div className={styles.cover} aria-label="Cover art" data-tip="The cover art embedded in the song">
          {coverUrl ? <img src={coverUrl} alt="" /> : <Icon name="music" size={32} />}
        </div>
        <div className={styles.songInfo}>
          <div className={styles.fileName} data-tip={songPath}>
            {basename(songPath)}
          </div>
          <div className={styles.hint}>
            {media.status === "loading" && (
              <>
                <Spinner size={12} /> Reading the file…
              </>
            )}
            {media.status === "preparing" && "Preparing a preview copy…"}
            {media.status === "error" && (media.error?.message ?? "Couldn't read this file")}
            {info && `${formatMs(info.durationMs)}${info.hasCover ? " · has cover art" : " · no cover art"}`}
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => void choose()} data-tip="Choose a different song">
          Change
        </Button>
      </div>

      {media.status === "error" && (
        <Banner tone="danger" title={media.error?.message ?? "Couldn't open this song"} action={<Button size="sm" onClick={media.retry} data-tip="Try reading the song again">Try again</Button>}>
          {media.error?.hint}
        </Banner>
      )}

      <Section label="Title and artist" tip="Used on the title card at the start of the video">
        <div className={styles.form}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Title</span>
            <TextField aria-label="Title" data-tip="The song title for the title card" value={meta.title} onChange={(e) => st().setMeta((m) => ({ ...m, title: e.target.value }))} placeholder="Song title" />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Artist</span>
            <TextField aria-label="Artist" data-tip="The artist name for the title card" value={meta.artist} onChange={(e) => st().setMeta((m) => ({ ...m, artist: e.target.value }))} placeholder="Artist" />
          </label>
          <span className={styles.hint}>Shown on the title card at the start of the video.</span>
        </div>
      </Section>

      <Section label="Audio in the video" tip="Which version of the sound the finished video carries">
        <div className={styles.form}>
          <SegmentedControl
            aria-label="Audio"
            value={audio}
            options={[
              { value: "original", label: "Original", tip: "Use the song exactly as it is, vocals included" },
              { value: "instrumental", label: "Instrumental (karaoke)", tip: "Remove the vocals so people can sing along; made on your computer by the AI engine" },
            ]}
            onChange={(a) => st().setPrefs((o) => ({ ...o, audio: a }))}
          />
          {audio === "instrumental" && (
            <span className={styles.hint}>Makes a vocals-free version on the AI engine{hasInstrumental ? " (already made for this song)" : ""}.</span>
          )}
          {gate.needed && <DepsGate moduleId={LYRIC_VIDEO_ID} />}
        </div>
      </Section>
    </div>
  );
}
