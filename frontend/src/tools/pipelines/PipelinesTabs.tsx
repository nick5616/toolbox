import { SegmentedControl } from "@/components";
import { isRunActive, usePipelines, useRunList } from "@/state/pipelines";

/** The "Pipelines | Runs" switch (in the page header, or at the left of the editor header in Graph mode). */
export function PipelinesTabs() {
  const tab = usePipelines((s) => s.tab);
  const setTab = usePipelines((s) => s.setTab);
  const runs = useRunList();
  const active = runs.filter(isRunActive).length;
  return (
    <SegmentedControl
      size="sm"
      aria-label="Pipelines or runs"
      value={tab}
      onChange={(v) => setTab(v)}
      options={[
        { value: "pipelines", label: "Edit", tip: "Your saved recipes and the editor for the selected one" },
        {
          value: "runs",
          label: active > 0 ? `Runs (${active})` : "Runs",
          tip: active > 0 ? `${active} run${active === 1 ? " is" : "s are"} in progress; see every run and what it made` : "See every run of your pipelines and what it made",
        },
      ]}
    />
  );
}
