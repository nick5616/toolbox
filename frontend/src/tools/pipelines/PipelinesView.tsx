/**
 * Pipelines page (SPEC.md §11.2–11.5): the pipelines tab (list + editor) and
 * the runs tab, plus the Run sheet. FROZEN layout (Wave 0): UI1 owns
 * PipelineList and PipelineEditor, UI2 owns RunsPanel and RunSheet.
 */
import { useEffect } from "react";
import { Button, SegmentedControl } from "@/components";
import { isRunActive, usePipelines, useRunList } from "@/state/pipelines";
import type { ToolViewProps } from "../index";
import { PipelineEditor } from "./PipelineEditor";
import { PipelineList } from "./PipelineList";
import { RunSheet } from "./RunSheet";
import { RunsPanel } from "./RunsPanel";
import { useNewPipeline } from "./useNewPipeline";
import styles from "./PipelinesView.module.css";

export default function PipelinesView(_props: ToolViewProps) {
  const tab = usePipelines((s) => s.tab);
  const setTab = usePipelines((s) => s.setTab);
  const runSheet = usePipelines((s) => s.runSheet);
  const runs = useRunList();
  const active = runs.filter(isRunActive).length;
  const newPipeline = useNewPipeline();

  useEffect(() => {
    void usePipelines.getState().ensureCatalog();
  }, []);

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <h1 className={styles.title}>Pipelines</h1>
        <SegmentedControl
          aria-label="Pipelines or runs"
          value={tab}
          onChange={(v) => setTab(v)}
          options={[
            { value: "pipelines", label: "Pipelines", tip: "Your saved recipes and the editor for the selected one" },
            { value: "runs", label: active > 0 ? `Runs (${active})` : "Runs", tip: active > 0 ? `${active} run${active === 1 ? " is" : "s are"} in progress; see every run and what it made` : "See every run of your pipelines and what it made" },
          ]}
        />
        <span className={styles.spacer} />
        <Button icon="plus" data-tip="Create a pipeline from a ready-made template or from scratch" onClick={newPipeline.open}>
          New
        </Button>
      </header>
      <div className={styles.body}>
        {tab === "pipelines" ? (
          <div className={styles.split}>
            <PipelineList onNew={newPipeline.open} />
            <PipelineEditor />
          </div>
        ) : (
          <RunsPanel />
        )}
      </div>
      {newPipeline.dialog}
      {runSheet && <RunSheet pipelineId={runSheet.pipelineId} />}
    </div>
  );
}
