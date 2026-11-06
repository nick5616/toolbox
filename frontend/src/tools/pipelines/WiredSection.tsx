import { useMemo, useState } from "react";
import { Button, IconButton, Select } from "@/components";
import type { PipelineStep, StepType } from "@/lib/api";
import { canWire, VALUE_TYPE_LABELS } from "@/pipelines/params";
import { useDraft } from "./draftStore";
import { typeStyle } from "./graph/wireStyle";
import { compatibleSources, sourceText, stepParams, valueWireVerdict, type StepParam } from "./wiring";
import styles from "./WiredSection.module.css";

export interface WiredSectionProps {
  step: PipelineStep;
  steps: readonly PipelineStep[];
  index: number;
  type: StepType | undefined;
  catalog: readonly StepType[];
  /** Replaces the step's binds. */
  onBinds: (binds: Array<{ option: string; var: string }>) => void;
  /** Show the section even with nothing wired (the graph's Step panel); the List view only shows it once something is wired. */
  always?: boolean;
}

const NO_PARAMS: never[] = [];

/** The step's wired settings (Phase 16 §3.3): what each takes from earlier steps, the input or a run parameter. */
export function WiredSection({ step, steps, index, type, catalog, onBinds, always = false }: WiredSectionProps) {
  const check = useDraft((s) => s.check);
  const runParams = useDraft((s) => s.draft?.params) ?? NO_PARAMS;
  const params = useMemo(() => stepParams(step, type), [step, type]);
  const binds = step.binds ?? [];
  const [adding, setAdding] = useState(false);
  const [pointer, setPointer] = useState("");
  const [varName, setVarName] = useState("");

  if (params.length === 0 || (!always && binds.length === 0)) return null;

  const def = (ptr: string): StepParam | undefined => params.find((p) => p.pointer === ptr);
  const sourcesFor = (d: StepParam) => compatibleSources(steps, index, check, runParams, d.type);
  const setBind = (ptr: string, name: string) => onBinds([...binds.filter((b) => b.option !== ptr), { option: ptr, var: name }]);
  const unwire = (ptr: string) => onBinds(binds.filter((b) => b.option !== ptr));

  const free = params.filter((p) => !binds.some((b) => b.option === p.pointer) && sourcesFor(p).length > 0);
  const picked = def(pointer) ?? free[0];
  const pickedSources = picked ? sourcesFor(picked) : [];
  const chosen = pickedSources.find((s) => s.name === varName) ?? pickedSources[0];

  return (
    <section className={styles.root} aria-label="Wired settings">
      <h4 className={styles.head} data-tip="Settings that take their value from another step, the input or a question asked when the run starts">
        Wired
      </h4>
      {binds.length === 0 && <p className={styles.none}>Nothing is wired. A wired setting takes its value from a variable at run time.</p>}
      {binds.map((b) => {
        const d = def(b.option);
        if (!d) return null;
        const options = sourcesFor(d);
        const current = options.find((s) => s.name === b.var);
        const verdict = current ? valueWireVerdict(steps, catalog, current, step.id, d) : { ok: false, reason: `Nothing before this step makes {${b.var}}` };
        const loose = verdict.ok && current !== undefined && canWire(current.type, d.type).loose === true;
        return (
          <div key={b.option} className={styles.row} data-param={b.option}>
            <div className={styles.line}>
              <span className={styles.dot} style={typeStyle(current?.type ?? d.type)} aria-hidden="true" />
              <span className={styles.label} data-tip={`${d.label} (${VALUE_TYPE_LABELS[d.type].toLowerCase()})`}>
                {d.label}
              </span>
              <span className={styles.from}>{current ? `← ${sourceText(steps, catalog, current)}` : `← {${b.var}}`}</span>
              <IconButton size="sm" icon="x" label={`Unwire ${d.label}`} data-tip="Take the wire off: the step uses its own setting again" onClick={() => unwire(b.option)} />
            </div>
            <Select
              size="sm"
              aria-label={`Value for ${d.label}`}
              value={current ? b.var : ""}
              options={[...(current ? [] : [{ value: "", label: `{${b.var}} (missing)`, disabled: true }]), ...options.map((s) => ({ value: s.name, label: sourceText(steps, catalog, s) }))]}
              onChange={(name) => name && setBind(b.option, name)}
            />
            <p className={verdict.ok ? styles.fallback : styles.bad}>
              {verdict.ok ? `If the wire is empty, uses ${d.value === "" ? "(empty)" : d.value}${loose ? ". The run fails if the value doesn't fit." : ""}` : verdict.reason}
            </p>
          </div>
        );
      })}
      {adding ? (
        <div className={styles.add} role="group" aria-label="Add a wire">
          <Select
            size="sm"
            aria-label="Setting to wire"
            value={picked?.pointer ?? ""}
            options={free.map((p) => ({ value: p.pointer, label: p.label }))}
            onChange={(v) => {
              setPointer(v);
              setVarName("");
            }}
          />
          <Select size="sm" aria-label="Value to wire in" value={chosen?.name ?? ""} options={pickedSources.map((s) => ({ value: s.name, label: sourceText(steps, catalog, s) }))} onChange={setVarName} />
          <Button
            size="sm"
            variant="primary"
            disabled={!picked || !chosen}
            data-tip={!picked || !chosen ? "Pick a setting and a value that fits it" : "Wire this value into the setting"}
            onClick={() => {
              if (!picked || !chosen) return;
              setBind(picked.pointer, chosen.name);
              setAdding(false);
              setPointer("");
              setVarName("");
            }}
          >
            Wire
          </Button>
          <IconButton size="sm" icon="x" label="Cancel" onClick={() => setAdding(false)} />
        </div>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          icon="plus"
          disabled={free.length === 0}
          data-tip={free.length === 0 ? "Every setting that can take a value is already wired, or nothing earlier makes a value that fits" : "Wire a variable into one of this step's settings"}
          onClick={() => setAdding(true)}
        >
          Add a wire…
        </Button>
      )}
    </section>
  );
}
