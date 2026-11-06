import type { BandRect } from "./editorModel";
import styles from "./FocusBands.module.css";

/** The faint bands behind a Focus start and its matching wait, labelled with the session length (editor and run graph). */
export function FocusBands({ bands }: { bands: readonly BandRect[] }) {
  if (bands.length === 0) return null;
  return (
    <>
      {bands.map((b) => (
        <div
          key={`${b.startId}:${b.waitId}`}
          className={styles.band}
          style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
          data-focus-band={b.startId}
          data-tip={b.label ? `A focus session: ${b.label}. Steps inside this band run during it.` : "A focus session: steps inside this band run during it."}
          aria-hidden="true"
        >
          <span className={styles.label}>{b.label ? `Focus · ${b.label}` : "Focus"}</span>
        </div>
      ))}
    </>
  );
}
