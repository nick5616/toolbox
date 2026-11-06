import { useEffect, useState, type MouseEvent } from "react";
import { Icon } from "@/components";
import { columnPeaks } from "@/components/media/Waveform";
import { InlinePlay } from "@/tools/_kit/InlinePlay";
import { itemIcon, previewKind, type LibItem } from "../items";
import { cachedPreview, FILMSTRIP_FRAMES, loadPreview, useInView, type PreviewData } from "./loader";
import styles from "./ItemThumb.module.css";

/** The first lines of a text file, trimmed for a card. */
export function firstLines(text: string, max = 6): string {
  return text.split(/\r?\n/).filter((l) => l.trim() !== "").slice(0, max).join("\n");
}

function usePreview(item: LibItem): { data: PreviewData | undefined; failed: boolean; ref: React.RefObject<HTMLDivElement | null> } {
  const [ref, seen] = useInView<HTMLDivElement>();
  const [data, setData] = useState<PreviewData | undefined>(() => cachedPreview(item));
  const [failed, setFailed] = useState(false);
  const wanted = !item.missing && previewKind(item) !== "none";
  useEffect(() => {
    setFailed(false);
    const hit = cachedPreview(item);
    setData(hit);
    if (hit || !seen || !wanted) return;
    let alive = true;
    loadPreview(item)
      .then((d) => {
        if (!alive) return;
        if (d) setData(d);
        else setFailed(true);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.path, item.at, item.sizeBytes, seen, wanted]);
  return { data, failed, ref };
}

export interface ItemThumbProps {
  item: LibItem;
  /** Show the inline play button on audio. */
  play?: boolean;
  className?: string;
}

/**
 * A file's preview, loaded lazily when it scrolls into view (≤ 6 at a time,
 * cached): image thumbnail, video poster with a hover scrub, audio waveform,
 * PDF first page, first lines of text. Anything else (or a failed load) is
 * the type's icon; a missing file is greyed.
 */
export function ItemThumb({ item, play = false, className }: ItemThumbProps) {
  const { data, failed, ref } = usePreview(item);
  const [scrub, setScrub] = useState<number | null>(null);
  const icon = <Icon name={itemIcon(item)} size={28} className={styles.icon} />;
  let body = icon;
  if (!item.missing && data && !failed) {
    if (data.kind === "image" || data.kind === "pdf") {
      body = <img className={styles.img} src={data.src} alt="" draggable={false} />;
    } else if (data.kind === "video") {
      const frame = scrub ?? 1;
      const onMove = (e: MouseEvent<HTMLElement>) => {
        const r = e.currentTarget.getBoundingClientRect();
        const f = r.width > 0 ? (e.clientX - r.left) / r.width : 0;
        setScrub(Math.min(FILMSTRIP_FRAMES - 1, Math.max(0, Math.floor(f * FILMSTRIP_FRAMES))));
      };
      body = (
        <div
          className={styles.sprite}
          data-testid="video-poster"
          data-frame={frame}
          style={{ backgroundImage: `url("${data.sprite}")`, backgroundSize: `${FILMSTRIP_FRAMES * 100}% 100%`, backgroundPositionX: `${(frame / (FILMSTRIP_FRAMES - 1)) * 100}%` }}
          onMouseMove={onMove}
          onMouseLeave={() => setScrub(null)}
        />
      );
    } else if (data.kind === "audio") {
      const bars = columnPeaks(data.peaks, 48);
      body = (
        <div className={styles.wave} aria-hidden="true">
          {bars.map((b, i) => (
            <span key={i} style={{ height: `${Math.max(6, Math.round(b * 100))}%` }} />
          ))}
        </div>
      );
    } else {
      body = <pre className={styles.text}>{firstLines(data.text)}</pre>;
    }
  }
  return (
    <div ref={ref} className={`${styles.thumb} ${item.missing ? styles.missing : ""} ${className ?? ""}`} data-kind={previewKind(item)}>
      {body}
      {data?.kind === "pdf" && data.pages > 0 ? <span className={styles.badge}>{data.pages} p</span> : null}
      {play && !item.missing && previewKind(item) === "audio" ? (
        <span className={styles.play}>
          <InlinePlay path={item.path} />
        </span>
      ) : null}
    </div>
  );
}
