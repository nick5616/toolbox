import { useEffect, useRef, useState } from "react";
import { Badge, Button, Meter, toast } from "@/components";
import { ChatService, type ChatModelInfo } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { formatSize } from "@/views/setup/packSizes";
import { isActive, useJobs } from "@/state/jobs";
import styles from "./ModelCards.module.css";

function ModelCard({
  model,
  jobId,
  onStarted,
  onChanged,
}: {
  model: ChatModelInfo;
  jobId: string;
  onStarted: (modelId: string, jobId: string) => void;
  onChanged: () => void;
}) {
  const job = useJobs((s) => (jobId ? s.byId[jobId] : undefined));
  const [busy, setBusy] = useState(false);
  const active = jobId !== "" && (job ? isActive(job) : true);
  const wasActive = useRef(false);

  useEffect(() => {
    if (active) wasActive.current = true;
    else if (wasActive.current) {
      wasActive.current = false;
      onChanged();
    }
  }, [active, onChanged]);

  const download = async () => {
    setBusy(true);
    try {
      const j = await ChatService.DownloadModel(model.id);
      useJobs.getState().upsert(j);
      onStarted(model.id, j.id);
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    if (jobId) void useJobs.getState().cancel(jobId).catch((e: unknown) => toast({ title: toAppError(e).message, tone: "danger" }));
  };

  return (
    <li className={styles.card}>
      <div className={styles.head}>
        <span className={styles.name}>{model.label}</span>
        {model.isDefault && <Badge tone="accent">Default</Badge>}
        <span className={styles.size}>{formatSize(model.bytes)}</span>
      </div>
      <div className={styles.meta}>
        {model.license}
        {model.hint ? ` · ${model.hint}` : ""}
      </div>
      {!model.verified && <div className={styles.warn}>Not tested on this machine</div>}
      {active ? (
        <div className={styles.progress}>
          <Meter
            value={job && job.progress >= 0 ? job.progress : -1}
            label={`Downloading ${model.label}`}
            size="sm"
            className={styles.meter}
          />
          <span className={styles.msg}>{job?.message || "Starting…"}</span>
          <Button size="sm" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className={styles.actions}>
          <Button size="sm" variant="secondary" icon="download" loading={busy} onClick={() => void download()}>
            Download
          </Button>
        </div>
      )}
    </li>
  );
}

/** Cards for models that aren't installed yet, with download progress from job events. */
export function ModelCards({ models, onChanged }: { models: ChatModelInfo[]; onChanged: () => void }) {
  const [started, setStarted] = useState<Record<string, string>>({});
  const todo = models.filter((m) => !m.installed && !m.ollama);
  if (todo.length === 0) return null;
  return (
    <ul className={styles.list} aria-label="Models to download">
      {todo.map((m) => (
        <ModelCard
          key={m.id}
          model={m}
          jobId={started[m.id] ?? m.jobId}
          onStarted={(id, job) => setStarted((s) => ({ ...s, [id]: job }))}
          onChanged={onChanged}
        />
      ))}
    </ul>
  );
}
