import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cx } from "./cx";
import styles from "./CompareSlider.module.css";

export interface CompareSliderProps {
  /** Image shown on the left of the divider. */
  before: string;
  /** Image shown on the right of the divider. */
  after: string;
  beforeLabel?: string;
  afterLabel?: string;
  /** Width / height of the display box (default 4/3). Both images are contained in it. */
  aspect?: number;
  /** Checkerboard under the images (transparent results). */
  checkerboard?: boolean;
  /** Render the before image pixelated (default false: smoothed, so an upscale difference is visible). */
  pixelatedBefore?: boolean;
  /** Initial divider position, 0..100 (default 50). */
  initial?: number;
  "aria-label"?: string;
  className?: string;
}

const STEP = 5;

function clamp(n: number): number {
  return Math.min(100, Math.max(0, n));
}

/** Before/after comparison with a draggable divider (pointer + keyboard). */
export function CompareSlider({
  before,
  after,
  beforeLabel = "Original",
  afterLabel = "Result",
  aspect = 4 / 3,
  checkerboard,
  pixelatedBefore,
  initial = 50,
  className,
  ...aria
}: CompareSliderProps) {
  const [pos, setPos] = useState(clamp(initial));
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const fromClientX = (x: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return;
    setPos(clamp(((x - r.left) / r.width) * 100));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.focus();
    fromClientX(e.clientX);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) fromClientX(e.clientX);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = pos - STEP;
    else if (e.key === "ArrowRight") next = pos + STEP;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = 100;
    if (next === null) return;
    e.preventDefault();
    setPos(clamp(next));
  };

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label={aria["aria-label"] ?? `Compare ${beforeLabel.toLowerCase()} and ${afterLabel.toLowerCase()}`}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pos)}
      aria-valuetext={`${Math.round(pos)}% ${beforeLabel}`}
      className={cx(styles.root, checkerboard && styles.checker, className)}
      style={{ aspectRatio: String(aspect) }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    >
      <img className={styles.img} src={after} alt="" draggable={false} />
      <img
        className={styles.img}
        src={before}
        alt=""
        draggable={false}
        style={{
          clipPath: `inset(0 ${100 - pos}% 0 0)`,
          imageRendering: pixelatedBefore ? "pixelated" : "auto",
        }}
      />
      <span className={cx(styles.tag, styles.tagBefore)}>{beforeLabel}</span>
      <span className={cx(styles.tag, styles.tagAfter)}>{afterLabel}</span>
      <div className={styles.divider} style={{ left: `${pos}%` }}>
        <span className={styles.handle} aria-hidden="true">
          ⇔
        </span>
      </div>
    </div>
  );
}
