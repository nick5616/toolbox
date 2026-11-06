import { useMemo } from "react";
import { Button, EmptyState, Section, toast } from "@/components";
import { JobStatus, LibraryService, PdfAction } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { type JobView } from "@/state/jobs";
import { useToolJobs } from "@/tools/_kit/session";
import { FailedJobs } from "@/tools/_kit/FailedJobs";
import { ResultRow } from "@/tools/_kit/ResultRow";
import { revealLabel } from "@/lib/platform";
import shared from "@/tools/_kit/results.module.css";
import { basename, parsePdfResult } from "./options";
import styles from "./Results.module.css";

const MAX_GROUPS = 10;
const MAX_ROWS = 5;

export function summaryParts(r: NonNullable<ReturnType<typeof parsePdfResult>>): string[] {
  const parts: string[] = [];
  if (r.action === PdfAction.ActionCompress) {
    if (r.bytesAfter > 0 && r.bytesBefore > 0) {
      const pct = Math.round((1 - r.bytesAfter / r.bytesBefore) * 100);
      parts.push(`${formatBytes(r.bytesBefore)} → ${formatBytes(r.bytesAfter)} (−${pct}%)`);
    } else if ((r.outputs ?? []).length === 0) {
      parts.push("Already compact — couldn't make it meaningfully smaller");
    }
  }
  if (r.pages > 0) parts.push(`${r.pages} ${r.pages === 1 ? "page" : "pages"}`);
  if (r.bookmarksDropped) parts.push("Bookmarks aren't kept");
  return parts;
}

async function openFolder(path: string) {
  try {
    await LibraryService.RevealPath(path);
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
  }
}

function Group({ job }: { job: JobView }) {
  const r = parsePdfResult(job.resultJson);
  if (!r) return null;
  const outputs = r.outputs ?? [];
  const shown = outputs.slice(0, MAX_ROWS);
  const parts = summaryParts(r);
  return (
    <div className={styles.group}>
      <div className={styles.head}>
        <span className={styles.title} data-tip={job.title}>
          {job.title}
        </span>
        {r.folder && (
          <Button size="sm" variant="secondary" icon="folder-open" data-tip="Open the folder with all the files this job made" onClick={() => void openFolder(r.folder)}>
            {revealLabel}
          </Button>
        )}
      </div>
      {parts.length > 0 && <p className={styles.summary} data-tip="What the job did, e.g. size saved or pages kept">{parts.join(" · ")}</p>}
      <ul className={shared.list}>
        {shown.map((path) => {
          const out = job.outputs.find((o) => o.path === path);
          return (
            <li key={path}>
              <ResultRow path={path} outputId={out?.id} missing={out?.missing} name={basename(path)} sizeBytes={out?.sizeBytes} icon={r.folder ? "image" : "file-text"} />
            </li>
          );
        })}
        {outputs.length > shown.length && (
          <li className={shared.row}>
            <span className={shared.meta} data-tip="Open the folder to see the rest">
              + {outputs.length - shown.length} more in the folder
            </span>
          </li>
        )}
      </ul>
    </div>
  );
}

export function Results({ moduleId }: { moduleId: string }) {
  const jobs = useToolJobs(moduleId);
  const done = useMemo(
    () => jobs.filter((j) => j.status === JobStatus.JobDone && parsePdfResult(j.resultJson)).slice(0, MAX_GROUPS),
    [jobs],
  );
  return (
    <>
    <FailedJobs moduleId={moduleId} />
    <Section label="Results" tip="Finished PDF jobs and the files they made">
      {done.length === 0 ? (
        <EmptyState icon="file-text" title="No results yet." body="Finished PDFs appear here." />
      ) : (
        done.map((j) => <Group key={j.id} job={j} />)
      )}
    </Section>
    </>
  );
}
