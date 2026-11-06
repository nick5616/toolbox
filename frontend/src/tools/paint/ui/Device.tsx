/**
 * A Lab tool as an Ableton-Live-style device (SPEC §1.4.0): title bar with
 * on/off, name, predictability, origin, Seed (lock + re-roll) and Rand; a
 * controls row with a knob / mini switch / pill per param.
 */
import { useRef, useState, type ReactNode } from "react";
import { cx } from "@/components/cx";
import type { PaintOrigin } from "@/lib/api";
import type { LabParam, LabParams, LabToolInfo } from "@/paint/lab/types";
import { back, canBack, canForward, current, forward, fromNorm, newHistory, nextRandSeed, pushRand, randomize, readout, snap, toNorm, type NumberParam, type RandHistory } from "../deviceLogic";
import { Badge, IconButton, TextButton } from "./controls";
import { Knob } from "./Knob";
import { Menu, item } from "./Menu";
import { OriginCard } from "./OriginCard";
import { PaintIcon } from "./icons";
import styles from "./device.module.css";

export interface DeviceProps {
  info: LabToolInfo;
  params: LabParams;
  onParam(id: string, v: number | string | boolean): void;
  /** Replaces all params at once (Rand, back/forward, variants). */
  onParams(p: LabParams): void;
  seed: { seed: number; locked: boolean };
  onToggleSeedLock(): void;
  onReroll(): void;
  enabled: boolean;
  onToggleEnabled(): void;
  origins: readonly PaintOrigin[];
  /** Why the device can't be used now (a perception gate); controls still show. */
  disabledReason?: string;
  variants?: Array<{ id: string; name: string }>;
  onSaveVariant?(name: string): void;
  onLoadVariant?(id: string): void;
  /** The tool in hand. */
  selected?: boolean;
  onSelect?(): void;
  /** Extra title-bar content. */
  extra?: ReactNode;
}

export function Device({ info, params, onParam, onParams, seed, onToggleSeedLock, onReroll, enabled, onToggleEnabled, origins, disabledReason, variants = [], onSaveVariant, onLoadVariant, selected, onSelect, extra }: DeviceProps) {
  const [showOrigin, setShowOrigin] = useState(false);
  const [locked, setLocked] = useState<ReadonlySet<string>>(new Set());
  const [hist, setHist] = useState<RandHistory>(() => newHistory(params));
  const [randSeed, setRandSeed] = useState(1);
  const [ctx, setCtx] = useState<{ id: string; el: HTMLElement } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const hasSeed = info.predictability !== "exact";

  const rand = () => {
    const next = randomize(info, params, locked, randSeed);
    setRandSeed(nextRandSeed(randSeed));
    setHist((h) => pushRand(h, next));
    onParams(next);
  };
  const step = (dir: "back" | "forward") => {
    const h = dir === "back" ? back(hist) : forward(hist);
    setHist(h);
    onParams(current(h));
  };
  const toggleLock = (id: string) =>
    setLocked((l) => {
      const n = new Set(l);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const lockMenu = (p: LabParam) => (e: React.MouseEvent) => {
    e.preventDefault();
    setCtx({ id: p.id, el: e.currentTarget as HTMLElement });
  };

  const control = (p: LabParam) => {
    const value = params[p.id] ?? p.default;
    const isLocked = locked.has(p.id);
    if (p.type === "number") {
      const np = p as NumberParam;
      const v = typeof value === "number" ? value : np.default;
      return (
        <Knob
          key={p.id}
          label={p.label}
          tip={p.tip}
          norm={toNorm(np, v)}
          defaultNorm={toNorm(np, np.default)}
          step={0.02}
          text={readout(np, v)}
          locked={isLocked}
          onNorm={(n) => onParam(p.id, fromNorm(np, n))}
          onReset={() => onParam(p.id, snap(np, np.default))}
          onContextMenu={lockMenu(p)}
        />
      );
    }
    if (p.type === "choice") {
      return (
        <div key={p.id} className={styles.cell} onContextMenu={lockMenu(p)}>
          <div className={styles.mini} role="radiogroup" aria-label={p.label} data-tip={p.tip}>
            {p.choices.map((c) => (
              <button key={c.value} type="button" role="radio" aria-checked={value === c.value} aria-label={`${p.label}: ${c.label}`} data-tip={`${p.label}: ${c.label}`} onClick={() => onParam(p.id, c.value)} onDoubleClick={() => onParam(p.id, p.default)}>
                {c.label}
              </button>
            ))}
          </div>
          <span className={styles.knobLabel}>
            {p.label}
            {isLocked ? <span className={styles.pip} aria-label="Locked from Rand" /> : null}
          </span>
        </div>
      );
    }
    return (
      <div key={p.id} className={styles.cell} onContextMenu={lockMenu(p)}>
        <button type="button" role="switch" aria-checked={value === true} aria-label={p.label} data-tip={p.tip} className={styles.pill} onClick={() => onParam(p.id, value !== true)} onDoubleClick={() => onParam(p.id, p.default)}>
          {value === true ? "On" : "Off"}
        </button>
        <span className={styles.knobLabel}>
          {p.label}
          {isLocked ? <span className={styles.pip} aria-label="Locked from Rand" /> : null}
        </span>
      </div>
    );
  };

  const ctxParam = ctx ? info.params.find((p) => p.id === ctx.id) : undefined;
  return (
    <section ref={rootRef} className={cx(styles.device, selected && styles.selected, !enabled && styles.off)} aria-label={`${info.label} device`} data-testid={`device-${info.id}`} data-disabled={disabledReason ? "true" : undefined}>
      <header className={styles.title}>
        <button type="button" role="switch" aria-checked={enabled} aria-label={`${info.label} on or off`} data-tip={enabled ? "Switch this device off" : "Switch this device on"} className={styles.power} onClick={onToggleEnabled} />
        <button type="button" className={styles.name} data-tip={disabledReason ? `${info.description} — ${disabledReason}` : `Use ${info.label}: ${info.description}`} aria-disabled={disabledReason ? true : undefined} onClick={onSelect}>
          <PaintIcon name={info.icon} size={16} />
          {info.label}
        </button>
        <Badge value={info.predictability} />
        <IconButton icon="info" label={`About ${info.label}`} size="sm" iconSize={14} pressed={showOrigin} onClick={() => setShowOrigin((s) => !s)} />
        {extra}
      </header>
      <p className={styles.desc}>{info.description}</p>
      {disabledReason ? <p className={styles.reason}>{disabledReason}</p> : null}
      {showOrigin ? <OriginCard origin={info.origin} origins={origins} /> : null}
      {info.params.length ? <div className={styles.controls}>{info.params.map(control)}</div> : null}
      <footer className={styles.foot}>
        {hasSeed ? (
          <span className={styles.seed} data-testid={`seed-${info.id}`}>
            <IconButton icon="seedlock" label={seed.locked ? "Unlock seed" : "Lock seed"} size="sm" iconSize={14} pressed={seed.locked} onClick={onToggleSeedLock} />
            <IconButton icon="dice" label="Re-roll seed" size="sm" iconSize={14} disabled={seed.locked} reason="Unlock the seed to re-roll it" onClick={onReroll} />
            <span className={styles.seedNum} data-tip="This tool's own random seed (a locked seed repeats exactly)">
              Seed {seed.seed}
            </span>
          </span>
        ) : null}
        <span className={styles.rand}>
          <IconButton icon="undo" label="Previous Rand" size="sm" iconSize={14} disabled={!canBack(hist)} reason="No earlier Rand" onClick={() => step("back")} />
          <TextButton tip="Randomise every parameter that isn't locked (right-click a control to lock it)" icon="dice" onClick={rand} className={styles.randBtn}>
            Rand
          </TextButton>
          <IconButton icon="redo" label="Next Rand" size="sm" iconSize={14} disabled={!canForward(hist)} reason="No later Rand" onClick={() => step("forward")} />
        </span>
        {onSaveVariant ? (
          saving === null ? (
            <span className={styles.rand}>
              <IconButton icon="star" label="Save these settings as a variant" size="sm" iconSize={14} onClick={() => setSaving(info.label)} />
              {variants.length ? (
                <select className={styles.variantPick} aria-label="Saved variants" data-tip="Load a saved variant of this device" value="" onChange={(e) => e.target.value && onLoadVariant?.(e.target.value)}>
                  <option value="">Variants…</option>
                  {variants.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              ) : null}
            </span>
          ) : (
            <span className={styles.rand}>
              <input className={styles.variantName} aria-label="Variant name" data-tip="Name for this variant" value={saving} onChange={(e) => setSaving(e.target.value)} autoFocus />
              <TextButton
                tip="Save the variant"
                primary
                onClick={() => {
                  if (saving.trim()) onSaveVariant(saving.trim());
                  setSaving(null);
                }}
              >
                Save
              </TextButton>
            </span>
          )
        ) : null}
      </footer>
      {ctx && ctxParam ? (
        <Menu
          open
          title={`${ctxParam.label} options`}
          anchor={ctx.el}
          onClose={() => setCtx(null)}
          entries={[item("lock", locked.has(ctx.id) ? "Unlock for Rand" : "Lock from Rand", () => toggleLock(ctx.id), { icon: locked.has(ctx.id) ? "unlock" : "lock" }), item("reset", "Reset to default", () => onParam(ctx.id, ctxParam.default), { icon: "undo" })]}
        />
      ) : null}
    </section>
  );
}
