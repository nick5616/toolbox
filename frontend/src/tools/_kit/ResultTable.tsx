import type { ReactNode } from "react";
import { Button, IconButton, toast, cx } from "@/components";
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

export interface ResultTableProps<Row> {
  rows: Row[];
  columns: ResultColumn<Row>[];
  rowKey: (row: Row) => string;
  /** File name stem used for "Copy CSV" toasts / labels. */
  label: string;
  empty?: ReactNode;
  actions?: ReactNode;
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

async function copyText(text: string, title: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast({ title });
  } catch {
    toast({ title: "Couldn't copy to the clipboard", tone: "danger" });
  }
}

/** Dense results table with copy-row and copy-all-as-CSV. */
export function ResultTable<Row>({ rows, columns, rowKey, label, empty, actions }: ResultTableProps<Row>) {
  return (
    <div className={styles.root}>
      <div className={styles.bar}>
        <span className={styles.count}>
          {rows.length} {rows.length === 1 ? "result" : "results"}
        </span>
        <span className={styles.barActions}>
          {actions}
          <Button
            size="sm"
            variant="secondary"
            icon="copy"
            disabled={rows.length === 0}
            onClick={() => void copyText(toCsv(rows, columns), `Copied ${label} as CSV`)}
          >
            Copy CSV
          </Button>
        </span>
      </div>
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
                <th className={styles.copyCol}>
                  <span className={styles.srOnly}>Copy</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={rowKey(r)}>
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
                      className={styles.copyBtn}
                      onClick={() => void copyText(columns.map((c) => c.text(r)).join("\t"), "Row copied")}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
