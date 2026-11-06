import type { ToolViewProps } from "../index";
import "./ui/tokens.css";
import styles from "./PaintView.module.css";

/**
 * Paint+ (Phase 19). STUB (Wave 0): P5 replaces this with the gallery, the
 * editor and Studio mode in Paint+'s own design language (SPEC §1.5, §1.6).
 */
export default function PaintView(_props: ToolViewProps) {
  return (
    <section className={styles.root} data-design="paint" aria-label="Paint+">
      <p className={styles.note}>Paint+ is being built.</p>
    </section>
  );
}
