import { Button, Icon } from "@/components";
import { useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import { usePipelines, useWaitingForModule } from "@/state/pipelines";
import { useUI } from "@/state/ui";
import { adoptedJobs, continueManual, hasDoneAdopted, skipStep } from "@/tools/pipelines/NeedsYouCardActions";
import styles from "./PipelineBanner.module.css";

/** A thin bar above a tool whose step a pipeline run is waiting on (SPEC.md §11.7). */
export function PipelineBanner({ view }: { view: string }) {
  const waiting = useWaitingForModule(view);
  const byId = useJobs((s) => s.byId);
  const toolName = useModules((s) => s.byId[view]?.name ?? view);
  const first = waiting[0];
  if (!first) return null;

  const show = () => {
    useUI.getState().navigate("pipelines");
    usePipelines.getState().showRun(first.run.id);
  };
  const showRuns = () => {
    useUI.getState().navigate("pipelines");
    usePipelines.getState().setTab("runs");
  };

  const many = waiting.length > 1;
  const canContinue = hasDoneAdopted(adoptedJobs(first, byId));

  return (
    <div className={styles.bar} role="status" aria-label="Pipeline step waiting">
      <Icon name="workflow" size={14} className={styles.icon} />
      <span className={styles.text}>
        {many
          ? `${waiting.length} pipeline steps are waiting`
          : `${first.run.name} is waiting: ${first.step.note || first.step.label || toolName}`}
      </span>
      <span className={styles.actions}>
        {!many && (
          <>
            <Button size="sm" variant="secondary" disabled={!canContinue} data-tip={canContinue ? "You finished this step: let the pipeline carry on with the result" : "Finish the job in this tool first, then continue the pipeline"} onClick={() => continueManual(first, false)}>
              Continue
            </Button>
            <Button size="sm" variant="ghost" data-tip="Skip this step and carry on with the files as they are" onClick={() => skipStep(first)}>
              Skip step
            </Button>
          </>
        )}
        <Button size="sm" variant="ghost" data-tip={many ? "See all pipeline runs that are waiting" : "Open this pipeline run to see where it is"} onClick={many ? showRuns : show}>
          {many ? "Show" : "Show run"}
        </Button>
      </span>
    </div>
  );
}
