import type { ReactNode } from "react";
import { Button, IconButton, cx } from "@/components";
import { copyText as copyToClipboard } from "@/lib/copy";
import { saveTextAs } from "@/lib/saveText";
import { useResultBehaviour } from "./ResultRow";
import styles from "./ResultTable.module.css";

export interface ResultColumn<Row> {
  key: string;
  header: string;
  /** Cell content. */
  render: (row: Row) => ReactNode;
  /** Plain-text value for CSV and copy. */
  text: (row: Row) => string;
  align?: "left" | "right";
  mono?: boolean;
  width?: string;
}

export interface ResultFile {
  path: string;
  outputId?: string;
  missing?: boolean;
}

export interface ResultTableProps<Row> {
  rows: Row[];
  columns: ResultColumn<Row>[];
  rowKey: (row: Row) => string;
  /** File name stem used for "Copy CSV" toasts / labels. */
  label: string;
  /** Suggested file name for "Save CSV…" (default: the label as a slug + .csv). */
  fileName?: string;
  empty?: ReactNode;
  actions?: ReactNode;
  /** The file a row stands for: makes the row draggable, and double-click or Enter open it. */
  rowFile?: (row: Row) => ResultFile | undefined;
}

function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** RFC 4180 CSV of the given rows (header row first, CRLF line endings). */
export function toCsv<Row>(rows: Row[], columns: ResultColumn<Row>[]): string {
  const lines = [columns.map((c) => csvField(c.header)).join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvField(c.text(r))).join(","));
  return lines.join("\r\n");
}

function copyText(text: string, what: string): Promise<boolean> {
  return copyToClipboard(text, { what });
}

function defaultFileName(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${slug || "results"}.csv`;
}

/** A table row that behaves like a result row when it stands for a file. */
function FileTr({ file, children }: { file: ResultFile | undefined; children: ReactNode }) {
  const behaviour = useResultBehaviour({ path: file?.path ?? "", outputId: file?.outputId, missing: file?.missing || !file });
  if (!file) return <tr>{children}</tr>;
  return <tr {...behaviour}>{children}</tr>;
}

/** Dense results table with copy-row and copy-all-as-CSV. */
export function ResultTable<Row>({ rows, columns, rowKey, label, fileName, empty, actions, rowFile }: ResultTableProps<Row>) {
  return (
    <div className={styles.root}>
      {rows.length > 0 && (
      <div className={styles.bar}>
        <span className={styles.count} data-tip="Number of finished results listed below">
          {rows.length} {rows.length === 1 ? "result" : "results"}
        </span>
        <span className={styles.barActions}>
          {actions}
          <Button
            size="sm"
            variant="secondary"
            icon="copy"
            disabled={rows.length === 0}
            data-tip={rows.length === 0 ? "Nothing to copy yet" : "Copy the whole table as CSV, ready to paste into a spreadsheet"}
            onClick={() => void copyText(toCsv(rows, columns), `${label} as CSV`)}
          >
            Copy CSV
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon="download"
            data-tip="Save the whole table as a CSV file you can open in a spreadsheet"
            onClick={() => void saveTextAs(toCsv(rows, columns), fileName ?? defaultFileName(label))}
          >
            Save CSV…
          </Button>
        </span>
      </div>
      )}
      {rows.length === 0 ? (
        <div className={styles.empty}>{empty}</div>
      ) : (
        <div className={styles.scroll}>
          <table className={styles.table} aria-label={label}>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key} style={c.width ? { width: c.width } : undefined} className={cx(c.align === "right" && styles.right)}>
                    {c.header}
                  </th>
                ))}
                <th className={styles.copyCol} data-tip="Copy a row as tab-separated text">
                  <span className={styles.srOnly}>Copy</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <FileTr key={rowKey(r)} file={rowFile?.(r)}>
                  {columns.map((c) => (
                    <td key={c.key} className={cx(c.align === "right" && styles.right, c.mono && styles.mono)}>
                      {c.render(r)}
                    </td>
                  ))}
                  <td className={styles.copyCol}>
                    <IconButton
                      size="sm"
                      icon="copy"
                      label="Copy row"
                      data-tip="Copy this row as tab-separated text"
                      className={styles.copyBtn}
                      onClick={() => void copyText(columns.map((c) => c.text(r)).join("\t"), "row")}
                    />
                  </td>
                </FileTr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
