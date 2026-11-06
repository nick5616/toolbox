import { Section } from "@/components";
import { useRecentOutputs } from "@/state/library";
import type { OutputKind } from "@/lib/api";
import { ResultRow } from "./ResultRow";
import styles from "./results.module.css";

export interface RecentResultsProps {
  /** The tool whose past results are listed. */
  moduleId: string;
  /** Rows shown (default 6). */
  limit?: number;
  /** Only these kinds (default: all). */
  kinds?: readonly OutputKind[];
  /** Lucide icon for the rows. */
  icon?: string;
  /** Clicking (double-click or Enter) a row calls this instead of opening the file in its default app. */
  onPick?: (path: string) => void;
  /** Section label (default "Recent"). */
  label?: string;
  /** Tooltip of the section (what a click does). */
  tip?: string;
}

/**
 * A tool's own past results (the Library filtered to the tool), so a result is
 * never unreachable once the tool's working area has moved on.
 * Renders nothing when there are none.
 */
export function RecentResults({ moduleId, limit = 6, kinds, icon, onPick, label = "Recent", tip }: RecentResultsProps) {
  const all = useRecentOutputs(moduleId, 50);
  const rows = (kinds ? all.filter((o) => kinds.includes(o.kind)) : all).slice(0, limit);
  if (rows.length === 0) return null;
  return (
    <Section label={label} tip={tip ?? "Results this tool made before, newest first"}>
      <div className={styles.recentList} aria-label={label}>
        {rows.map((o) => (
          <ResultRow
            key={o.id}
            path={o.path}
            outputId={o.id}
            missing={o.missing}
            name={o.name}
            sizeBytes={o.sizeBytes}
            at={o.createdAt}
            moduleId={moduleId}
            {...(icon ? { icon } : {})}
            {...(onPick ? { onOpen: () => onPick(o.path) } : {})}
          />
        ))}
      </div>
    </Section>
  );
}
