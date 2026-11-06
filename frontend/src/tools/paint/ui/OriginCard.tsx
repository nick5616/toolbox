import type { PaintOrigin } from "@/lib/api";
import type { LabOrigin } from "@/paint/lab/types";
import styles from "./ui.module.css";

/**
 * What a Lab tool is built on (SPEC §1.4): the algorithm for algorithmic
 * tools; model, licence, training data and limits for perception tools.
 */
export function OriginCard({ origin, origins }: { origin: LabOrigin; origins: readonly PaintOrigin[] }) {
  if (origin.kind === "algorithm") {
    return (
      <div className={styles.origin} data-testid="origin-card">
        <h4>Algorithm, no training data</h4>
        <span>{origin.text}</span>
      </div>
    );
  }
  const o = origins.find((x) => x.model === origin.model);
  if (!o) {
    return (
      <div className={styles.origin} data-testid="origin-card">
        <h4>{origin.model}</h4>
        <span>The model's origin card isn't available yet.</span>
      </div>
    );
  }
  return (
    <dl className={styles.origin} data-testid="origin-card">
      <h4>{o.model}</h4>
      <dt>Licence</dt>
      <dd>{o.license}</dd>
      <dt>Trained on</dt>
      <dd>{o.trainedOn}</dd>
      <dt>Makes new imagery?</dt>
      <dd>{o.generates}</dd>
      {o.source ? (
        <>
          <dt>Source</dt>
          <dd>{o.source}</dd>
        </>
      ) : null}
    </dl>
  );
}
