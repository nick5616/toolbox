import { useEffect, useState } from "react";
import { Button, Icon, cx } from "@/components";
import { FilesService, JobStatus, OutputKind, WaitKind, type RunFile } from "@/lib/api";
import { revealLabel } from "@/lib/platform";
import { useJobs } from "@/state/jobs";
import { useModules } from "@/state/modules";
import type { WaitingCell } from "@/state/pipelines";
import { useUI } from "@/state/ui";
import { baseName } from "./RunGridModel";
import { adoptedJobs, continueCheck, continueManual, hasDoneAdopted, skipStep, stopItem } from "./NeedsYouCardActions";
import { KIND_ICON, openRunFile, revealRunFile } from "./RunResultsFileRow";
import styles from "./NeedsYouCard.module.css";

function Thumb({ file }: { file: RunFile }) {
  const [url, setUrl] = useState("");
  const image = file.kind === OutputKind.KindImage;
  useEffect(() => {
    if (!image) return;
    let live = true;
    FilesService.ImageThumb(file.path, 96)
      .then((u) => live && setUrl(u))
      .catch(() => live && setUrl(""));
    return () => {
      live = false;
    };
  }, [image, file.path]);
  if (url) return <img className={styles.thumb} src={url} alt="" />;
  return (
    <span className={styles.tile} aria-hidden="true">
      <Icon name={KIND_ICON[file.kind] ?? "file"} size={20} />
    </span>
  );
}

function CheckBody({ w }: { w: WaitingCell }) {
  const files = w.cell.inputs;
  const [off, setOff] = useState<Set<string>>(new Set());
  const kept = files.filter((f) => !off.has(f.path));
  const toggle = (p: string) =>
    setOff((cur) => {
      const next = new Set(cur);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  return (
    <>
      <ul className={styles.checks}>
        {files.map((f) => (
          <li key={f.path} className={cx(styles.check, off.has(f.path) && styles.off)}>
            <input type="checkbox" aria-label={f.name || baseName(f.path)} checked={!off.has(f.path)} onChange={() => toggle(f.path)} />
            <Thumb file={f} />
            <span className={styles.fileName} title={f.path}>
              {f.name || baseName(f.path)}
            </span>
            <Button size="sm" variant="ghost" disabled={!f.outputId} onClick={() => openRunFile(f)} aria-label={`Open ${f.name}`}>
              Open
            </Button>
            <Button size="sm" variant="ghost" onClick={() => revealRunFile(f)} aria-label={`${revealLabel}: ${f.name}`}>
              Reveal
            </Button>
          </li>
        ))}
      </ul>
      <div className={styles.actions}>
        <Button variant="primary" onClick={() => continueCheck(w, kept.map((f) => f.path))}>
          {`Continue with ${kept.length} ${kept.length === 1 ? "file" : "files"}`}
        </Button>
        <Button variant="ghost" onClick={() => stopItem(w)}>
          Stop this file
        </Button>
      </div>
    </>
  );
}

function ManualBody({ w }: { w: WaitingCell }) {
  const byId = useJobs((s) => s.byId);
  const tool = useModules((s) => s.byId[w.step.type]?.name ?? w.step.type);
  const jobs = adoptedJobs(w, byId);
  const canContinue = hasDoneAdopted(jobs);
  const inputs = w.cell.inputs;
  return (
    <>
      <ul className={styles.plain}>
        {inputs.map((f) => (
          <li key={f.path} className={styles.fileName} title={f.path}>
            {f.name || baseName(f.path)}
          </li>
        ))}
      </ul>
      {jobs.length > 0 && (
        <ul className={styles.plain} aria-label="Jobs so far">
          {jobs.map((j) => (
            <li key={j.id} className={styles.made}>
              {j.status === JobStatus.JobDone
                ? `Made in ${tool}: ${j.outputs.map((o) => o.name).join(", ") || j.title}`
                : `${j.title || j.id}: ${j.status}`}
            </li>
          ))}
        </ul>
      )}
      <div className={styles.actions}>
        <Button
          icon="external-link"
          onClick={() => useUI.getState().handOff({ moduleId: w.step.type, inputs: inputs.map((f) => f.path) })}
        >
          {`Open ${tool}`}
        </Button>
        <Button variant="primary" disabled={!canContinue} onClick={() => continueManual(w, false)}>
          Continue
        </Button>
        {!canContinue && (
          <Button variant="ghost" onClick={() => continueManual(w, true)}>
            Continue with the original file
          </Button>
        )}
        <Button variant="ghost" onClick={() => skipStep(w)}>
          Skip step
        </Button>
        <Button variant="ghost" onClick={() => stopItem(w)}>
          Stop this file
        </Button>
      </div>
    </>
  );
}

/** One waiting manual or check cell (SPEC.md §11.7). */
export function NeedsYouCard({ w }: { w: WaitingCell }) {
  const tool = useModules((s) => s.byId[w.step.type]?.name ?? w.step.type);
  const label = w.step.label || (w.kind === WaitKind.WaitCheck ? "Check files" : tool);
  return (
    <section className={styles.card} aria-label={`${w.run.name} · ${w.item.label}`}>
      <header className={styles.head}>
        <Icon name={w.kind === WaitKind.WaitCheck ? "eye" : "hand"} size={16} className={styles.icon} />
        <div className={styles.titles}>
          <div className={styles.title}>
            {w.run.name} · {w.item.label}
          </div>
          <div className={styles.sub}>{w.step.note ? `${label} · ${w.step.note}` : label}</div>
        </div>
      </header>
      {w.kind === WaitKind.WaitCheck ? <CheckBody w={w} /> : <ManualBody w={w} />}
    </section>
  );
}
