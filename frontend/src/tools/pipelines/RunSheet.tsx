import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { Banner, Button, DropZone, Icon, IconButton, TextArea, TextField, cx } from "@/components";
import { FilesService, PipelinesService, type PipelineParam } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { describeAccepts } from "@/pipelines/compat";
import { fromWireType, validParamValue } from "@/pipelines/params";
import { usePipelineEntry, usePipelines } from "@/state/pipelines";
import { typeStyle } from "./graph/wireStyle";
import { ParamField, type ParamFieldType } from "./ParamField";
import { baseName } from "./RunGridModel";
import { inputAccepted, isLink, mergeInputs } from "./RunSheetModel";
import styles from "./RunSheet.module.css";

// The Run sheet (SPEC.md §11.5): choose the files or links, enter the
// passwords the steps need, and start a run.
export interface RunSheetProps {
  pipelineId: string;
}

const MAX_INPUTS = 200;
const NO_INPUTS: string[] = [];

function parseLinks(text: string): string[] {
  return text
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => isLink(s));
}

export function RunSheet({ pipelineId }: RunSheetProps) {
  const titleId = useId();
  const entry = usePipelineEntry(pipelineId);
  const inputs = usePipelines((s) => s.runSheet?.inputs ?? NO_INPUTS);
  const setInputs = usePipelines((s) => s.setRunSheetInputs);
  const close = usePipelines((s) => s.closeRunSheet);
  const [linksText, setLinksText] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  // Run parameter values the user changed; the rest show (and send) their defaults.
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; hint: string } | null>(null);

  const accepts = entry?.check.accepts;
  const links = useMemo(() => parseLinks(linksText), [linksText]);
  const all = useMemo(() => mergeInputs(inputs, links), [inputs, links]);

  useEffect(() => {
    if (!entry) close();
  }, [entry, close]);

  if (!entry || !accepts) return null;
  const name = entry.pipeline.name;
  const needs = entry.check.secrets ?? [];

  const accepted = all.filter((i) => inputAccepted(accepts, i));
  const secretKey = (stepId: string, key: string) => `${stepId}.${key}`;
  const missingSecret = needs.some((s) => !(secrets[secretKey(s.stepId, s.key)] ?? "").length);
  const tooMany = accepted.length > MAX_INPUTS;
  const ready = entry.check.ready;
  const runParams = entry.pipeline.params ?? [];
  const valueOf = (p: PipelineParam) => edited[p.name] ?? p.default;
  const badParam = runParams.find((p) => {
    const t = fromWireType(p.type);
    return t !== "file" && t !== "files" && !validParamValue(t, valueOf(p), p.choices ?? []);
  });
  const canStart = ready && !busy && accepted.length > 0 && !tooMany && !missingSecret && !badParam;

  const choose = async () => {
    try {
      const picked = await FilesService.PickWith(`Run ${name}`, accepts.extensions ?? [], true);
      if (picked && picked.length > 0) setInputs(mergeInputs(inputs, picked));
    } catch (e) {
      const err = toAppError(e);
      setError({ message: err.message, hint: err.hint ?? "" });
    }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const sec: Record<string, string> = {};
      for (const s of needs) sec[secretKey(s.stepId, s.key)] = secrets[secretKey(s.stepId, s.key)] ?? "";
      const params: Record<string, string> = {};
      for (const p of runParams) params[p.name] = valueOf(p);
      const run = await PipelinesService.Start({ pipelineId, inputs: accepted, secrets: sec, params });
      usePipelines.getState().upsertRun(run);
      close();
      usePipelines.getState().showRun(run.id);
    } catch (e) {
      const err = toAppError(e);
      setError({ message: err.message, hint: err.hint ?? "" });
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const takes = describeAccepts(accepts);

  return (
    <div className={styles.backdrop} onMouseDown={close}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className={styles.title}>
          Run {name}
        </h2>
        <p className={styles.sub}>Takes {takes}.</p>

        {!ready && (
          <Banner tone="warn" title="This pipeline can't run yet">
            {(entry.check.missing ?? []).length > 0 ? `Needs ${(entry.check.missing ?? []).join(", ")}. Install them in Settings.` : "Fix the problems in the pipeline first."}
          </Banner>
        )}

        <DropZone
          id={`pipeline-run:${pipelineId}`}
          label="Drop files here"
          hint={accepts.urls ? "or paste links below" : undefined}
          className={styles.drop}
        >
          <Button size="sm" icon="folder-open" data-tip="Pick the files to run this pipeline on" onClick={() => void choose()}>
            Choose files
          </Button>
        </DropZone>

        {accepts.urls && (
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Links</span>
            <TextArea
              aria-label="Links"
              data-tip="Web addresses to run on, one per line"
              placeholder="One link per line"
              value={linksText}
              minRows={2}
              maxRows={5}
              mono
              onChange={(e) => setLinksText(e.target.value)}
            />
          </label>
        )}

        {all.length > 0 && (
          <ul className={styles.inputs} aria-label="Inputs">
            {all.map((i) => {
              const ok = inputAccepted(accepts, i);
              const link = isLink(i);
              return (
                <li key={i} className={cx(styles.input, !ok && styles.struck)} data-accepted={ok}>
                  <Icon name={link ? "link" : "file"} size={14} className={styles.inputIcon} />
                  <span className={styles.inputName} data-tip={i}>
                    {link ? i : baseName(i)}
                  </span>
                  {!ok && <span className={styles.notFor} data-tip="This pipeline cannot start with this kind of file, so it will be skipped">not for this pipeline</span>}
                  {!link && <IconButton size="sm" icon="x" label={`Remove ${baseName(i)}`} data-tip="Take this file out of the run (the file itself is untouched)" onClick={() => setInputs(inputs.filter((x) => x !== i))} />}
                </li>
              );
            })}
          </ul>
        )}
        {tooMany && <div className={styles.problem}>At most {MAX_INPUTS} files per run.</div>}

        {needs.length > 0 && (
          <div className={styles.secrets}>
            {needs.map((s) => {
              const key = secretKey(s.stepId, s.key);
              return (
                <label key={key} className={styles.field}>
                  <span className={styles.fieldLabel}>{s.label}</span>
                  <TextField
                    type="password"
                    aria-label={s.label}
                    data-tip="Needed by a step to open protected files; kept in memory for this run only, never saved"
                    autoComplete="off"
                    value={secrets[key] ?? ""}
                    onChange={(e) => setSecrets((cur) => ({ ...cur, [key]: e.target.value }))}
                  />
                </label>
              );
            })}
            <span className={styles.note}>Passwords are kept in memory for this run only.</span>
          </div>
        )}

        {runParams.length > 0 && (
          <div className={styles.secrets} role="group" aria-label="Run parameters">
            {runParams.map((p) => {
              const t = fromWireType(p.type);
              const ft: ParamFieldType = t === "file" || t === "files" ? "text" : t;
              return (
                <div key={p.name} className={styles.field}>
                  <span className={styles.fieldLabel}>
                    <span className={styles.typeDot} style={typeStyle(t)} aria-hidden="true" />
                    {p.label}
                  </span>
                  <ParamField type={ft} value={valueOf(p)} choices={p.choices ?? []} label={p.label} onChange={(v) => setEdited((cur) => ({ ...cur, [p.name]: v }))} />
                </div>
              );
            })}
          </div>
        )}

        {error && (
          <Banner tone="danger" title={error.message}>
            {error.hint}
          </Banner>
        )}

        <div className={styles.footer}>
          <Button variant="secondary" data-tip="Close without starting" data-tip-kbd="Esc" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" icon="play" disabled={!canStart} data-tip={!ready ? "The pipeline cannot run yet; see the message above" : accepted.length === 0 ? "Add at least one file or link this pipeline accepts" : tooMany ? `Remove some inputs; a run takes at most ${MAX_INPUTS}` : missingSecret ? "Enter the passwords the steps need" : badParam ? `Check “${badParam.label}”: that value doesn't fit` : "Start the run on the listed inputs"} onClick={() => void start()}>
            {accepted.length > 1 ? `Start with ${accepted.length} files` : "Start"}
          </Button>
        </div>
      </div>
    </div>
  );
}
