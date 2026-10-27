import type { ReactNode } from "react";
import { Button, DropZone, FileList, Section } from "@/components";
import { formatBytes } from "@/lib/format";
import { useShortcut } from "@/lib/shortcuts";
import { JobRow } from "@/shell/JobRow";
import { isActive, useOrderedJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { DepsGate, useDepsGate } from "./DepsGate";
import type { FileInputs } from "./useFileInputs";
import styles from "./FileToolLayout.module.css";

export interface FileToolLayoutProps {
  moduleId: string;
  inputs: FileInputs;
  /** Options section (rendered between inputs and the run button). */
  options?: ReactNode;
  /** Run button label, e.g. "Split 3 tracks". */
  runLabel: string;
  onRun: () => void | Promise<void>;
  /** Extra reason to disable the run button (deps are handled by the layout). */
  runDisabledReason?: string;
  /** Running state for the button spinner. */
  running?: boolean;
  /** Per-input error messages keyed by path (shown inline in the file list). */
  inputErrors?: Record<string, string>;
  /** Results section (rendered below Active jobs). */
  results?: ReactNode;
}

/** Shared layout for file-based tools (SPEC.md §7.1). */
export function FileToolLayout({
  moduleId,
  inputs,
  options,
  runLabel,
  onRun,
  runDisabledReason,
  running = false,
  inputErrors,
  results,
}: FileToolLayoutProps) {
  const mod = useModules((s) => s.byId[moduleId]);
  const gate = useDepsGate(moduleId);
  const jobs = useOrderedJobs(moduleId);
  const active = jobs.filter(isActive);

  const empty = inputs.files.length === 0;
  const reason = gate.blocked ? gate.reason : (runDisabledReason ?? "");
  const canRun = !empty && !gate.blocked && !runDisabledReason && !running;
  const totalSize = inputs.files.reduce((n, f) => n + f.sizeBytes, 0);

  const run = () => {
    if (canRun) void onRun();
  };
  useShortcut("Mod+Enter", run, { when: canRun, allowInInputs: true });

  return (
    <section className={styles.root} aria-label={mod?.name ?? moduleId}>
      <header className={styles.header}>
        <h1 className={styles.title}>{mod?.name ?? moduleId}</h1>
        {mod?.tagline && <p className={styles.tagline}>{mod.tagline}</p>}
      </header>

      <DepsGate moduleId={moduleId} />

      <Section
        label="Input"
        action={
          !empty && (
            <span className={styles.summary}>
              <span className={styles.mono}>
                {inputs.files.length} {inputs.files.length === 1 ? "file" : "files"} · {formatBytes(totalSize)}
              </span>
              <Button size="sm" variant="secondary" icon="plus" onClick={() => void inputs.pick()}>
                Add files…
              </Button>
              <Button size="sm" variant="ghost" onClick={inputs.clear}>
                Clear
              </Button>
            </span>
          )
        }
      >
        {empty ? (
          <DropZone id={`tool-drop:${moduleId}`} label="Drop files here or Add files…">
            <Button size="sm" variant="secondary" icon="plus" onClick={() => void inputs.pick()}>
              Add files…
            </Button>
          </DropZone>
        ) : (
          <FileList
            aria-label="Input files"
            files={inputs.files.map((f) => {
              const err = inputErrors?.[f.path];
              return {
                path: f.path,
                size: f.sizeBytes,
                trailing: err ? (
                  <span className={styles.error} role="alert">
                    {err}
                  </span>
                ) : undefined,
              };
            })}
            onRemove={inputs.remove}
          />
        )}
      </Section>

      {options}

      <div className={styles.run}>
        <Button variant="primary" kbd="Mod+Enter" loading={running} disabled={!canRun} onClick={run}>
          {runLabel}
        </Button>
        {reason && <p className={styles.reason}>{reason}</p>}
      </div>

      {active.length > 0 && (
        <Section label="Active">
          <div className={styles.jobs}>
            {active.map((j) => (
              <JobRow key={j.id} job={j} compact />
            ))}
          </div>
        </Section>
      )}

      {results}
    </section>
  );
}
