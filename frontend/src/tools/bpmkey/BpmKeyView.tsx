import { useMemo, useState } from "react";
import { Button, ConfirmDialog, EmptyState, Section } from "@/components";
import { BpmKeyService, JobStatus } from "@/lib/api";
import { isActive, useJobs, useOrderedJobs } from "@/state/jobs";
import { FileToolLayout, ResultTable, useFileInputs } from "@/tools/_kit";
import type { ToolViewProps } from "@/tools";
import { submitJobs } from "@/tools/stems/shared/enqueue";
import { bpmColumns } from "./columns";
import { MAX_ROWS, parseBpmKeyResult, type BpmRow } from "./results";

export default function BpmKeyView({ moduleId }: ToolViewProps) {
  const inputs = useFileInputs(moduleId);
  const [running, setRunning] = useState(false);
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const [confirmClear, setConfirmClear] = useState(false);
  const jobs = useOrderedJobs(moduleId);

  const rows = useMemo(() => {
    const out: BpmRow[] = [];
    for (const j of jobs) {
      if (j.status !== JobStatus.JobDone) continue;
      const result = parseBpmKeyResult(j.resultJson);
      if (result) out.push({ id: j.id, file: j.title, at: j.finishedAt || j.createdAt, result });
    }
    return out.sort((a, b) => b.at - a.at).slice(0, MAX_ROWS);
  }, [jobs]);
  const columns = useMemo(() => bpmColumns(Date.now()), [rows]);

  const n = inputs.files.length;
  const onRun = async () => {
    const paths = inputs.files.map((f) => f.path);
    setRunning(true);
    const res = await submitJobs(() => BpmKeyService.Enqueue(paths), paths, ["analysis", "analyses"]);
    setRunning(false);
    setInputErrors(res.inputErrors);
    if (res.ok) inputs.clear();
  };

  const clearResults = () => {
    setConfirmClear(false);
    const remove = useJobs.getState().remove;
    for (const j of jobs) if (!isActive(j)) void remove(j.id).catch(() => undefined);
  };

  return (
    <>
      <FileToolLayout
        moduleId={moduleId}
        inputs={inputs}
        runLabel={`Analyze ${n} ${n === 1 ? "file" : "files"}`}
        onRun={onRun}
        running={running}
        inputErrors={inputErrors}
        results={
          <Section label="Results">
            <ResultTable
              rows={rows}
              columns={columns}
              rowKey={(r) => r.id}
              label="BPM and key"
              empty={<EmptyState icon="activity" title="No analyses yet." body="Add tracks to detect their tempo and key." />}
              actions={
                <Button size="sm" variant="ghost" icon="trash-2" disabled={rows.length === 0} onClick={() => setConfirmClear(true)}>
                  Clear results
                </Button>
              }
            />
          </Section>
        }
      />
      <ConfirmDialog
        open={confirmClear}
        title="Clear results?"
        body="This removes the finished analyses from the list. Your files are not touched."
        confirmLabel="Clear"
        tone="danger"
        onConfirm={clearResults}
        onCancel={() => setConfirmClear(false)}
      />
    </>
  );
}
