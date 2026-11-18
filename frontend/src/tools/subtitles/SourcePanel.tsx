import { Banner, Button, Icon, Section, Spinner, ToolClickIn } from "@/components";
import { formatMs } from "@/components/media";
import { basename } from "./logic";
import { RunStatus } from "./RunStatus";
import { useRun } from "./runs";
import { MODULE_ID, useSubtitles } from "./store";
import { MediaFromLibraryButton, SubtitleFromLibraryButton } from "./library";
import styles from "./SubtitlesView.module.css";

/** Source panel: the file (change it, trim it first), a subtitle file, and the tracks already inside the video. */
export function SourcePanel() {
  const mediaPath = useSubtitles((s) => s.mediaPath);
  const subPath = useSubtitles((s) => s.subPath);
  const loadError = useSubtitles((s) => s.loadError);
  const media = useSubtitles((s) => s.media);
  const cueCount = useSubtitles((s) => s.editor.tabs[0]?.history.present.length ?? 0);
  const pickMedia = useSubtitles((s) => s.pickMedia);
  const pickSubtitleFile = useSubtitles((s) => s.pickSubtitleFile);
  const startOver = useSubtitles((s) => s.startOver);
  const useCut = useSubtitles((s) => s.useCut);
  const extractTrack = useSubtitles((s) => s.extract);
  const gen = useRun("gen");
  const extract = useRun("extract");
  const busy = gen.busy || extract.busy;

  const textStreams = media.subtitles.filter((s) => s.text);
  const otherStreams = media.subtitles.filter((s) => !s.text);

  return (
    <div className={styles.panel}>
      {mediaPath && (
        <div className={styles.fileCard}>
          <Icon name={media.status === "ready" && !media.isVideo ? "music" : "film"} size={18} />
          <div className={styles.fileInfo}>
            <div className={styles.fileName} data-tip={mediaPath}>
              {basename(mediaPath)}
            </div>
            <div className={styles.fileMeta}>
              {media.status === "loading" && (
                <>
                  <Spinner size={12} /> Reading the file…
                </>
              )}
              {media.status === "preparing" && "Preparing a preview copy…"}
              {media.status === "error" && (media.errorMessage || "Couldn't read this file")}
              {media.status === "ready" && `${formatMs(media.durationMs)} · ${media.isVideo ? "video" : "audio"}`}
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => void pickMedia()} disabled={busy} data-tip={busy ? "Wait for the current task to finish" : "Choose a different video or audio file"}>
            Change
          </Button>
          <MediaFromLibraryButton iconOnly variant="ghost" disabled={busy} label="Change from Library…" />
        </div>
      )}

      {media.status === "error" && mediaPath && (
        <Banner tone="danger" title={media.errorMessage || "Couldn't open this file"}>
          {media.errorHint}
        </Banner>
      )}

      {loadError && (
        <Banner tone="danger" title="Couldn't read the subtitles">
          {loadError}
        </Banner>
      )}

      {cueCount > 0 && (
        <div className={styles.fileCard}>
          <Icon name="captions" size={18} />
          <div className={styles.fileInfo}>
            <div className={styles.fileName}>{cueCount} subtitles loaded</div>
            <div className={styles.fileMeta}>{subPath ? basename(subPath) : "Ready to edit"}</div>
          </div>
          <Button size="sm" variant="ghost" onClick={startOver} data-tip="Discard these subtitles and begin again">
            Start over
          </Button>
        </div>
      )}

      <div className={styles.buttonRow}>
        {!mediaPath && (
          <Button size="sm" variant="secondary" icon="film" onClick={() => void pickMedia()} data-tip="Add the video so you can see the subtitles on the picture while editing">
            Pick the video (optional)
          </Button>
        )}
        {!mediaPath && <MediaFromLibraryButton />}
        <Button size="sm" variant="secondary" icon="file-text" onClick={() => void pickSubtitleFile()} disabled={busy} data-tip={busy ? "Wait for the current task to finish" : "Open an .srt or .vtt file you already have, to edit it"}>
          Use a subtitle file…
        </Button>
        <SubtitleFromLibraryButton disabled={busy} />
        {mediaPath && (
          <ToolClickIn
            host={MODULE_ID}
            module="trimmer"
            inputs={[mediaPath]}
            useLabel="Use this cut"
            onUse={useCut}
            width={760}
            title="Trim first"
            icon="scissors"
            tip="Cut the start or end off before making subtitles"
            disabledReason={busy ? "Wait for the current task to finish" : undefined}
          />
        )}
      </div>

      {mediaPath && (textStreams.length > 0 || otherStreams.length > 0) && (
        <Section label="Subtitles inside this video" tip="Subtitle tracks already stored in the file">
          <ul className={styles.streams}>
            {textStreams.map((s) => (
              <li key={s.index} className={styles.stream}>
                <span className={styles.streamName}>
                  {s.title || `Track ${s.index}`}
                  <span className={styles.muted}>
                    {" "}
                    · {s.language || "unknown language"} · {s.codec}
                  </span>
                </span>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => extractTrack(s.index)} data-tip="Copy this track out of the video so you can edit it">
                  Use this track
                </Button>
              </li>
            ))}
            {otherStreams.map((s) => (
              <li key={s.index} className={styles.stream}>
                <span className={styles.streamName}>
                  {s.title || `Track ${s.index}`}
                  <span className={styles.muted}>
                    {" "}
                    · {s.language || "unknown language"} · {s.codec}
                  </span>
                </span>
                <span className={styles.muted} data-tip="This track is made of images, not text, so it can't be read or edited here">
                  Picture-based, can't be edited
                </span>
              </li>
            ))}
          </ul>
          <RunStatus run={extract} runningLabel="Extracting subtitles…" showResult={false} />
        </Section>
      )}
    </div>
  );
}
