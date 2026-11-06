import { useMemo, useState } from "react";
import { Button, Icon, IconButton, toast } from "@/components";
import { LanShareService, LibraryService, type LanActivity, type LanMessage } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { formatRelativeTime } from "@/lib/format";
import { JobRow } from "@/shell/JobRow";
import type { JobView } from "@/state/jobs";
import { ResultRow } from "@/tools/_kit";
import { MODULE_ID } from "./constants";
import { buildActivity, liveJobs, type ActivityEntry } from "./model";
import styles from "./LanShareView.module.css";

function report(e: unknown): void {
  toast({ tone: "danger", title: toAppError(e).message });
}

function ReceivedGroup({ job }: { job: JobView }) {
  const [open, setOpen] = useState(true);
  const when = job.finishedAt || job.createdAt;
  return (
    <li className={styles.entry} data-testid="received-group">
      <button type="button" className={styles.groupHead} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
        <span className={styles.groupTitle}>{job.title || "Received files"}</span>
        <span className={styles.when}>{formatRelativeTime(when)}</span>
      </button>
      {open && (
        <div className={styles.groupFiles}>
          {job.outputs.map((o) => (
            <ResultRow key={o.id} path={o.path} outputId={o.id} missing={o.missing} name={o.name} sizeBytes={o.sizeBytes} moduleId={MODULE_ID} />
          ))}
        </div>
      )}
    </li>
  );
}

function MessageCard({ m }: { m: LanMessage }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.text);
      toast({ tone: "success", title: "Copied" });
    } catch (e) {
      report(e);
    }
  };
  const save = async () => {
    try {
      const out = await LanShareService.SaveMessage(m.id);
      toast({
        tone: "success",
        title: "Saved as a file",
        description: out.name,
        action: { label: "Show", onClick: () => void LibraryService.RevealPath(out.path).catch(report) },
      });
    } catch (e) {
      report(e);
    }
  };
  return (
    <li className={styles.entry} data-testid="message">
      <div className={styles.messageHead}>
        <Icon name="message-square" size={14} />
        <span className={styles.groupTitle}>Message from {m.from.alias}</span>
        <span className={styles.when}>{formatRelativeTime(m.at)}</span>
        <span className={styles.rowActions}>
          <Button size="sm" variant="ghost" icon="copy" data-tip="Copy the text" onClick={() => void copy()}>
            Copy
          </Button>
          <Button size="sm" variant="ghost" icon="download" data-tip="Save the text as a file in your Received folder" onClick={() => void save()}>
            Save as file
          </Button>
        </span>
      </div>
      <p className={styles.messageText}>{m.text}</p>
    </li>
  );
}

export interface ActivityPanelProps {
  sends: readonly JobView[];
  receives: readonly JobView[];
  messages: readonly LanMessage[];
  notes: readonly LanActivity[];
  onClearMessages: () => void;
}

/** Transfers in progress, then what arrived (grouped per transfer), messages and one-line notes. */
export function ActivityPanel({ sends, receives, messages, notes, onClearMessages }: ActivityPanelProps) {
  const live = useMemo(() => [...liveJobs(receives), ...liveJobs(sends)], [receives, sends]);
  const entries = useMemo<ActivityEntry[]>(() => buildActivity(receives, messages, notes), [receives, messages, notes]);
  const empty = live.length === 0 && entries.length === 0;
  return (
    <section className={styles.panel} aria-label="Activity">
      <header className={styles.panelHead}>
        <h2 className={styles.panelTitle}>Activity</h2>
        {messages.length > 0 && <IconButton size="sm" icon="trash-2" label="Clear messages" tooltipSide="bottom" onClick={onClearMessages} />}
      </header>
      {empty ? (
        <p className={styles.empty}>Files you send and receive show up here.</p>
      ) : (
        <>
          {live.length > 0 && (
            <ul className={styles.jobList}>
              {live.map((j) => (
                <li key={j.id}>
                  <JobRow job={j} compact />
                </li>
              ))}
            </ul>
          )}
          <ul className={styles.entryList}>
            {entries.map((e) =>
              e.kind === "received" ? (
                <ReceivedGroup key={`r-${e.id}`} job={e.job} />
              ) : e.kind === "message" ? (
                <MessageCard key={`m-${e.id}`} m={e.message} />
              ) : (
                <li key={`n-${e.id}`} className={styles.note}>
                  <span>{e.note.text}</span>
                  <span className={styles.when}>{formatRelativeTime(e.at)}</span>
                </li>
              ),
            )}
          </ul>
        </>
      )}
    </section>
  );
}
