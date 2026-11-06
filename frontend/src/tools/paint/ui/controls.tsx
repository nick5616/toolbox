/**
 * Paint+ controls (SPEC §1.5): Island, IconButton, TextButton, ColorPuck,
 * Badge (predictability), Segmented, Stepper, Toggle. Every control carries a
 * tooltip (`data-tip`, read by the shell's TooltipLayer) and an aria-label;
 * a disabled control keeps `aria-disabled` and says why in its tooltip.
 */
import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "@/components/cx";
import type { Predictability } from "@/paint/lab/types";
import { PaintIcon } from "./icons";
import styles from "./ui.module.css";

export interface IslandProps {
  label: string;
  vertical?: boolean;
  className?: string;
  children: ReactNode;
  "data-testid"?: string;
}

/** A floating translucent group of controls. */
export function Island({ label, vertical, className, children, ...rest }: IslandProps) {
  return (
    <div role="toolbar" aria-label={label} aria-orientation={vertical ? "vertical" : "horizontal"} className={cx(styles.island, vertical && styles.vertical, className)} data-testid={rest["data-testid"]}>
      {children}
    </div>
  );
}

export function IslandDivider() {
  return <span className={styles.divider} role="separator" aria-hidden="true" />;
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label" | "disabled"> {
  icon: string;
  /** The tooltip and aria-label. */
  label: string;
  /** Shortcut shown in the tooltip. */
  kbd?: string;
  pressed?: boolean;
  /** Disabled: stays focusable and hoverable; `reason` replaces the tooltip. */
  disabled?: boolean;
  reason?: string;
  size?: "sm" | "md";
  iconSize?: number;
  /** A small accent dot (something is set on this control). */
  dot?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, kbd, pressed, disabled, reason, size = "md", iconSize, dot, className, onClick, type = "button", ...rest },
  ref,
) {
  const tip = disabled && reason ? `${label} — ${reason}` : label;
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      data-tip={tip}
      data-tip-kbd={kbd}
      data-tip-side="bottom"
      className={cx(styles.iconBtn, size === "sm" && styles.small, pressed && styles.pressed, className)}
      onClick={(e) => {
        if (disabled) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      {...rest}
    >
      <PaintIcon name={icon} size={iconSize ?? (size === "sm" ? 16 : 20)} />
      {dot ? <span className={styles.dot} aria-hidden="true" /> : null}
    </button>
  );
});

export interface TextButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled"> {
  tip: string;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  reason?: string;
  icon?: string;
}

export const TextButton = forwardRef<HTMLButtonElement, TextButtonProps>(function TextButton(
  { tip, primary, danger, disabled, reason, icon, className, children, onClick, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      data-tip={disabled && reason ? reason : tip}
      aria-disabled={disabled || undefined}
      className={cx(styles.textBtn, primary && styles.primary, danger && styles.danger, className)}
      onClick={(e) => {
        if (disabled) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      {...rest}
    >
      {icon ? <PaintIcon name={icon} size={16} /> : null}
      {children}
    </button>
  );
});

export interface ColorPuckProps {
  /** CSS colour of the current paint ("#rrggbb"). */
  color: string;
  onClick?: () => void;
  pressed?: boolean;
}

/** The current colour as a ring-edged disc, as in Procreate. */
export const ColorPuck = forwardRef<HTMLButtonElement, ColorPuckProps>(function ColorPuck({ color, onClick, pressed }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={styles.puck}
      style={{ ["--p-current" as string]: color }}
      aria-label="Colour"
      aria-pressed={pressed}
      data-tip="Colour"
      data-tip-kbd="C"
      data-tip-side="bottom"
      onClick={onClick}
    />
  );
});

const PREDICT_TEXT: Record<Predictability, { label: string; tip: string }> = {
  exact: { label: "Exact", tip: "Exact: the same input always gives the same result" },
  seeded: { label: "Seeded", tip: "Seeded: random, but repeatable when you lock its seed" },
  wild: { label: "Wild", tip: "Wild: you can't fully predict it" },
};

export function predictabilityLabel(p: Predictability): string {
  return PREDICT_TEXT[p].label;
}

export function predictabilityTip(p: Predictability): string {
  return PREDICT_TEXT[p].tip;
}

/** The Lab's predictability badge: Exact, Seeded or Wild. */
export function Badge({ value, compact }: { value: Predictability; compact?: boolean }) {
  return (
    <span className={cx(styles.badge, styles[value])} data-tip={PREDICT_TEXT[value].tip} data-testid={`badge-${value}`} aria-label={PREDICT_TEXT[value].tip} role="img">
      {compact ? null : PREDICT_TEXT[value].label}
    </span>
  );
}

export interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode; tip: string; icon?: string }>;
  onChange(v: T): void;
  className?: string;
}

export function Segmented<T extends string>({ label, value, options, onChange, className }: SegmentedProps<T>) {
  return (
    <div role="radiogroup" aria-label={label} className={cx(styles.seg, className)}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} data-tip={o.tip} onClick={() => onChange(o.value)}>
          {o.icon ? <PaintIcon name={o.icon} size={14} /> : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export interface StepperProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange(v: number): void;
}

export function Stepper({ label, value, min, max, step = 1, unit, onChange }: StepperProps) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));
  return (
    <span className={styles.stepper} role="group" aria-label={label}>
      <IconButton icon="minus" label={`Decrease ${label}`} size="sm" onClick={() => onChange(clamp(value - step))} />
      <input
        type="number"
        aria-label={label}
        data-tip={`${label} (${min}–${max})`}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
      />
      <IconButton icon="plus" label={`Increase ${label}`} size="sm" onClick={() => onChange(clamp(value + step))} />
      {unit ? <span className={styles.unit}>{unit}</span> : null}
    </span>
  );
}

export interface ToggleProps {
  label: string;
  tip?: string;
  checked: boolean;
  onChange(v: boolean): void;
}

/** A labelled switch row. */
export function Toggle({ label, tip, checked, onChange }: ToggleProps) {
  const id = useId();
  return (
    <div className={styles.toggleRow}>
      <span id={id}>{label}</span>
      <button type="button" role="switch" aria-checked={checked} aria-labelledby={id} data-tip={tip ?? label} className={styles.toggle} onClick={() => onChange(!checked)} />
    </div>
  );
}

/** A small captioned field row used by dialogs and panels. */
export function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.row} style={{ justifyContent: "space-between" }}>
      <span>{label}</span>
      {children}
    </div>
  );
}
