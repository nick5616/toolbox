import { useMemo } from "react";
import { Button, EmptyState, Icon, Section, cx, toast } from "@/components";
import { JobStatus, LibraryService, PdfAction } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { useOrderedJobs, type JobView } from "@/state/jobs";
import { FileActions } from "@/tools/_kit/FileActions";
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
        <span className={styles.title} title={job.title}>
          {job.title}
        </span>
        {r.folder && (
          <Button size="sm" variant="secondary" icon="folder-open" onClick={() => void openFolder(r.folder)}>
            Open folder
          </Button>
        )}
      </div>
      {parts.length > 0 && <p className={styles.summary}>{parts.join(" · ")}</p>}
      <ul className={shared.list}>
        {shown.map((path) => {
          const out = job.outputs.find((o) => o.path === path);
          return (
            <li key={path} className={cx(shared.row, out?.missing && shared.missing)}>
              <Icon name={r.folder ? "image" : "file-text"} size={14} className={shared.icon} />
              <span className={shared.name} title={path}>
                {basename(path)}
              </span>
              {out && <span className={shared.meta}>{formatBytes(out.sizeBytes)}</span>}
              <span className={shared.actions}>
                <FileActions outputId={out?.id} path={path} disabled={out?.missing} />
              </span>
            </li>
          );
        })}
        {outputs.length > shown.length && (
          <li className={shared.row}>
            <span className={shared.meta}>
              + {outputs.length - shown.length} more in the folder
            </span>
          </li>
        )}
      </ul>
    </div>
  );
}

export function Results({ moduleId }: { moduleId: string }) {
  const jobs = useOrderedJobs(moduleId);
  const done = useMemo(
    () => jobs.filter((j) => j.status === JobStatus.JobDone && parsePdfResult(j.resultJson)).slice(0, MAX_GROUPS),
    [jobs],
  );
  return (
    <Section label="Results">
      {done.length === 0 ? (
        <EmptyState icon="file-text" title="No results yet." body="Finished PDFs appear here." />
      ) : (
        done.map((j) => <Group key={j.id} job={j} />)
      )}
    </Section>
  );
}
