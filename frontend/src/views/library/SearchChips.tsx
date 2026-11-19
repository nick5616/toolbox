import { Icon, cx } from "@/components";
import type { LabelCount } from "@/lib/api";
import type { SimilarTo } from "@/state/search";
import styles from "./Search.module.css";

/** The label chips above the results: "apple · 34". Clicking one filters by that label. */
export function LabelChipRow({ labels, active, onToggle }: { labels: readonly LabelCount[]; active: readonly string[]; onToggle: (label: string) => void }) {
  const shown = labels.filter((l) => !active.includes(l.label));
  if (shown.length === 0) return null;
  return (
    <div className={styles.chipRow} role="group" aria-label="Labels that match">
      {shown.map((l) => (
        <button key={l.label} type="button" className={styles.chip} data-tip={`Show only files labelled "${l.display}"`} onClick={() => onToggle(l.label)}>
          {l.user ? <span className={styles.chipDot} aria-hidden="true" /> : null}
          {l.display}
          <span className={styles.chipCount}>{l.count}</span>
        </button>
      ))}
    </div>
  );
}

export interface ActiveChipsProps {
  /** Active label filters (ids) with their display names. */
  labels: readonly { label: string; display: string }[];
  onRemoveLabel: (label: string) => void;
  similar: SimilarTo | null;
  onClearSimilar: () => void;
}

/** The filter bar's search chips: each active label with ×, and "Similar to <name> · Clear". */
export function ActiveChips({ labels, onRemoveLabel, similar, onClearSimilar }: ActiveChipsProps) {
  if (labels.length === 0 && !similar) return null;
  return (
    <div className={styles.chipRow} role="group" aria-label="Search filters">
      {similar ? (
        <span className={cx(styles.chip, styles.chipOn)} data-testid="similar-chip">
          Similar to {similar.name} ·
          <button type="button" className={styles.hintLink} aria-label="Clear similar" data-tip="Stop looking for similar files" onClick={onClearSimilar}>
            Clear
          </button>
        </span>
      ) : null}
      {labels.map((l) => (
        <span key={l.label} className={cx(styles.chip, styles.chipOn)}>
          {l.display}
          <button type="button" className={styles.labelX} aria-label={`Remove label ${l.display}`} data-tip="Remove this label filter" onClick={() => onRemoveLabel(l.label)}>
            <Icon name="x" size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}
