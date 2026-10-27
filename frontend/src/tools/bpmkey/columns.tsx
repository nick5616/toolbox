import { Badge, Tooltip } from "@/components";
import { formatRelativeTime } from "@/lib/format";
import type { ResultColumn } from "@/tools/_kit";
import { bpmText, confidenceText, type BpmRow } from "./results";
import styles from "./BpmKeyView.module.css";

function candidatesLabel(row: BpmRow): string {
  const c = row.result.bpmCandidates ?? [];
  const list = c.length > 0 ? c : [row.result.bpm / 2, row.result.bpm * 2];
  return `Candidates: ${list.map((x) => x.toFixed(1)).join(" · ")}`;
}

/** Result table columns (the CSV is derived from `text`). */
export function bpmColumns(now: number = Date.now()): ResultColumn<BpmRow>[] {
  return [
    { key: "file", header: "File", render: (r) => <span title={r.file}>{r.file}</span>, text: (r) => r.file },
    {
      key: "bpm",
      header: "BPM",
      mono: true,
      render: (r) => (
        <Tooltip label={candidatesLabel(r)}>
          <span tabIndex={0}>{bpmText(r.result)}</span>
        </Tooltip>
      ),
      text: (r) => bpmText(r.result),
    },
    { key: "key", header: "Key", render: (r) => r.result.key, text: (r) => r.result.key },
    {
      key: "camelot",
      header: "Camelot",
      render: (r) => <Badge mono>{r.result.camelot}</Badge>,
      text: (r) => r.result.camelot,
    },
    {
      key: "confidence",
      header: "Confidence",
      render: (r) => {
        const pct = Math.round(Math.min(1, Math.max(0, r.result.confidence)) * 100);
        return (
          <span className={r.result.confidence < 0.5 ? styles.dim : undefined}>
            <span className={styles.bar} aria-hidden="true">
              <span className={styles.fill} style={{ width: `${pct}%` }} />
            </span>
            <span className={styles.num}>{confidenceText(r.result)}</span>
          </span>
        );
      },
      text: (r) => confidenceText(r.result),
    },
    {
      key: "analyzed",
      header: "Analyzed",
      render: (r) => formatRelativeTime(r.at, now),
      text: (r) => new Date(r.at).toISOString(),
    },
  ];
}
