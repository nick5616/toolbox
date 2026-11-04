import type { ReactNode } from "react";
import { Button, ClickIn, ClickInHost, DropZone, FileList, Section } from "@/components";
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
  /** Legacy options section (rendered between inputs and the run button). Prefer `primary` + `advanced`. */
  options?: ReactNode;
  /** The one or two settings that belong on the top level (rendered between the input and the run button). */
  primary?: ReactNode;
  /** Everything else: one "Advanced" click-in row that opens a drawer. */
  advanced?: ReactNode;
  /** One-line state of the advanced settings ("MP3 · 320 kbps · keep metadata"). */
  advancedSummary?: string;
  /** Drawer title (default "Advanced"). */
  advancedTitle?: string;
  /** Extra click-ins (e.g. a separate "Model" group), rendered under the Advanced row. */
  moreClickIns?: ReactNode;
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
  primary,
  advanced,
  advancedSummary,
  advancedTitle = "Advanced",
  moreClickIns,
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

  const hasPanels = advanced != null || moreClickIns != null;

  return (
    <ClickInHost className={styles.host}>
      <div className={styles.scroll}>
    <section className={styles.root} aria-label={mod?.name ?? moduleId}>
      {/* The shell's top bar already shows the tool's name (SPEC §13.1: no duplicate headers); only the tagline stays. */}
      {mod?.tagline && (
        <header className={styles.header}>
          <p className={styles.tagline}>{mod.tagline}</p>
        </header>
      )}

      <DepsGate moduleId={moduleId} />

      <Section
        label="Input"
        tip="The files this tool will process; originals are never changed"
        action={
          !empty && (
            <span className={styles.summary}>
              <span className={styles.mono} data-tip="How many files are queued and their combined size">
                {inputs.files.length} {inputs.files.length === 1 ? "file" : "files"} · {formatBytes(totalSize)}
              </span>
              <Button size="sm" variant="secondary" icon="plus" data-tip="Choose more files to process together" onClick={() => void inputs.pick()}>
                Add files…
              </Button>
              <Button size="sm" variant="ghost" data-tip="Remove every file from the list; the files on disk are untouched" onClick={inputs.clear}>
                Clear
              </Button>
            </span>
          )
        }
      >
        {empty ? (
          <div data-tip="Drag files here from your file manager, or use Add files">
            <DropZone id={`tool-drop:${moduleId}`} label="Drop files here or Add files…">
              <Button size="sm" variant="secondary" icon="plus" data-tip="Open a file picker" onClick={() => void inputs.pick()}>
                Add files…
              </Button>
            </DropZone>
          </div>
        ) : (
          <FileList
            aria-label="Input files"
            files={inputs.files.map((f) => {
              const err = inputErrors?.[f.path];
              return {
                path: f.path,
                size: f.sizeBytes,
                trailing: err ? (
                  <span className={styles.error} role="alert" data-tip="This file was rejected when queuing; remove it or fix it and try again">
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

      {primary != null && <div className={styles.primary}>{primary}</div>}

      {hasPanels && (
        <div className={styles.panels}>
          {advanced != null && (
            <ClickIn icon="sliders-horizontal" title={advancedTitle} summary={advancedSummary} tip="Every other setting for this tool" width={400}>
              <div className={styles.drawerBody}>{advanced}</div>
            </ClickIn>
          )}
          {moreClickIns}
        </div>
      )}

      <div className={styles.run}>
        <Button
          variant="primary"
          kbd="Mod+Enter"
          loading={running}
          disabled={!canRun}
          data-tip={canRun ? "Queue a job for the files above with these options" : running ? "Submitting the files" : empty ? "Add at least one file first" : reason}
          onClick={run}
        >
          {runLabel}
        </Button>
        {reason && <p className={styles.reason} data-tip="Why the run button is disabled">{reason}</p>}
      </div>

      {active.length > 0 && (
        <Section label="Active" tip="Jobs from this tool that are queued or running">
          <div className={styles.jobs}>
            {active.map((j) => (
              <JobRow key={j.id} job={j} compact />
            ))}
          </div>
        </Section>
      )}

      {results}
    </section>
      </div>
    </ClickInHost>
  );
}
