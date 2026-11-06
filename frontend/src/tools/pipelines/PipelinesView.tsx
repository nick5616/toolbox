/**
 * Pipelines page (SPEC.md §11.2–11.5): the pipelines tab (list + editor) and
 * the runs tab, plus the Run sheet. FROZEN layout (Wave 0): UI1 owns
 * PipelineList and PipelineEditor, UI2 owns RunsPanel and RunSheet.
 */
import { useEffect } from "react";
import { Button } from "@/components";
import { usePipelines } from "@/state/pipelines";
import type { ToolViewProps } from "../index";
import { PipelineEditor } from "./PipelineEditor";
import { useEditorMode } from "./editorMode";
import { PipelinesTabs } from "./PipelinesTabs";
import { PipelineList, usePipelineListEffects } from "./PipelineList";
import { usePopOutState } from "./popoutState";
import { RunSheet } from "./RunSheet";
import { RunsPanel } from "./RunsPanel";
import { useNewPipeline } from "./useNewPipeline";
import styles from "./PipelinesView.module.css";

export default function PipelinesView(_props: ToolViewProps) {
  const tab = usePipelines((s) => s.tab);
  const runSheet = usePipelines((s) => s.runSheet);
  const newPipeline = useNewPipeline();
  const [mode] = useEditorMode();
  const hasPipelines = usePipelines((s) => s.entries.length > 0);
  usePipelineListEffects();
  usePopOutState();
  // Graph mode gives the canvas the full width: the list becomes a switcher in the editor header.
  const fullWidth = mode === "graph" && hasPipelines;

  useEffect(() => {
    void usePipelines.getState().ensureCatalog();
  }, []);

  return (
    <div className={styles.root}>
      {/* One row in Graph mode: the editor header carries the tabs. */}
      {!(tab === "pipelines" && fullWidth) && (
        <header className={styles.header}>
          <PipelinesTabs />
          <span className={styles.spacer} />
          <Button icon="plus" data-tip="Create a pipeline from a ready-made template or from scratch" onClick={newPipeline.open}>
            New
          </Button>
        </header>
      )}
      <div className={styles.body}>
        {tab === "pipelines" ? (
          fullWidth ? (
            <div className={styles.full}>
              <PipelineEditor onNew={newPipeline.open} />
            </div>
          ) : (
            <div className={styles.split}>
              <PipelineList onNew={newPipeline.open} />
              <PipelineEditor />
            </div>
          )
        ) : (
          <RunsPanel />
        )}
      </div>
      {newPipeline.dialog}
      {runSheet && <RunSheet pipelineId={runSheet.pipelineId} />}
    </div>
  );
}
