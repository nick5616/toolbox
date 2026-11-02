import { useEffect, useState, type KeyboardEvent } from "react";
import { cx, IconButton } from "@/components";
import type { PostSlide, ProjectInfo } from "@/lib/api";
import { FramedMedia } from "./FramedMedia";
import { truncateCaption } from "./logic";
import { KIND_ICON } from "./SlideStrip";
import { useSlideVisual } from "./useSlideVisual";
import styles from "./PhonePreview.module.css";

export interface PhonePreviewProps {
  slides: PostSlide[];
  aspect: string;
  caption: string;
  projects: Map<string, ProjectInfo>;
  /** The slide shown (kept in step with the selected slide). */
  currentId: string;
  onCurrent: (id: string) => void;
}

function Page({ slide, aspect, project }: { slide: PostSlide; aspect: string; project: ProjectInfo | undefined }) {
  const v = useSlideVisual(slide, project, 720);
  return (
    <FramedMedia
      url={v.url}
      aspect={aspect}
      framing={slide.kind === "video" ? { zoom: 1, panX: 0, panY: 0, rotation: 0 } : slide}
      placeholderIcon={KIND_ICON[slide.kind] ?? "image"}
      loading={v.status === "loading"}
      className={styles.page}
    />
  );
}

/** A neutral phone frame with swipeable slides, dots and the caption below. */
export function PhonePreview({ slides, aspect, caption, projects, currentId, onCurrent }: PhonePreviewProps) {
  const [expanded, setExpanded] = useState(false);
  const found = slides.findIndex((s) => s.id === currentId);
  const index = found >= 0 ? found : 0;
  const slide = slides[index];
  useEffect(() => setExpanded(false), [caption]);

  const go = (to: number) => {
    const t = slides[Math.min(Math.max(to, 0), slides.length - 1)];
    if (t) onCurrent(t.id);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(index - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      go(index + 1);
    }
  };

  const cap = truncateCaption(caption);

  return (
    <section className={styles.root} aria-label="Phone preview">
      <h3 className={styles.h}>Phone preview</h3>
      <div className={styles.phone} tabIndex={0} onKeyDown={onKeyDown} aria-roledescription="carousel" aria-label="Swipe with the arrow keys">
        <div className={styles.bar} aria-hidden="true">
          <span className={styles.avatar} />
          <span className={styles.handle} />
        </div>
        <div className={styles.stage}>
          {slide ? <Page key={slide.id} slide={slide} aspect={aspect} project={projects.get(slide.projectId)} /> : <div className={styles.none}>No slides</div>}
          {slides.length > 1 && (
            <>
              <IconButton className={cx(styles.nav, styles.prev)} size="sm" variant="secondary" icon="chevron-left" label="Previous slide" disabled={index === 0} onClick={() => go(index - 1)} />
              <IconButton className={cx(styles.nav, styles.next)} size="sm" variant="secondary" icon="chevron-right" label="Next slide" disabled={index === slides.length - 1} onClick={() => go(index + 1)} />
            </>
          )}
        </div>
        {slides.length > 1 && (
          <div className={styles.dots} role="tablist" aria-label="Slides">
            {slides.map((s, i) => (
              <button key={s.id} type="button" role="tab" aria-selected={i === index} aria-label={`Slide ${i + 1}`} className={cx(styles.dot, i === index && styles.dotOn)} onClick={() => onCurrent(s.id)} />
            ))}
          </div>
        )}
        <p className={styles.caption} data-testid="phone-caption">
          {expanded || !cap.truncated ? caption : cap.text}
          {cap.truncated && !expanded && (
            <>
              {"… "}
              <button type="button" className={styles.more} onClick={() => setExpanded(true)}>
                more
              </button>
            </>
          )}
        </p>
      </div>
    </section>
  );
}
