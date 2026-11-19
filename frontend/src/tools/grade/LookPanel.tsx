/**
 * Rail ▸ Look (Phase 21 SPEC §E1): the op stack of the current look. Per op:
 * a toggle, its amount, a region chip, drag (or the arrows) to reorder, its
 * own parameters, and the Chaos lock. Add an op from the catalog at the end.
 */
import { useState, type DragEvent } from "react";
import { ColorSwatchPicker, Icon, IconButton, MenuButton, Select, Slider, Switch, TextField } from "@/components";
import { opDef, OP_DEFS } from "@/grade/ops";
import { GRADE_OP_KINDS, MAX_NAME, MAX_OPS, type GradeOp, type GradeOpKind, type GradeParam, type OpParamSpec, type Region } from "@/grade/types";
import { chaosOn, mapReady, opLabel, REGION_KINDS, regionLabel, regionNeeds, regionOfKind } from "./recipe";
import { useGrade } from "./store";
import styles from "./Grade.module.css";

const pct = (v: number) => `${Math.round(v * 100)}%`;

function ParamEditor({ id, name, spec, value }: { id: string; name: string; spec: OpParamSpec; value: GradeParam | undefined }) {
  const setParam = useGrade((s) => s.setParam);
  const label = spec.label || name;
  const v = value ?? spec.default;
  switch (spec.kind) {
    case "number": {
      const min = spec.min ?? 0;
      const max = spec.max ?? 1;
      const n = typeof v === "number" ? v : Number(spec.default) || 0;
      const step = max - min <= 2 ? 0.01 : max - min <= 20 ? 0.05 : 1;
      return (
        <label className={styles.param}>
          <span className={styles.paramLabel}>{label}</span>
          <Slider value={n} min={min} max={max} step={step} onChange={(x) => setParam(id, name, x)} aria-label={label} data-tip={`${label} (${min} to ${max})`} format={(x) => (Math.abs(x) >= 10 ? String(Math.round(x)) : x.toFixed(2))} />
        </label>
      );
    }
    case "color":
      return (
        <div className={styles.param}>
          <span className={styles.paramLabel}>{label}</span>
          <ColorSwatchPicker value={typeof v === "string" ? v : "#ffffff"} onChange={(c) => setParam(id, name, c)} aria-label={label} />
        </div>
      );
    case "enum":
      return (
        <label className={styles.param}>
          <span className={styles.paramLabel}>{label}</span>
          <Select size="sm" value={String(v)} options={(spec.options ?? []).map((o) => ({ value: o, label: o }))} onChange={(x) => setParam(id, name, x)} aria-label={label} />
        </label>
      );
    case "bool":
      return <Switch checked={v === true} onChange={(c) => setParam(id, name, c)} label={label} tip={label} />;
    case "stops": {
      const stops = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
      return (
        <div className={styles.param}>
          <span className={styles.paramLabel}>{label}</span>
          <span className={styles.stopsNote} data-tip="The colour stops come with the look; this version doesn't edit them one by one">
            {stops.length} {stops.length === 1 ? "stop" : "stops"}
          </span>
        </div>
      );
    }
    default:
      return (
        <div className={styles.param}>
          <span className={styles.paramLabel}>{label}</span>
          <span className={styles.stopsNote}>Set by the look</span>
        </div>
      );
  }
}

function RegionEditor({ op }: { op: GradeOp }) {
  const setRegion = useGrade((s) => s.setRegion);
  const maps = useGrade((s) => s.maps);
  const aux = mapReady(maps);
  const r = op.region;
  const needs = regionNeeds(r);
  const set = (next: Region) => setRegion(op.id, next);
  return (
    <div className={styles.regionEditor}>
      <label className={styles.param}>
        <span className={styles.paramLabel}>Where</span>
        <Select
          size="sm"
          value={r.kind}
          aria-label="Region"
          options={REGION_KINDS.map((k) => ({ value: k.kind, label: k.needs && !aux[k.needs] ? `${k.label} (needs its map)` : k.label }))}
          onChange={(kind) => set(regionOfKind(kind))}
        />
      </label>
      {needs && !aux[needs] && (
        <p className={styles.note} role="status">
          This region's map isn't made yet, so it draws everywhere for now. Make it in Regions.
        </p>
      )}
      {(r.kind === "highlights" || r.kind === "shadows" || r.kind === "midtones") && (
        <label className={styles.param}>
          <span className={styles.paramLabel}>Softness</span>
          <Slider value={r.soft} min={0} max={1} step={0.01} onChange={(soft) => set({ ...r, soft })} aria-label="Softness" data-tip="How gently the region fades into the rest" format={pct} />
        </label>
      )}
      {(r.kind === "subject" || r.kind === "background" || r.kind === "people" || r.kind === "near" || r.kind === "far") && (
        <label className={styles.param}>
          <span className={styles.paramLabel}>Feather</span>
          <Slider value={r.feather} min={0} max={1} step={0.01} onChange={(feather) => set({ ...r, feather })} aria-label="Feather" data-tip="How soft the edge of the region is" format={pct} />
        </label>
      )}
      {(r.kind === "near" || r.kind === "far") && (
        <label className={styles.param}>
          <span className={styles.paramLabel}>Split</span>
          <Slider value={r.split} min={0} max={1} step={0.01} onChange={(split) => set({ ...r, split })} aria-label="Split" data-tip="Where near ends and far begins" format={pct} />
        </label>
      )}
      {(r.kind === "subject" || r.kind === "background" || r.kind === "people") && (
        <Switch checked={!!r.invert} onChange={(invert) => set({ ...r, invert })} label="Invert" tip="Apply to everything except this region" />
      )}
    </div>
  );
}

function OpRow({ op, index, last, drag }: { op: GradeOp; index: number; last: boolean; drag: DragState }) {
  const [open, setOpen] = useState(false);
  const wild = useGrade((s) => s.wild);
  const locked = useGrade((s) => s.locked.includes(op.id));
  const { toggleOp, setAmount, removeOp, moveOp, toggleLock, setChaosFlag } = useGrade.getState();
  const def = opDef(op.kind);
  const asleep = !!op.chaos && !chaosOn(wild);
  return (
    <li
      className={styles.opRow}
      data-off={!op.on || asleep || undefined}
      data-over={drag.over === index || undefined}
      draggable
      onDragStart={(e: DragEvent) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", op.id);
        drag.set({ from: index, over: index });
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (drag.over !== index) drag.set({ from: drag.from, over: index });
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (drag.from >= 0) moveOp(drag.from, index);
        drag.set({ from: -1, over: -1 });
      }}
      onDragEnd={() => drag.set({ from: -1, over: -1 })}
      data-testid="op-row"
    >
      <div className={styles.opHead}>
        <span className={styles.grip} aria-hidden>
          <Icon name="grip-vertical" size={14} />
        </span>
        <Switch checked={op.on} onChange={(on) => toggleOp(op.id, on)} aria-label={`${opLabel(op.kind)} on or off`} tip={`Turn ${opLabel(op.kind)} on or off`} />
        <button type="button" className={styles.opName} aria-expanded={open} data-tip={def?.effect ?? opLabel(op.kind)} onClick={() => setOpen(!open)}>
          {opLabel(op.kind)}
        </button>
        <button
          type="button"
          className={styles.chip}
          data-tip={`Where this applies: ${regionLabel(op.region)}. Click to change it`}
          aria-label={`Region: ${regionLabel(op.region)}`}
          onClick={() => setOpen(true)}
        >
          {regionLabel(op.region)}
        </button>
        {op.chaos && (
          <span className={styles.chip} data-tip="This op only switches on at Bonkers (Wildness above 66%)" data-on={chaosOn(wild) || undefined}>
            Bonkers only
          </span>
        )}
        <IconButton label={locked ? "Unlock this op for Chaos" : "Lock this op for Chaos"} icon={locked ? "lock" : "lock-open"} size="sm" pressed={locked} onClick={() => toggleLock(op.id)} />
        <IconButton label="Move up" icon="chevron-up" size="sm" aria-disabled={index === 0 || undefined} onClick={() => index > 0 && moveOp(index, index - 1)} />
        <IconButton label="Move down" icon="chevron-down" size="sm" aria-disabled={last || undefined} onClick={() => !last && moveOp(index, index + 1)} />
        <IconButton label={`Remove ${opLabel(op.kind)}`} icon="trash-2" size="sm" variant="danger" onClick={() => removeOp(op.id)} />
      </div>
      <label className={styles.param}>
        <span className={styles.paramLabel}>Amount</span>
        <Slider value={op.amount} min={0} max={1} step={0.01} onChange={(a) => setAmount(op.id, a)} aria-label={`${opLabel(op.kind)} amount`} data-tip="How strongly this op is applied at Wildness 1; lower Wildness scales it down" format={pct} />
      </label>
      {open && (
        <div className={styles.opBody}>
          <RegionEditor op={op} />
          {Object.entries(def?.params ?? {}).map(([k, spec]) => (
            <ParamEditor key={k} id={op.id} name={k} spec={spec} value={op.params[k]} />
          ))}
          <Switch checked={!!op.chaos} onChange={(c) => setChaosFlag(op.id, c)} label="Only at Bonkers" tip="Switch this op on only when Wildness is above 66%" />
        </div>
      )}
    </li>
  );
}

interface DragState {
  from: number;
  over: number;
  set(v: { from: number; over: number }): void;
}

/** The kinds offered by Add op: the catalog, or every kind when it isn't loaded. */
function addable(): GradeOpKind[] {
  const have = Object.keys(OP_DEFS) as GradeOpKind[];
  return have.length > 0 ? have : [...GRADE_OP_KINDS];
}

export function LookPanel() {
  const recipe = useGrade((s) => s.recipe);
  const renameLook = useGrade((s) => s.renameLook);
  const addOp = useGrade((s) => s.addOp);
  const [drag, setDrag] = useState({ from: -1, over: -1 });
  const full = recipe.ops.length >= MAX_OPS;
  return (
    <div className={styles.panel}>
      <TextField
        size="sm"
        value={recipe.name}
        maxLength={MAX_NAME}
        aria-label="Look name"
        data-tip="The name this look is saved and exported under"
        onChange={(e) => renameLook(e.target.value)}
      />
      {recipe.ops.length === 0 ? (
        <p className={styles.note}>This look has no ops yet, so the picture is unchanged. Pick one in the gallery, or add an op.</p>
      ) : (
        <ol className={styles.opList} aria-label="Ops, applied from top to bottom">
          {recipe.ops.map((op, i) => (
            <OpRow key={op.id} op={op} index={i} last={i === recipe.ops.length - 1} drag={{ ...drag, set: setDrag }} />
          ))}
        </ol>
      )}
      <MenuButton
        label="Add an op"
        icon="plus"
        variant="secondary"
        tip={full ? `A look holds at most ${MAX_OPS} ops` : "Add one more step to this look"}
        items={() =>
          full
            ? []
            : addable().map((k) => ({ id: k, label: opLabel(k), tip: opDef(k)?.effect ?? opLabel(k), onSelect: () => addOp(k) }))
        }
        emptyLabel={`A look holds at most ${MAX_OPS} ops`}
      />
    </div>
  );
}
