import type { CSSProperties } from "react";
import type { LyricLook } from "@/lib/api";
import { cx } from "@/components";
import { karaokeProgress, lineAt, type Row } from "./logic";
import styles from "./Preview.module.css";

export interface PreviewProps {
  look: LyricLook;
  aspect: string;
  rows: Row[];
  ms: number;
  /** URL of the song's cover art, when it has one. */
  coverUrl?: string | undefined;
  /** URL of the chosen background image. */
  imageUrl?: string | undefined;
}

const RATIOS: Record<string, string> = { "16:9": "16 / 9", "9:16": "9 / 16", "1:1": "1 / 1" };

/** True when the title card is on screen at ms (first 3 s, before the first line). */
export function titleCardVisible(look: LyricLook, rows: Row[], ms: number): boolean {
  if (!look.titleCard || (!look.title && !look.artist)) return false;
  const first = rows.find((r) => r.text.trim() !== "");
  const end = Math.min(3000, first ? first.startMs - 200 : 3000);
  return ms >= 0 && ms < end;
}

/** The HTML approximation of the rendered video (SPEC.md §7.4). */
export function Preview({ look, aspect, rows, ms, coverUrl, imageUrl }: PreviewProps) {
  const cur = lineAt(rows, ms);
  const row = cur >= 0 ? rows[cur] : undefined;
  const next = cur >= 0 ? rows[cur + 1] : undefined;
  const progress = row ? karaokeProgress(row, ms) : 0;
  const pct = Math.round(progress * 1000) / 10;
  const bg = look.background;
  const fallbackGradient = `linear-gradient(180deg, ${look.color1}, ${look.color2})`;
  const hasCover = !!coverUrl;
  const sharpCover = bg === "cover" && hasCover;
  const wide = aspect === "16:9";

  let backdrop: CSSProperties = { background: fallbackGradient };
  if (bg === "color") backdrop = { background: look.color1 };
  else if (bg === "image" && imageUrl) backdrop = { backgroundImage: `url("${imageUrl}")`, backgroundSize: "cover", backgroundPosition: "center" };
  else if ((bg === "blur-cover" || bg === "cover") && hasCover)
    backdrop = {
      backgroundImage: `url("${coverUrl}")`,
      backgroundSize: "cover",
      backgroundPosition: "center",
      filter: "blur(18px) brightness(0.88)",
      transform: "scale(1.15)",
    };

  const textStyle: CSSProperties = {
    fontFamily: `"${look.font}", sans-serif`,
    color: look.textColor,
  };
  const fillStyle: CSSProperties = look.karaoke
    ? {
        backgroundImage: `linear-gradient(90deg, ${look.highlightColor} ${pct}%, ${look.textColor} ${pct}%)`,
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        WebkitTextFillColor: "transparent",
      }
    : {};
  const showTitle = titleCardVisible(look, rows, ms);

  return (
    <div className={styles.frame} style={{ aspectRatio: RATIOS[aspect] ?? "16 / 9" }} data-testid="lyric-preview" data-aspect={aspect}>
      <div className={styles.backdrop} style={backdrop} />
      {bg === "video" && <div className={styles.note}>Video background (see Render preview)</div>}
      {sharpCover && <img className={cx(styles.cover, wide ? styles.coverWide : styles.coverTall)} src={coverUrl} alt="" />}
      {look.visualizer !== "none" && (
        <div
          className={cx(styles.viz, look.visualizer === "bars" ? styles.vizBars : styles.vizWave, look.position === "lower" && styles.vizRaised)}
          style={{ color: look.highlightColor }}
          data-testid="preview-visualizer"
        />
      )}
      <div
        className={cx(styles.text, look.position === "lower" && styles.lower, sharpCover && (wide ? styles.textWide : styles.textTall))}
        style={textStyle}
      >
        {showTitle ? (
          <div className={styles.title} data-testid="preview-title">
            <div className={styles.titleMain}>{look.title}</div>
            {look.artist && <div className={styles.titleSub}>{look.artist}</div>}
          </div>
        ) : (
          row && (
            <div className={styles.line} data-testid="preview-line" data-progress={pct}>
              <span style={fillStyle}>{row.text}</span>
            </div>
          )
        )}
        {!showTitle && look.showNext && next && (
          <div className={styles.next} data-testid="preview-next">
            {next.text}
          </div>
        )}
      </div>
    </div>
  );
}
