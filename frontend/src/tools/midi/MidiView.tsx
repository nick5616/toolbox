import { useMemo, useState } from "react";
import { Badge, Button, EmptyState, Field, Icon, SegmentedControl, Section, Slider, Stepper, Switch, cx } from "@/components";
import { JobStatus, MidiRange, MidiService } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
import { useOrderedJobs } from "@/state/jobs";
import { FileToolLayout, runLabel, useFileInputs, useModuleOptions } from "@/tools/_kit";
import type { ToolViewProps } from "@/tools";
import { FileActions } from "@/tools/_kit/FileActions";
import { submitJobs } from "@/tools/_kit/enqueue";
import shared from "@/tools/_kit/results.module.css";
import { DEFAULT_MIDI_OPTIONS, formatPitchRange, parseMidiResult, sanitizeMidiOptions } from "./options";
import styles from "./MidiView.module.css";

const MAX_RESULTS = 20;
const pct = (v: number) => `${Math.round(v * 100)}%`;

export default function MidiView({ moduleId }: ToolViewProps) {
  const inputs = useFileInputs(moduleId);
  const [opts, setOpts] = useModuleOptions(moduleId, DEFAULT_MIDI_OPTIONS, sanitizeMidiOptions);
  const [running, setRunning] = useState(false);
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const jobs = useOrderedJobs(moduleId);
  const done = useMemo(
    () => jobs.filter((j) => j.status === JobStatus.JobDone).slice(0, MAX_RESULTS),
    [jobs],
  );

  const n = inputs.files.length;
  const onRun = async () => {
    const paths = inputs.files.map((f) => f.path);
    setRunning(true);
    const res = await submitJobs(() => MidiService.Enqueue(paths, opts), paths, ["transcription", "transcriptions"]);
    setRunning(false);
    setInputErrors(res.inputErrors);
    if (res.ok) inputs.clear();
  };

  return (
    <FileToolLayout
      moduleId={moduleId}
      inputs={inputs}
      runLabel={runLabel("Transcribe", n, "file", "files")}
      onRun={onRun}
      running={running}
      inputErrors={inputErrors}
      options={
        <Section label="Options">
          <div className={styles.grid}>
            <Field label="Sensitivity">
              {(c) => (
                <Slider id={c.id} aria-label="Sensitivity" value={opts.sensitivity} min={0.1} max={0.9} step={0.05} format={pct} onChange={(sensitivity) => setOpts((o) => ({ ...o, sensitivity }))} />
              )}
            </Field>
            <Field label="Note floor">
              {(c) => (
                <Slider id={c.id} aria-label="Note floor" value={opts.noteFloor} min={0.1} max={0.6} step={0.05} format={pct} onChange={(noteFloor) => setOpts((o) => ({ ...o, noteFloor }))} />
              )}
            </Field>
            <Field label="Min note length">
              {(c) => (
                <Stepper id={c.id} aria-label="Min note length" value={opts.minNoteMs} min={30} max={500} step={10} unit="ms" onChange={(minNoteMs) => setOpts((o) => ({ ...o, minNoteMs }))} />
              )}
            </Field>
            <Field label="Range">
              <SegmentedControl
                aria-label="Range"
                value={opts.range}
                onChange={(range) => setOpts((o) => ({ ...o, range }))}
                options={[
                  { value: MidiRange.RangeFull, label: "Full" },
                  { value: MidiRange.RangeBass, label: "Bass" },
                  { value: MidiRange.RangeMelody, label: "Melody" },
                ]}
              />
            </Field>
            <Field label="Melodia trick" hint="Cleaner melodies; turn off for chords">
              {(c) => (
                <Switch id={c.id} aria-label="Melodia trick" checked={opts.melodiaTrick} onChange={(melodiaTrick) => setOpts((o) => ({ ...o, melodiaTrick }))} />
              )}
            </Field>
          </div>
          <div className={styles.footer}>
            <Button size="sm" variant="ghost" onClick={() => setOpts({ ...DEFAULT_MIDI_OPTIONS })}>
              Reset to defaults
            </Button>
          </div>
        </Section>
      }
      results={
        <Section label="Results">
          {done.length === 0 ? (
            <EmptyState icon="piano" title="No transcriptions yet." body="Transcribed MIDI files appear here." />
          ) : (
            <ul className={shared.list}>
              {done.map((j) => {
                const out = j.outputs[0];
                const r = parseMidiResult(j.resultJson);
                const range = r ? formatPitchRange(r.pitchRange) : "";
                return (
                  <li key={j.id} className={cx(shared.row, out?.missing && shared.missing)}>
                    <Icon name="piano" size={14} className={shared.icon} />
                    <span className={shared.name} title={out?.path ?? j.title}>
                      {out?.name ?? j.title}
                    </span>
                    {r && <Badge mono>{r.notes} notes</Badge>}
                    {range && <span className={shared.meta}>{range}</span>}
                    <span className={shared.meta}>{formatRelativeTime(j.finishedAt || j.createdAt)}</span>
                    <span className={shared.actions}>
                      {out && <FileActions outputId={out.id} path={out.path} disabled={out.missing} />}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      }
    />
  );
}
