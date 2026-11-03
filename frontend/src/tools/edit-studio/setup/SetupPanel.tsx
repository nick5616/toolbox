/**
 * Song analysis and range setup (SPEC §14.2). Shown in place of the lanes and
 * tracks while the edit has no loaded analysis: the analysis panel (reuse,
 * words, analyze job) and, once an analysis is loaded, the range picker.
 * `RangeEditor` and `RangePicker` are exported for the Song inspector.
 */
import { Banner, EmptyState, Spinner } from "@/components";
import { useEditStudio, useProject } from "../store";
import { AnalysisPanel } from "./AnalysisPanel";
import { RangeEditor } from "./RangeEditor";
import styles from "./Setup.module.css";

export { AnalysisPanel } from "./AnalysisPanel";
export { RangeEditor } from "./RangeEditor";
export { RangePicker, type RangePickerProps } from "./RangePicker";

export function SetupPanel() {
  const project = useProject();
  const state = useEditStudio((s) => s.analysisState);
  if (!project) return null;
  if (!project.song) {
    return (
      <div className={styles.root}>
        <EmptyState title="Choose a song" body="An edit is cut to a song. Start a new edit with one." />
      </div>
    );
  }
  const name = project.song.path.split(/[\\/]/).pop() ?? project.song.path;
  return (
    <div className={styles.root}>
      <h2 className={styles.title}>Set up your edit</h2>
      <div className={styles.song} title={project.song.path}>
        {name}
      </div>
      {state === "loading" && (
        <div className={styles.row} role="status">
          <Spinner size={14} />
          <span className={styles.label}>Loading the analysis…</span>
        </div>
      )}
      {(state === "missing" || state === "error") && (
        <Banner tone="warn" title={state === "missing" ? "The saved analysis isn't available any more" : "The saved analysis couldn't be read"}>
          Analyze the song again to continue. Your clips and markers are kept.
        </Banner>
      )}
      {state === "ready" ? <RangeEditor /> : state === "loading" ? null : <AnalysisPanel />}
    </div>
  );
}
