import { useRef, useState } from "react";
import { Button, Meter, splitPath } from "@/components";
import { MediaPlayer, useMediaSource, type MediaPlayerHandle } from "@/components/media";
import { formatDuration } from "@/lib/format";
import { lengthFromEnd, tenthsOfSecond } from "./options";
import styles from "./gif.module.css";

export interface VideoPreviewProps {
  path: string;
  /** Start and length (seconds) of the loop, shown when `picking`. */
  startSec: number;
  /** Show the Set start / Set end buttons (GIF and WebP only; a sheet covers the whole video). */
  picking: boolean;
  onStart: (sec: number) => void;
  onLength: (sec: number) => void;
}

/**
 * The selected video in the shared media player, with its duration and
 * "Set start here" / "Set end here". Videos the webview can't play go through
 * a preview copy (useMediaSource); the job always reads the original.
 */
export function VideoPreview({ path, startSec, picking, onStart, onLength }: VideoPreviewProps) {
  const media = useMediaSource(path);
  const player = useRef<MediaPlayerHandle>(null);
  const [playheadMs, setPlayheadMs] = useState(0);
  const name = splitPath(path)[1];
  const source = media.status === "ready" ? media.source : undefined;
  const durationMs = source?.info.durationMs ?? 0;

  const setStart = () => {
    const ms = player.current?.currentMs() ?? 0;
    onStart(tenthsOfSecond(ms / 1000));
  };
  const setEnd = () => {
    const ms = player.current?.currentMs() ?? 0;
    const len = lengthFromEnd(startSec, ms / 1000);
    if (len !== null) onLength(len);
  };
  const endBlocked = playheadMs / 1000 <= startSec;

  return (
    <div className={styles.previewBox} aria-label="Video preview">
      {source ? (
        <MediaPlayer ref={player} className={styles.videoPlayer} source={source} kind="video" path={path} onTime={setPlayheadMs} />
      ) : media.status === "error" ? (
        <div className={styles.placeholder} role="alert">
          {media.error?.message ?? "This video can't be previewed"}
          <Button size="sm" variant="secondary" data-tip="Try opening the video again" onClick={media.retry}>
            Retry
          </Button>
        </div>
      ) : (
        <div className={styles.placeholder} role="status">
          {media.status === "preparing" ? (
            <>
              <span>Preparing a preview copy… {Math.round((media.progress ?? 0) * 100)}%</span>
              <Meter value={media.progress ?? -1} label="Preview copy progress" />
            </>
          ) : (
            "Loading the video…"
          )}
        </div>
      )}
      <div className={styles.previewBar}>
        <span className={styles.previewName} data-tip={path}>
          {name}
        </span>
        {durationMs > 0 && (
          <span className={styles.previewDuration} data-tip="How long the video is">
            {formatDuration(durationMs / 1000)}
          </span>
        )}
        {picking && (
          <>
            <Button size="sm" variant="secondary" disabled={!source} data-tip="Start the loop at the point the video is paused on" onClick={setStart}>
              Set start here
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!source || endBlocked}
              data-tip="End the loop at the point the video is paused on (up to 30 seconds after the start)"
              onClick={setEnd}
            >
              Set end here
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
