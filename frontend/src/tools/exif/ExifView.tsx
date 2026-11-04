import { useEffect, useMemo, useState } from "react";
import { Badge, Button, EmptyState, Icon, Section, Switch, cx } from "@/components";
import { ExifAction, ExifService, JobStatus, type ExifOptions } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { useOrderedJobs } from "@/state/jobs";
import { FileToolLayout, runLabel, summarize, useDepsGate, useFileInputs, useModuleOptions } from "@/tools/_kit";
import type { ToolViewProps } from "@/tools";
import { FileActions } from "@/tools/_kit/FileActions";
import { submitJobs } from "@/tools/_kit/enqueue";
import shared from "@/tools/_kit/results.module.css";
import { EditDialog } from "./EditDialog";
import { Inspector } from "./Inspector";
import { DEFAULT_EDITABLE_FIELDS, basename, editableValues, parseExifResult } from "./options";
import { useMetadata } from "./useMetadata";
import styles from "./ExifView.module.css";

const MAX_RESULTS = 10;

interface SavedOptions {
  keepOrientation: boolean;
}
const DEFAULT_SAVED: SavedOptions = { keepOrientation: true };
function sanitize(raw: unknown, defaults: SavedOptions): SavedOptions {
  if (typeof raw === "object" && raw !== null && typeof (raw as Record<string, unknown>).keepOrientation === "boolean") {
    return { keepOrientation: (raw as Record<string, boolean>).keepOrientation as boolean };
  }
  return defaults;
}

export default function ExifView({ moduleId }: ToolViewProps) {
  const inputs = useFileInputs(moduleId);
  const [saved, setSaved] = useModuleOptions(moduleId, DEFAULT_SAVED, sanitize);
  const gate = useDepsGate(moduleId);
  const [running, setRunning] = useState(false);
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [fieldNames, setFieldNames] = useState<string[]>(DEFAULT_EDITABLE_FIELDS);
  const jobs = useOrderedJobs(moduleId);
  const done = useMemo(
    () => jobs.filter((j) => j.status === JobStatus.JobDone && parseExifResult(j.resultJson)).slice(0, MAX_RESULTS),
    [jobs],
  );

  const paths = useMemo(() => inputs.files.map((f) => f.path), [inputs.files]);
  const meta = useMetadata(paths);

  useEffect(() => {
    ExifService.EditableFields()
      .then((f) => f && f.length > 0 && setFieldNames(f))
      .catch(() => undefined);
  }, []);

  const current = paths.includes(selected) ? selected : (paths[0] ?? "");

  const readOnly = paths.filter((p) => {
    const m = meta[p];
    return m?.status === "ok" && !m.view.editable;
  });
  const actionable = paths.filter((p) => !readOnly.includes(p));

  const submit = async (opts: ExifOptions, noun: [string, string] = ["file", "files"]) => {
    setRunning(true);
    const res = await submitJobs(() => ExifService.Enqueue(actionable, opts), actionable, noun);
    setRunning(false);
    setInputErrors(res.inputErrors);
    if (res.ok) inputs.clear();
    return res.ok;
  };

  const base = (action: ExifAction): ExifOptions => ({
    action,
    keepOrientation: saved.keepOrientation,
    fields: {},
  });

  const only = paths.length === 1 ? meta[paths[0] ?? ""] : undefined;
  const initial = only?.status === "ok" ? editableValues(only.view) : {};

  const noActionable = paths.length > 0 && actionable.length === 0;
  const barDisabled = paths.length === 0 || noActionable || gate.blocked || running;
  const barReason = paths.length === 0
    ? "Add photos first"
    : noActionable
      ? "RAW files are read-only here"
      : gate.blocked
        ? gate.reason
        : "Working on the current files";

  return (
    <>
      <FileToolLayout
        moduleId={moduleId}
        inputs={inputs}
        runLabel={runLabel("Remove location from", actionable.length, "file", "files")}
        onRun={() => void submit(base(ExifAction.ActionStripLocation))}
        runDisabledReason={noActionable ? "RAW files are read-only here" : undefined}
        running={running}
        inputErrors={inputErrors}
        primary={
          <>
            {paths.length > 0 && (
              <Section label="Inspector" tip="Look at the metadata hidden inside a file before you change anything">
                <div className={styles.panes}>
                  <ul className={styles.picker} role="listbox" aria-label="Files" data-tip="Choose which file to inspect on the right">
                    {inputs.files.map((f) => {
                      const m = meta[f.path];
                      const gps = m?.status === "ok" && m.view.hasLocation;
                      return (
                        <li
                          key={f.path}
                          role="option"
                          aria-selected={f.path === current}
                          tabIndex={0}
                          className={cx(styles.pick, f.path === current && styles.pickOn)}
                          onClick={() => setSelected(f.path)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setSelected(f.path);
                            }
                          }}
                        >
                          <Icon name="image" size={14} className={shared.icon} />
                          <span className={styles.pickName} data-tip={f.path}>
                            {basename(f.path)}
                          </span>
                          {gps && (
                            <Badge tone="warn" tip="This photo contains GPS coordinates showing where it was taken">
                              GPS
                            </Badge>
                          )}
                          {m?.status === "ok" && !m.view.editable && <Badge tip="RAW camera file; metadata can be read here but not changed">RAW</Badge>}
                          <span className={shared.meta} data-tip="File size on disk">
                            {formatBytes(f.sizeBytes)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  <div className={styles.inspectorPane}>
                    <Inspector state={meta[current]} />
                  </div>
                </div>
              </Section>
            )}
            <div className={styles.actions} data-tip="Changes are saved to new copies; the originals are never modified">
              <div className={styles.actionBtns}>
                <Button
                  variant="secondary"
                  disabled={barDisabled}
                  data-tip={barDisabled ? barReason : "Strip location, camera, dates and every other tag from new copies"}
                  onClick={() => void submit(base(ExifAction.ActionStripAll))}
                >
                  Remove all metadata
                </Button>
                <Button
                  variant="secondary"
                  icon="wand-sparkles"
                  disabled={barDisabled}
                  data-tip={barDisabled ? barReason : "Set title, author, copyright, keywords or date on new copies"}
                  onClick={() => setEditOpen(true)}
                >
                  Edit…
                </Button>
              </div>
              {readOnly.length > 0 && (
                <p className={styles.note} data-tip="RAW files cannot be edited here, so they are left out of the actions">
                  RAW files are read-only here ({readOnly.length} {readOnly.length === 1 ? "file" : "files"} skipped).
                </p>
              )}
            </div>
            <EditDialog
              open={editOpen}
              fields={fieldNames}
              initial={initial}
              count={actionable.length}
              onCancel={() => setEditOpen(false)}
              onApply={(fields) => {
                setEditOpen(false);
                void submit({ action: ExifAction.ActionEdit, keepOrientation: saved.keepOrientation, fields });
              }}
            />
          </>
        }
        advancedSummary={summarize(saved.keepOrientation ? "keeps orientation & colour profile" : "strips orientation too")}
        advanced={
          <Switch
            checked={saved.keepOrientation}
            onChange={(keepOrientation) => setSaved({ keepOrientation })}
            label="Keep orientation & colour profile"
            tip="Keep the rotation flag and colour profile so the cleaned photo still looks right; turn off to strip these too"
          />
        }
        results={
          <Section label="Results" tip="Cleaned copies; the originals are never changed">
            {done.length === 0 ? (
              <EmptyState icon="scan-search" title="No cleaned files yet." body="Cleaned copies appear here. Originals are never changed." />
            ) : (
              <ul className={shared.list}>
                {done.map((j) => {
                  const r = parseExifResult(j.resultJson);
                  if (!r) return null;
                  const out = j.outputs.find((o) => o.path === r.output);
                  return (
                    <li key={j.id} className={cx(shared.row, out?.missing && shared.missing)}>
                      <Icon name="image" size={14} className={shared.icon} />
                      <span className={shared.name} data-tip={r.output}>
                        {basename(r.output)}
                      </span>
                      {j.message && (
                        <span className={shared.meta} data-tip="What was changed in this copy">
                          {j.message}
                        </span>
                      )}
                      <span className={shared.actions}>
                        <FileActions outputId={out?.id} path={r.output} disabled={out?.missing} />
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
        }
      />
    </>
  );
}
