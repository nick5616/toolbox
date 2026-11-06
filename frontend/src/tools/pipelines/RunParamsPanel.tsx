import { useState } from "react";
import { ConfirmDialog, IconButton, TextField } from "@/components";
import type { PipelineParam } from "@/lib/api";
import { fromWireType, validParamValue, VALUE_TYPE_LABELS } from "@/pipelines/params";
import { useDraft } from "./draftStore";
import { stepsOf } from "./editorModel";
import { typeStyle } from "./graph/wireStyle";
import { ParamField, type ParamFieldType } from "./ParamField";
import { bindCount } from "./wiring";
import styles from "./RunParamsPanel.module.css";

const NO_PARAMS: PipelineParam[] = [];

function fieldType(p: PipelineParam): ParamFieldType {
  const t = fromWireType(p.type);
  return t === "file" ? "text" : t === "files" ? "text" : t;
}

/** The label of a run parameter; committed once it isn't empty, restored on blur otherwise. */
function LabelField({ param, onCommit }: { param: PipelineParam; onCommit: (label: string) => void }) {
  const [text, setText] = useState(param.label);
  return (
    <TextField
      size="sm"
      aria-label={`Label of ${param.name}`}
      value={text}
      maxLength={60}
      invalid={text.trim() === ""}
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value.trim() !== "") onCommit(e.target.value);
      }}
      onBlur={() => {
        if (text.trim() === "") setText(param.label);
      }}
    />
  );
}

/** The default of a run parameter; committed while it is valid for its type. */
function DefaultField({ param, onCommit }: { param: PipelineParam; onCommit: (value: string) => void }) {
  const [text, setText] = useState(param.default);
  const choices = param.choices ?? [];
  const type = fieldType(param);
  return (
    <ParamField
      type={type}
      value={text}
      choices={choices}
      label={`Default of ${param.label}`}
      onChange={(v) => {
        setText(v);
        if (validParamValue(type, v, choices)) onCommit(v);
      }}
    />
  );
}

/** The Input node's panel (Phase 16 §3.4): the run parameters, each with a type dot, label, name, default and a remove button. */
export function InputPanelBody() {
  const params = useDraft((s) => s.draft?.params) ?? NO_PARAMS;
  const draft = useDraft((s) => s.draft);
  const updateParam = useDraft((s) => s.updateParam);
  const removeParam = useDraft((s) => s.removeParam);
  const [confirm, setConfirm] = useState<string | null>(null);
  const target = params.find((p) => p.name === confirm);
  const uses = target && draft ? bindCount(stepsOf(draft), target.name) : 0;

  return (
    <div className={styles.root} data-no-wheel="1">
      <p className={styles.help}>Every run starts here: the files you run it on, then the built-in values (file name, item number, date…) and these run parameters, which you are asked for when you start a run.</p>
      <section className={styles.section} aria-label="Run parameters">
        <h4 className={styles.head} data-tip="Values asked for when a run starts. Wire them into any step's settings">
          Run parameters
        </h4>
        {params.length === 0 && <p className={styles.none}>None yet. In the graph, right-click a setting&apos;s port and choose “Ask when the run starts”.</p>}
        {params.map((p) => (
          <div key={p.name} className={styles.row}>
            <div className={styles.line}>
              <span className={styles.dot} style={typeStyle(fromWireType(p.type))} aria-hidden="true" />
              <span className={styles.type}>{VALUE_TYPE_LABELS[fromWireType(p.type)]}</span>
              <code className={styles.name} data-tip="The name steps use for this value, as {name}">
                {`{${p.name}}`}
              </code>
              <IconButton size="sm" icon="trash-2" label={`Remove ${p.label}`} data-tip="Remove this run parameter and the wires that use it" onClick={() => setConfirm(p.name)} />
            </div>
            <div className={styles.fields}>
              <LabelField param={p} onCommit={(label) => updateParam(p.name, { label })} />
              <DefaultField param={p} onCommit={(value) => updateParam(p.name, { default: value })} />
            </div>
          </div>
        ))}
      </section>
      <ConfirmDialog
        open={target !== undefined}
        title={target ? `Remove “${target.label}”?` : ""}
        tone="danger"
        confirmLabel="Remove"
        body={uses > 0 ? `This also unwires ${uses} ${uses === 1 ? "setting" : "settings"} that use it. Those settings go back to their own values.` : "Nothing is wired to it."}
        onConfirm={() => {
          if (target) removeParam(target.name);
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
