/**
 * The export's progress and result banner (§14.10): a card pinned to the
 * bottom-right of the window that follows `store.jobs.render`. Running →
 * Meter and Cancel; failed → the error; done → Open, Reveal, Add to post….
 * Mounted by ExportDialog, so it stays visible after the dialog closes.
 */
import { Banner, Button, IconButton, Meter, Tooltip, toast } from "@/components";
import { JobStatus, JobsService, LibraryService, type EditResult } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { revealLabel } from "@/lib/platform";
import { useJob, type JobView } from "@/state/jobs";
import { toolAction } from "@/lib/toolActions";
import { useEditStudio } from "@/editor/store";
import { baseName } from "./checks";
import styles from "./ExportBanner.module.css";

function parseResult(json: string): Partial<EditResult> | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Partial<EditResult>;
  } catch {
    return null;
  }
}

async function run(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
  }
}

function Done({ job, onDismiss }: { job: JobView; onDismiss(): void }) {
  const result = parseResult(job.resultJson);
  const path = result?.outputs?.[0] ?? job.outputs[0]?.path ?? "";
  const out = job.outputs.find((o) => o.path === path) ?? job.outputs[0];
  const speed = result?.speed ?? 0;
  return (
    <Banner
      tone="info"
      title={path ? `Exported ${baseName(path)}` : "Export finished"}
      action={
        <div className={styles.actions}>
          <Button size="sm" data-tip="Open the exported video in your default player" disabled={!out || out.missing} onClick={() => out && void run(LibraryService.Open(out.id))}>
            Open
          </Button>
          <Button size="sm" data-tip="Show the exported file in your file manager" disabled={!path} onClick={() => void run(out ? LibraryService.Reveal(out.id) : LibraryService.RevealPath(path))}>
            {revealLabel}
          </Button>
          <Button size="sm" data-tip="Use this video as a slide in an Instagram post" disabled={!path || !!out?.missing} onClick={() => void toolAction("addToPost")(path)}>
            Add to post…
          </Button>
          <IconButton size="sm" icon="x" label="Dismiss" data-tip="Hide this message; the exported file stays in your library" onClick={onDismiss} />
        </div>
      }
    >
      {speed > 0 ? `Rendered ×${speed.toFixed(1)} real time` : undefined}
    </Banner>
  );
}

export function ExportBanner() {
  const jobId = useEditStudio((s) => s.jobs.render);
  const job = useJob(jobId ?? "");
  if (!jobId || !job) return null;
  const dismiss = () => useEditStudio.getState().setJob("render", undefined);
  const active = job.status === JobStatus.JobQueued || job.status === JobStatus.JobRunning;
  let body;
  if (active) {
    const queued = job.status === JobStatus.JobQueued;
    body = (
      <div className={styles.run} role="status" aria-live="polite">
        <div className={styles.head}>
          <span>{queued ? "Waiting to export…" : "Exporting"}</span>
          <Button size="sm" variant="ghost" data-tip="Stop the export; nothing is kept" onClick={() => void run(JobsService.Cancel(jobId))}>
            Cancel
          </Button>
        </div>
        <Tooltip label="How much of the video has been rendered"><Meter value={queued ? 0 : job.progress} status={queued ? "queued" : "running"} label="Export progress" /></Tooltip>
        <div className={styles.msg}>{job.message}</div>
      </div>
    );
  } else if (job.status === JobStatus.JobFailed) {
    body = (
      <Banner tone="danger" title={job.error || "The export didn't work"} action={<IconButton size="sm" icon="x" label="Dismiss" data-tip="Hide this message" onClick={dismiss} />}>
        {job.errorHint}
      </Banner>
    );
  } else if (job.status === JobStatus.JobCancelled) {
    body = <Banner tone="info" title="Export cancelled" action={<IconButton size="sm" icon="x" label="Dismiss" data-tip="Hide this message" onClick={dismiss} />} />;
  } else {
    body = <Done job={job} onDismiss={dismiss} />;
  }
  return (
    <div className={styles.root} aria-label="Export">
      {body}
    </div>
  );
}
