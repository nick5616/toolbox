/** Small controls the designer's tabs share: signal picker, live meter, parameter and mods editors. */
import { useMemo, useState } from "react";
import { ColorSwatchPicker, IconButton, Select, Slider, Stepper, Switch, cx } from "@/components";
import { DEFAULT_ATTACK_MS, DEFAULT_RELEASE_MS, SIGNALS, SIGNAL_META, type SignalMeta } from "@/viz/signals";
import type { ParamSpec } from "@/viz/layers/registry";
import type { Mod, ModShape, Param, SignalId } from "@/viz/types";
import { useDesigner } from "./context";
import { baseOf, DEFAULT_MOD, modsOf, withBase, withMods, type ParamValue } from "./model";
import styles from "./designer.module.css";

const GROUP_ORDER: Array<SignalMeta["group"]> = ["Instruments", "Rhythm", "Song", "Voice", "Words & mood", "Drift", "Whole song"];

export interface SignalSelectProps {
  value: SignalId | null;
  onChange(v: SignalId): void;
  /** Text of the empty option when `value` is null. */
  placeholder?: string;
  /** Adds a "None" option that calls onNone. */
  onNone?: () => void;
  label: string;
  className?: string;
}

/** The driver picker: signal UI names grouped as Instruments, Rhythm, Song, Voice, Words & mood, Drift. */
export function SignalSelect({ value, onChange, placeholder = "Choose…", onNone, label, className }: SignalSelectProps) {
  const groups = useMemo(
    () =>
      GROUP_ORDER.map((g) => ({ group: g, items: SIGNALS.filter((s) => s.group === g && s.id !== "time") })).filter((g) => g.items.length > 0),
    [],
  );
  return (
    <span className={cx(styles.signalSelect, className)}>
      <select
        className={styles.nativeSelect}
        aria-label={label}
        value={value ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "") onNone?.();
          else onChange(v as SignalId);
        }}
      >
        {value === null && <option value="">{placeholder}</option>}
        {value !== null && onNone && <option value="">None</option>}
        {groups.map((g) => (
          <optgroup key={g.group} label={g.group}>
            {g.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </span>
  );
}

/** A tiny live meter of one signal at the (throttled) playhead. */
export function SignalMeter({ signal, label }: { signal: SignalId | null; label?: string }) {
  const d = useDesigner();
  const v = signal && d ? Math.max(0, Math.min(1, d.signals.value(signal, d.liveMs))) : 0;
  return (
    <span className={styles.liveMeter} role="meter" aria-label={label ?? "Signal level"} aria-valuemin={0} aria-valuemax={1} aria-valuenow={Math.round(v * 100) / 100}>
      <span className={styles.liveFill} style={{ width: `${Math.round(v * 100)}%` }} />
    </span>
  );
}

export const SHAPES: Array<{ value: ModShape; label: string }> = [
  { value: "linear", label: "Linear" },
  { value: "ease", label: "Smooth" },
  { value: "exp", label: "Punchy" },
  { value: "gate", label: "On/off" },
];

export function ModsEditor({ mods, onChange, label }: { mods: Mod[]; onChange(mods: Mod[]): void; label: string }) {
  const patch = (i: number, p: Partial<Mod>) => onChange(mods.map((m, k) => (k === i ? { ...m, ...p } : m)));
  return (
    <div className={styles.mods} role="group" aria-label={`Reactions of ${label}`}>
      {mods.length === 0 && <p className={styles.hint}>Nothing drives this yet.</p>}
      {mods.map((m, i) => (
        <div key={i} className={styles.mod}>
          <div className={styles.modTop}>
            <SignalSelect label="Driver" value={m.signal} onChange={(signal) => patch(i, { signal })} />
            <Select
              size="sm"
              aria-label="Shape"
              value={m.shape}
              onChange={(shape) => patch(i, { shape })}
              options={SHAPES}
            />
            <IconButton size="sm" icon="x" label="Remove reaction" onClick={() => onChange(mods.filter((_, k) => k !== i))} />
          </div>
          <Slider aria-label="Amount" min={-2} max={2} step={0.05} value={m.amount} onChange={(amount) => patch(i, { amount })} format={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`} />
          <div className={styles.modTimes}>
            <label className={styles.inline}>
              <span>Attack</span>
              <Stepper aria-label="Attack" unit="ms" min={1} max={2000} step={5} value={m.attackMs ?? DEFAULT_ATTACK_MS} onChange={(attackMs) => patch(i, { attackMs })} />
            </label>
            <label className={styles.inline}>
              <span>Release</span>
              <Stepper aria-label="Release" unit="ms" min={1} max={5000} step={10} value={m.releaseMs ?? DEFAULT_RELEASE_MS} onChange={(releaseMs) => patch(i, { releaseMs })} />
            </label>
          </div>
        </div>
      ))}
      <button type="button" className={styles.linkBtn} onClick={() => onChange([...mods, { ...DEFAULT_MOD }])}>
        + Add a driver
      </button>
    </div>
  );
}

const COLOR_REFS = ["c0", "c1", "c2", "c3", "accent", "glow", "bg"] as const;
const COLOR_LABELS: Record<string, string> = { c0: "Colour 1", c1: "Colour 2", c2: "Colour 3", c3: "Colour 4", accent: "Accent", glow: "Glow", bg: "Background" };

function fmtNumber(v: number, spec: { min: number; max: number }): string {
  const span = spec.max - spec.min;
  return v.toFixed(span >= 50 ? 0 : span >= 5 ? 1 : 2);
}

export interface ParamEditorProps {
  spec: ParamSpec;
  /** The label shown (defaults to the spec's). */
  label?: string;
  value: ParamValue | undefined;
  onChange(v: ParamValue): void;
  /** Numbers get a reactions button. */
  reactive?: boolean;
}

/** One parameter: a slider with a reactions button, a picker, a switch or a colour. */
export function ParamEditor({ spec, label, value, onChange, reactive = true }: ParamEditorProps) {
  const [open, setOpen] = useState(false);
  const name = label ?? spec.label;
  if (spec.kind === "number") {
    const p: Param = typeof value === "number" || (typeof value === "object" && value !== null) ? (value as Param) : spec.default;
    const mods = modsOf(p);
    const step = spec.step ?? Math.max(0.001, Math.round(((spec.max - spec.min) / 100) * 1000) / 1000);
    return (
      <div className={styles.param}>
        <div className={styles.paramHead}>
          <span className={styles.paramLabel}>{name}</span>
          {reactive && (
            <IconButton
              size="sm"
              icon="activity"
              label={`Reactions for ${name}`}
              pressed={open || mods.length > 0}
              onClick={() => setOpen((o) => !o)}
              className={cx(mods.length > 0 && styles.reactive)}
            />
          )}
        </div>
        <Slider aria-label={name} min={spec.min} max={spec.max} step={step} value={baseOf(p)} onChange={(v) => onChange(withBase(p, v))} format={(v) => fmtNumber(v, spec)} />
        {open && reactive && <ModsEditor label={name} mods={mods} onChange={(next) => onChange(withMods(p, next))} />}
      </div>
    );
  }
  if (spec.kind === "bool") {
    return (
      <div className={styles.param}>
        <Switch label={name} checked={value === true} onChange={onChange} />
      </div>
    );
  }
  if (spec.kind === "enum") {
    const cur = typeof value === "string" ? value : spec.default;
    return (
      <div className={styles.param}>
        <label className={styles.inline}>
          <span className={styles.paramLabel}>{name}</span>
          <Select size="sm" aria-label={name} value={cur} onChange={onChange} options={spec.options.map((o) => ({ value: o, label: o }))} />
        </label>
      </div>
    );
  }
  const cur = typeof value === "string" ? value : spec.default;
  const custom = !(COLOR_REFS as readonly string[]).includes(cur);
  return (
    <div className={styles.param}>
      <label className={styles.inline}>
        <span className={styles.paramLabel}>{name}</span>
        <Select
          size="sm"
          aria-label={name}
          value={custom ? "custom" : cur}
          onChange={(v) => onChange(v === "custom" ? (/^#[0-9a-f]{6}$/i.test(cur) ? cur : "#ffffff") : v)}
          options={[...COLOR_REFS.map((r) => ({ value: r as string, label: COLOR_LABELS[r] ?? r })), { value: "custom", label: "Custom…" }]}
        />
      </label>
      {custom && <ColorSwatchPicker aria-label={`${name} colour`} value={cur} onChange={onChange} />}
    </div>
  );
}

export function signalName(id: SignalId): string {
  return SIGNAL_META.get(id)?.label ?? id;
}
