import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { CompareSlider, EmptyState, Icon, IconButton, Spinner, cx, toast } from "@/components";
import { FileActions } from "@/tools/_kit/FileActions";
import { useThumb } from "./common";
import styles from "./image.module.css";

export interface ResultItem {
  id: string;
  /** Original input path (before image). */
  original: string;
  /** Output path (after image). */
  output: string;
  outputId?: string;
  missing?: boolean;
  /** File name shown on the card. */
  title: string;
  /** Dimensions / summary line. */
  meta: string;
  /** Width / height of the output. */
  aspect: number;
  /** Checkerboard under the result (transparent cut-outs). */
  checkerboard?: boolean;
  afterLabel?: string;
}

async function copyPath(path: string) {
  try {
    await navigator.clipboard.writeText(path);
    toast({ title: "Path copied" });
  } catch {
    toast({ title: "Couldn't copy to the clipboard", tone: "danger" });
  }
}

function Tile({ text, aspect }: { text: string; aspect: number }) {
  return (
    <div className={styles.tile} style={{ aspectRatio: String(aspect) }}>
      <Icon name="image" size={22} />
      <span>{text}</span>
    </div>
  );
}

function Compare({ item, dim }: { item: ResultItem; dim: number }) {
  const before = useThumb(item.original, dim);
  const after = useThumb(item.output, dim);

  if (after.status === "loading" || before.status === "loading") {
    return (
      <div className={styles.tile} style={{ aspectRatio: String(item.aspect) }}>
        <Spinner label="Loading preview" />
      </div>
    );
  }
  if (after.status !== "ok") {
    return <Tile text={after.status === "error" ? after.message : "No preview"} aspect={item.aspect} />;
  }
  if (before.status !== "ok") {
    // HEIC (or unreadable) original: show the result alone.
    return (
      <div
        className={cx(styles.tile, item.checkerboard && "checkerboard")}
        style={{ aspectRatio: String(item.aspect) }}
      >
        <img className={styles.single} src={after.src} alt={item.title} />
      </div>
    );
  }
  return (
    <CompareSlider
      before={before.src}
      after={after.src}
      afterLabel={item.afterLabel}
      aspect={item.aspect}
      checkerboard={item.checkerboard}
      aria-label={`Compare original and result for ${item.title}`}
    />
  );
}

function PreviewDialog({ item, onClose }: { item: ResultItem; onClose: () => void }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => prev?.focus?.();
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
  return (
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div
        ref={ref}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className={styles.dialogHead}>
          <h2 id={titleId} className={styles.dialogTitle} title={item.output}>
            {item.title}
          </h2>
          <span className={styles.mono}>{item.meta}</span>
          <IconButton icon="x" label="Close preview" size="sm" onClick={onClose} />
        </div>
        <Compare item={item} dim={1600} />
      </div>
    </div>
  );
}

export interface ResultCardsProps {
  items: ResultItem[];
  preview: string | null;
  onPreview: (id: string | null) => void;
  empty: { title: string; body: string };
}

/** Grid of before/after cards for finished image jobs, with a large preview dialog. */
export function ResultCards({ items, preview, onPreview, empty }: ResultCardsProps) {
  if (items.length === 0) {
    return <EmptyState icon="image" title={empty.title} body={empty.body} />;
  }
  const open = items.find((i) => i.id === preview);
  return (
    <>
      <div className={styles.grid}>
        {items.map((item) => (
          <article key={item.id} className={styles.resultCard} aria-label={item.title}>
            <div className={styles.cardHead}>
              <span className={styles.name} title={item.output}>
                {item.title}
              </span>
              <IconButton icon="maximize-2" size="sm" label={`Enlarge ${item.title}`} onClick={() => onPreview(item.id)} />
            </div>
            <Compare item={item} dim={800} />
            <div className={styles.meta}>
              <span className={styles.metaText}>{item.meta}</span>
              <IconButton icon="copy" size="sm" label="Copy path" onClick={() => void copyPath(item.output)} />
              <FileActions outputId={item.outputId} path={item.output} disabled={item.missing} />
            </div>
          </article>
        ))}
      </div>
      {open && <PreviewDialog item={open} onClose={() => onPreview(null)} />}
    </>
  );
}
