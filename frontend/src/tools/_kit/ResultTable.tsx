import type { ReactNode } from "react";

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

/** RFC 4180 CSV of the given rows (header row first). */
export function toCsv<Row>(rows: Row[], columns: ResultColumn<Row>[]): string {
  void rows;
  void columns;
  return "";
}

/** Dense results table with copy-row and copy-all-as-CSV. */
export function ResultTable<Row>({ label }: ResultTableProps<Row>) {
  return <table aria-label={label} />;
}
