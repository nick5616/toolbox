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
    { key: "file", header: "File", render: (r) => <span data-tip={r.file}>{r.file}</span>, text: (r) => r.file },
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
    { key: "key", header: "Key", render: (r) => <span data-tip="Detected musical key (tonic and major or minor)">{r.result.key}</span>, text: (r) => r.result.key },
    {
      key: "camelot",
      header: "Camelot",
      render: (r) => (
        <Badge mono tip="Camelot wheel code: tracks with the same or neighbouring code mix harmonically">
          {r.result.camelot}
        </Badge>
      ),
      text: (r) => r.result.camelot,
    },
    {
      key: "confidence",
      header: "Confidence",
      render: (r) => {
        const pct = Math.round(Math.min(1, Math.max(0, r.result.confidence)) * 100);
        return (
          <span
            className={r.result.confidence < 0.5 ? styles.dim : undefined}
            data-tip={r.result.confidence < 0.5 ? "Low confidence: check this key by ear" : "How sure the analysis is about the key; higher is more reliable"}
          >
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
      render: (r) => <span data-tip={new Date(r.at).toLocaleString()}>{formatRelativeTime(r.at, now)}</span>,
      text: (r) => new Date(r.at).toISOString(),
    },
  ];
}
