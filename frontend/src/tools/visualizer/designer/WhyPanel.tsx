/** "Why" (SPEC.md §8.3): what the visuals are doing at the playhead, four times a second. */
import { useMemo } from "react";
import { Icon } from "@/components";
import type { Show } from "@/viz/types";
import { useDesigner } from "./context";
import { whyFacts } from "./why";
import styles from "./designer.module.css";

export function WhyPanel({ show }: { show: Show }) {
  const d = useDesigner();
  const facts = useMemo(() => (d ? whyFacts(show, d.analysis, d.signals, d.liveMs) : []), [show, d]);
  if (facts.length === 0) return null;
  return (
    <div className={styles.why} aria-label="Why" role="status">
      <Icon name="info" size={14} className={styles.whyIcon} />
      <ul className={styles.whyList}>
        {facts.map((f, i) => (
          <li key={i}>{f}</li>
        ))}
      </ul>
    </div>
  );
}
