import { useEffect, useMemo, useRef, useState } from "react";
import { Banner, Button, Icon, IconButton, Switch, cx } from "@/components";
import { BoxOverlay, computeContentRect, type Box as OverlayBox, type ContentRect } from "@/components/media";
import { useShortcut } from "@/lib/shortcuts";
import { onRedactAction } from "./commands";
import { EffectFill, Thumb, useImageUrl } from "./bits";
import { baseName, countLabel, fromOverlay, removeBox, setAllBoxes, toOverlay, toggleBox, type ImageBox, type ImageEntry, type RedactSettings } from "./logic";
import styles from "./RedactView.module.css";

export interface ImageReviewProps {
  entry: ImageEntry;
  boxes: ImageBox[];
  onBoxes: (boxes: ImageBox[]) => void;
  settings: RedactSettings;
  /** All image paths for the strip (omit for a single image). */
  strip?: string[];
  reviewed?: ReadonlySet<string>;
  onGo: (path: string) => void;
  /** Back to the gallery (batches only). */
  onBack?: () => void;
}

/** One image: picture + boxes on the left, the detection list on the right. */
export function ImageReview({ entry, boxes, onBoxes, settings, strip, reviewed, onGo, onBack }: ImageReviewProps) {
  const { url, error } = useImageUrl(entry.path);
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [drawMode, setDrawMode] = useState(false);
  const [selected, setSelected] = useState<string | undefined>();

  useEffect(() => {
    setSelected(undefined);
    setDrawMode(false);
    setImg(null);
  }, [entry.path]);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rect: ContentRect = useMemo(() => computeContentRect(size.w, size.h, entry.width, entry.height), [size, entry.width, entry.height]);
  const overlay = useMemo(() => boxes.map(toOverlay), [boxes]);
  const index = strip ? strip.indexOf(entry.path) : -1;
  const total = strip?.length ?? 1;

  const step = (d: number) => {
    if (!strip) return;
    const next = strip[index + d];
    if (next) onGo(next);
  };

  useEffect(() => onRedactAction((a) => a === "add-box" && setDrawMode((v) => !v)), []);
  useShortcut("B", () => setDrawMode((v) => !v));
  useShortcut(
    ["Delete", "Backspace"],
    () => {
      if (!selected) return;
      onBoxes(removeBox(boxes, selected));
      setSelected(undefined);
    },
    { when: !!selected },
  );
  useShortcut("ArrowLeft", () => step(-1), { when: total > 1 });
  useShortcut("ArrowRight", () => step(1), { when: total > 1 });
  useShortcut("Escape", () => onBack?.(), { when: !!onBack });

  const anyOn = boxes.some((b) => b.enabled);

  return (
    <div className={styles.review}>
      <div className={styles.reviewMain}>
        {total > 1 && (
          <div className={styles.navRow}>
            {onBack && (
              <Button size="sm" variant="ghost" icon="layout-grid" onClick={onBack}>
                All images
              </Button>
            )}
            <IconButton size="sm" icon="chevron-left" label="Previous image" kbd="ArrowLeft" disabled={index <= 0} onClick={() => step(-1)} />
            <span className={styles.navText}>
              {baseName(entry.path)} · {index + 1} of {total}
            </span>
            <IconButton size="sm" icon="chevron-right" label="Next image" kbd="ArrowRight" disabled={index >= total - 1} onClick={() => step(1)} />
          </div>
        )}
        <div ref={stage} className={styles.stage} data-testid="review-stage">
          {error ? (
            <Banner tone="warn" title={error} />
          ) : url ? (
            <img
              className={styles.photo}
              style={{ left: rect.left, top: rect.top, width: rect.width || undefined, height: rect.height || undefined }}
              src={url}
              alt={`Preview of ${baseName(entry.path)}`}
              draggable={false}
              onLoad={(e) => setImg(e.currentTarget)}
            />
          ) : (
            <span className={styles.hint} role="status">
              Loading…
            </span>
          )}
          {url && (
            <BoxOverlay
              rect={rect}
              boxes={overlay}
              editable
              drawMode={drawMode}
              selectedId={selected}
              onSelect={setSelected}
              onChange={(next: OverlayBox[]) => onBoxes(fromOverlay(boxes, next))}
              renderFill={(b) => <EffectFill img={img} box={b} rectW={rect.width} rectH={rect.height} style={settings.style} strength={settings.strength} />}
            />
          )}
        </div>
        {strip && strip.length > 1 && (
          <div className={styles.strip} role="list" aria-label="Images">
            {strip.map((p) => (
              <button key={p} type="button" role="listitem" aria-label={baseName(p)} aria-current={p === entry.path} className={cx(styles.stripItem, p === entry.path && styles.stripCurrent)} onClick={() => onGo(p)}>
                <Thumb path={p} size={160} />
                {reviewed?.has(p) && <Icon name="check" size={12} className={styles.stripCheck} />}
              </button>
            ))}
          </div>
        )}
      </div>

      <aside className={styles.side} aria-label="Detections">
        <div className={styles.sideHead}>
          <span className={styles.sideTitle}>{countLabel(boxes)}</span>
          <Button size="sm" variant={drawMode ? "primary" : "secondary"} icon="square-dashed" kbd="B" aria-pressed={drawMode} onClick={() => setDrawMode((v) => !v)}>
            Add box
          </Button>
        </div>
        {drawMode && <p className={styles.hint}>Drag on the picture to cover something the search missed.</p>}
        {boxes.length === 0 ? (
          <p className={styles.hint}>Nothing was found. If something should be hidden, add a box by hand.</p>
        ) : (
          <>
            <p className={styles.hint}>Wrong match? Switch it off or delete it. Click a box in the picture to toggle it.</p>
            <ul className={styles.boxList}>
              {boxes.map((b, i) => (
                <li key={b.id} className={cx(styles.boxRow, selected === b.id && styles.boxRowSelected)} onClick={() => setSelected(b.id)}>
                  <Icon name={b.kind === "face" ? "scan-face" : b.kind === "plate" ? "rectangle-horizontal" : "square-dashed"} size={14} />
                  <span className={styles.boxName}>
                    {b.kind === "face" ? "Face" : b.kind === "plate" ? "Plate" : "Manual"} {i + 1}
                  </span>
                  <span className={styles.boxScore}>{b.kind === "manual" ? "" : `${Math.round(b.score * 100)}%`}</span>
                  <Switch checked={b.enabled} aria-label={`Redact box ${i + 1}`} onChange={() => onBoxes(toggleBox(boxes, b.id))} />
                  <IconButton size="sm" icon="trash-2" label={`Delete box ${i + 1}`} onClick={() => onBoxes(removeBox(boxes, b.id))} />
                </li>
              ))}
            </ul>
            <div className={styles.sideActions}>
              <Button size="sm" variant="ghost" disabled={boxes.every((b) => b.enabled)} onClick={() => onBoxes(setAllBoxes(boxes, true))}>
                All on
              </Button>
              <Button size="sm" variant="ghost" disabled={!anyOn} onClick={() => onBoxes(setAllBoxes(boxes, false))}>
                All off
              </Button>
            </div>
          </>
        )}
        <p className={styles.hint}>The picture shows an approximate preview of the effect.</p>
      </aside>
    </div>
  );
}
