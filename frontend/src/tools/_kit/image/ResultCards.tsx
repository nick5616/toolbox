import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { useInView } from "@/lib/thumbs";
import { CompareSlider, Icon, IconButton, Spinner, cx, toast } from "@/components";
import { FileActions } from "@/tools/_kit/FileActions";
import { useResultBehaviour } from "@/tools/_kit/ResultRow";
import { EmptyLine } from "../EmptyLine";
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
    <div className={styles.tile} style={{ aspectRatio: String(aspect) }} data-tip="The image could not be previewed here; the file itself is fine">
      <Icon name="image" size={22} />
      <span>{text}</span>
    </div>
  );
}

function Compare({ item, dim }: { item: ResultItem; dim: number }) {
  const [ref, seen] = useInView<HTMLDivElement>();
  const before = useThumb(item.original, dim, seen);
  const after = useThumb(item.output, dim, seen);

  if (after.status === "loading" || before.status === "loading") {
    return (
      <div ref={ref} className={styles.tile} style={{ aspectRatio: String(item.aspect) }}>
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
          <h2 id={titleId} className={styles.dialogTitle} data-tip={item.output}>
            {item.title}
          </h2>
          <span className={styles.mono} data-tip="Size of the result and what was done">
            {item.meta}
          </span>
          <IconButton icon="x" label="Close preview" size="sm" kbd="Esc" data-tip="Close the large preview and go back to the results" onClick={onClose} />
        </div>
        <Compare item={item} dim={1600} />
      </div>
    </div>
  );
}

/** One before/after card: draggable, double-click or Enter opens the file, like every result row. */
function ResultCard({ item, onPreview }: { item: ResultItem; onPreview: (id: string | null) => void }) {
  const { draggable, onDragStart, onDoubleClick, ...behaviour } = useResultBehaviour({ path: item.output, outputId: item.outputId, missing: item.missing });
  // Only the header and the footer start a drag or open the file: the compare slider keeps its own drags.
  const grip = { draggable, onDragStart, onDoubleClick };
  return (
      <article {...behaviour} className={styles.resultCard} aria-label={item.title}>
        <div className={styles.cardHead} {...grip}>
          <span className={styles.name} data-tip={item.output}>
            {item.title}
          </span>
          <IconButton
            icon="maximize-2"
            size="sm"
            label={`Enlarge ${item.title}`}
            data-tip="Open a large before and after comparison"
            onClick={() => onPreview(item.id)}
          />
        </div>
        <Compare item={item} dim={800} />
        <div className={styles.meta} {...grip}>
          <span className={styles.metaText} data-tip="Size of the result and what was done">
            {item.meta}
          </span>
          <IconButton icon="copy" size="sm" label="Copy path" data-tip="Copy the full path of the result file" onClick={() => void copyPath(item.output)} />
          <FileActions outputId={item.outputId} path={item.output} disabled={item.missing} />
        </div>
      </article>
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
    return <EmptyLine title={empty.title} body={empty.body} />;
  }
  const open = items.find((i) => i.id === preview);
  return (
    <>
      <div className={styles.grid}>
        {items.map((item) => (
          <ResultCard key={item.id} item={item} onPreview={onPreview} />
        ))}
      </div>
      {open && <PreviewDialog item={open} onClose={() => onPreview(null)} />}
    </>
  );
}
