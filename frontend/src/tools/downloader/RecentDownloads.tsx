import { Badge, EmptyState, Icon, IconButton, Section, cx, toast } from "@/components";
import { LibraryService, OutputKind } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { revealLabel } from "@/lib/platform";
import { MODULE_ID } from "./options";
import { isActive, useOrderedJobs } from "@/state/jobs";
import { useRecentOutputs, type OutputView } from "@/state/library";
import { JobRow } from "@/shell/JobRow";
import { useMemo } from "react";
import styles from "./RecentDownloads.module.css";

const KIND_ICON: Record<string, string> = {
  [OutputKind.KindAudio]: "music",
  [OutputKind.KindVideo]: "film",
  [OutputKind.KindImage]: "image",
  [OutputKind.KindDocument]: "file-text",
};

async function run(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
  }
}

async function copyPath(path: string) {
  try {
    await navigator.clipboard.writeText(path);
    toast({ title: "Path copied", tone: "success", duration: 1500 });
  } catch {
    toast({ title: "Couldn't copy to the clipboard", tone: "danger" });
  }
}

function OutputRow({ o }: { o: OutputView }) {
  return (
    <li className={cx(styles.row, o.missing && styles.missing)}>
      <Icon name={KIND_ICON[o.kind] ?? "file"} size={14} className={styles.kind} />
      <span className={styles.name} title={o.path}>
        {o.name}
      </span>
      {o.missing && <Badge tone="warn">MISSING</Badge>}
      <span className={styles.meta}>{formatBytes(o.sizeBytes)}</span>
      <span className={styles.meta}>{formatRelativeTime(o.createdAt)}</span>
      <span className={styles.actions}>
        <IconButton size="sm" icon="folder-open" label={revealLabel} disabled={o.missing} onClick={() => void run(LibraryService.Reveal(o.id))} />
        <IconButton size="sm" icon="external-link" label="Open" disabled={o.missing} onClick={() => void run(LibraryService.Open(o.id))} />
        <IconButton size="sm" icon="copy" label="Copy path" onClick={() => void copyPath(o.path)} />
      </span>
    </li>
  );
}

export function RecentDownloads() {
  const jobs = useOrderedJobs(MODULE_ID);
  const active = useMemo(() => jobs.filter(isActive), [jobs]);
  const recent = useRecentOutputs(MODULE_ID, 20);
  return (
    <>
      {active.length > 0 && (
        <Section label="Active">
          <div className={styles.jobs}>
            {active.map((j) => (
              <JobRow key={j.id} job={j} compact />
            ))}
          </div>
        </Section>
      )}
      <Section label="Recent downloads">
        {recent.length === 0 ? (
          <EmptyState icon="download" title="Nothing downloaded yet." body="Paste a link above, or anywhere in the app." />
        ) : (
          <ul className={styles.list}>
            {recent.map((o) => (
              <OutputRow key={o.id} o={o} />
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
