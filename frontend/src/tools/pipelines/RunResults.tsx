import { Button } from "@/components";
import { LibraryService } from "@/lib/api";
import { toast } from "@/components";
import { toAppError } from "@/lib/errors";
import type { RunFileView, RunView } from "@/state/pipelines";
import { orderItems } from "./RunGridModel";
import { ResultTable } from "@/tools/_kit";
import { RunFileRow } from "./RunResultsFileRow";
import styles from "./RunResults.module.css";

// Results of a run (SPEC.md §11.5): the files of every Keep step, grouped by
// item, and the variables each item made.
export function RunResults({ run }: { run: RunView }) {
  const keepIdx = run.steps.map((s, i) => (s.keep ? i : -1)).filter((i) => i >= 0);
  const groups = orderItems(run.items)
    .map((item) => {
      const files: RunFileView[] = [];
      for (const i of keepIdx) {
        const cell = item.cells[i];
        if (cell) files.push(...cell.files);
      }
      return { item, files };
    })
    .filter((g) => g.files.length > 0);

  const varRows = orderItems(run.items).filter((i) => Object.keys(i.vars).length > 0);
  const varKeys = [...new Set(varRows.flatMap((i) => Object.keys(i.vars)))];

  if (groups.length === 0 && varRows.length === 0) return null;

  const openFolder = () => {
    LibraryService.OpenLibraryFolder(`Pipelines/${run.name}`).catch((e: unknown) => {
      const err = toAppError(e);
      toast({ tone: "danger", title: err.message, description: err.hint });
    });
  };

  return (
    <section className={styles.results} aria-label="Results">
      <div className={styles.head}>
        <h3 className={styles.heading} data-tip="Files from the steps set to be kept, grouped by input file">Results</h3>
        {groups.length > 0 && (
          <Button size="sm" icon="folder-open" data-tip="Open the folder in your library where this run saved its files" onClick={openFolder}>
            Open folder
          </Button>
        )}
      </div>
      {groups.map(({ item, files }) => (
        <div key={item.index} className={styles.group}>
          <div className={styles.groupLabel}>{item.label}</div>
          <div className={styles.files}>
            {files.map((f) => (
              <RunFileRow key={f.path} file={f} />
            ))}
          </div>
        </div>
      ))}
      {varRows.length > 0 && (
        <ResultTable
          label="Variables"
          rows={varRows}
          rowKey={(i) => String(i.index)}
          columns={[
            { key: "_file", header: "File", render: (i) => i.label, text: (i) => i.label },
            ...varKeys.map((k) => ({ key: k, header: k, render: (i: (typeof varRows)[number]) => i.vars[k] ?? "", text: (i: (typeof varRows)[number]) => i.vars[k] ?? "" })),
          ]}
        />
      )}
    </section>
  );
}
