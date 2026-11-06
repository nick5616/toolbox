import { EmptyState, IconButton, Section } from "@/components";
import { copyText } from "@/lib/copy";
import { OutputKind } from "@/lib/api";
import { FailedJobs } from "@/tools/_kit/FailedJobs";
import { ResultRow } from "@/tools/_kit/ResultRow";
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

function OutputRow({ o }: { o: OutputView }) {
  return (
    <li>
      <ResultRow
        path={o.path}
        outputId={o.id}
        missing={o.missing}
        name={o.name}
        sizeBytes={o.sizeBytes}
        at={o.createdAt}
        icon={KIND_ICON[o.kind] ?? "file"}
        moduleId={MODULE_ID}
        extra={<IconButton size="sm" icon="copy" label="Copy path" data-tip="Copy the full path of this file" onClick={() => void copyText(o.path, { what: "path" })} />}
      />
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
        <Section label="Active" tip="Downloads that are queued or running">
          <div className={styles.jobs}>
            {active.map((j) => (
              <JobRow key={j.id} job={j} compact />
            ))}
          </div>
        </Section>
      )}
      <FailedJobs moduleId={MODULE_ID} />
      <Section label="Results" tip="The latest files this tool saved to your library">
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
