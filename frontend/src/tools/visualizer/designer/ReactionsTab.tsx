/** Reactions (SPEC.md §8.3): the design's control rows, each a driver and an amount. */
import { useMemo, useState } from "react";
import { Button, IconButton, Select, Slider } from "@/components";
import type { Show, SignalId } from "@/viz/types";
import { SignalMeter, SignalSelect } from "./controls";
import { addReaction, reactionMod, reactionTargets, removeReaction, setReactionAmount, setReactionDriver } from "./model";
import styles from "./designer.module.css";

export interface TabProps {
  show: Show;
  onChange(show: Show): void;
}

export function ReactionsTab({ show, onChange }: TabProps) {
  const targets = useMemo(() => reactionTargets(show), [show]);
  const [group, setGroup] = useState("");
  const [param, setParam] = useState("");
  const groupItems = targets.find((t) => t.groupId === group);
  const taken = new Set(show.controls.map((c) => c.target));
  const params = (groupItems?.params ?? []).filter((p) => !taken.has(p.target));

  return (
    <div className={styles.tabBody}>
      {show.controls.length === 0 ? (
        <p className={styles.hint}>This design has no reactions yet. Add one below to make a parameter follow the music.</p>
      ) : (
        <ul className={styles.reactions} aria-label="Reactions">
          {show.controls.map((slot, i) => {
            const mod = reactionMod(show, slot);
            return (
              <li key={slot.target} className={styles.reaction}>
                <div className={styles.reactionTop}>
                  <span className={styles.reactionLabel} title={slot.target}>
                    {slot.label}
                  </span>
                  <SignalMeter signal={mod?.signal ?? null} label={`${slot.label} driver level`} />
                  <IconButton size="sm" icon="x" label={`Remove ${slot.label}`} onClick={() => onChange(removeReaction(show, i))} />
                </div>
                <div className={styles.reactionRow}>
                  <SignalSelect label={`${slot.label} driver`} value={mod?.signal ?? null} placeholder="Choose a driver" onChange={(s: SignalId) => onChange(setReactionDriver(show, i, s))} />
                  <div className={styles.reactionAmount}>
                    <Slider
                      aria-label={`${slot.label} amount`}
                      min={-2}
                      max={2}
                      step={0.05}
                      value={mod?.amount ?? 0}
                      onChange={(v) => onChange(setReactionAmount(show, i, v))}
                      format={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`}
                    />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className={styles.addRow}>
        <span className={styles.paramLabel}>Add reaction</span>
        <Select
          size="sm"
          aria-label="Layer"
          value={group}
          onChange={(v) => {
            setGroup(v);
            setParam("");
          }}
          options={[{ value: "", label: "Layer…" }, ...targets.map((t) => ({ value: t.groupId, label: t.groupLabel }))]}
        />
        <Select size="sm" aria-label="Parameter" value={param} disabled={!groupItems} onChange={setParam} options={[{ value: "", label: "Parameter…" }, ...params.map((p) => ({ value: p.target, label: p.label }))]} />
        <Button
          size="sm"
          icon="plus"
          disabled={!param}
          onClick={() => {
            onChange(addReaction(show, param));
            setParam("");
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}
