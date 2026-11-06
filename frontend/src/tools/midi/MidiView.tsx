import { useMemo, useState } from "react";
import { Badge, Button, Field, SegmentedControl, Section, Slider, Stepper, Switch, ToolClickIn } from "@/components";
import { JobStatus, MidiRange, MidiService } from "@/lib/api";
import { useCompositionInputs } from "@/state/composition";
import { useToolJobs } from "@/tools/_kit/session";
import { EmptyLine, FileToolLayout, summarize, useFileInputs, useModuleOptions } from "@/tools/_kit";
import type { ToolViewProps } from "@/tools";
import { ResultRow } from "@/tools/_kit/ResultRow";
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
  const jobs = useToolJobs(moduleId);
  const done = useMemo(
    () => jobs.filter((j) => j.status === JobStatus.JobDone).slice(0, MAX_RESULTS),
    [jobs],
  );

  const paths = useMemo(() => inputs.files.map((f) => f.path), [inputs.files]);
  useCompositionInputs(moduleId, { stems: paths });
  const { clear, add } = inputs;
  // A chosen stem replaces the files to transcribe.
  const useStem = (stems: string[]) => {
    clear();
    void add(stems.slice(0, 1));
  };

  const n = inputs.files.length;
  const onRun = async () => {
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
      runLabel={n > 1 ? `Make MIDI (${n} files)` : "Make MIDI"}
      onRun={onRun}
      running={running}
      inputErrors={inputErrors}
      primary={
        <div className={styles.primaryRow}>
        <Field label="Range">
          <SegmentedControl
            aria-label="Range"
            value={opts.range}
            onChange={(range) => setOpts((o) => ({ ...o, range }))}
            options={[
              { value: MidiRange.RangeFull, label: "Full", tip: "Look for notes across the whole piano range" },
              { value: MidiRange.RangeBass, label: "Bass", tip: "Only keep low notes; use for bass lines" },
              { value: MidiRange.RangeMelody, label: "Melody", tip: "Only keep mid and high notes; use for lead lines and vocals" },
            ]}
          />
        </Field>
        <ToolClickIn
          host={moduleId}
          module="stems"
          title="Split into stems first"
          inputs={paths}
          useLabel="Use this stem"
          onUse={useStem}
          tip="Separate the song into vocals, bass, drums and the rest, then transcribe just one of them"
          disabledReason={paths.length === 0 ? "Add a song first" : undefined}
        />
        </div>
      }
      advancedSummary={summarize(`sensitivity ${pct(opts.sensitivity)}`, `floor ${pct(opts.noteFloor)}`, `min ${opts.minNoteMs} ms`, opts.melodiaTrick && "Melodia")}
      advanced={
        <div className={styles.stack}>
          <Field label="Sensitivity">
            {(c) => (
              <div data-tip="How readily notes are detected; higher finds more notes but adds false ones">
                <Slider id={c.id} value={opts.sensitivity} min={0.1} max={0.9} step={0.05} format={pct} onChange={(sensitivity) => setOpts((o) => ({ ...o, sensitivity }))} />
              </div>
            )}
          </Field>
          <Field label="Note floor">
            {(c) => (
              <div data-tip="Quietest note kept; raise it to drop faint notes and noise">
                <Slider id={c.id} value={opts.noteFloor} min={0.1} max={0.6} step={0.05} format={pct} onChange={(noteFloor) => setOpts((o) => ({ ...o, noteFloor }))} />
              </div>
            )}
          </Field>
          <Field label="Min note length">
            {(c) => (
              <div data-tip="Shortest note kept, in milliseconds; raise it to remove blips">
                <Stepper id={c.id} value={opts.minNoteMs} min={30} max={500} step={10} unit="ms" onChange={(minNoteMs) => setOpts((o) => ({ ...o, minNoteMs }))} />
              </div>
            )}
          </Field>
          <Field label="Melodia trick" hint="Cleaner melodies; turn off for chords">
            {(c) => (
              <Switch id={c.id} aria-label="Melodia trick" data-tip="Prefers one smooth melody line over scattered notes; turn off for chords and polyphonic music" checked={opts.melodiaTrick} onChange={(melodiaTrick) => setOpts((o) => ({ ...o, melodiaTrick }))} />
            )}
          </Field>
          <div className={styles.footer}>
            <Button size="sm" variant="ghost" data-tip="Put all options back to their original values" onClick={() => setOpts({ ...DEFAULT_MIDI_OPTIONS })}>
              Reset to defaults
            </Button>
          </div>
        </div>
      }
      results={
        <Section label="Results" tip="Finished MIDI files with note counts">
          {done.length === 0 ? (
            <EmptyLine title="No transcriptions yet." body="Transcribed MIDI files appear here." />
          ) : (
            <ul className={shared.list}>
              {done.map((j) => {
                const out = j.outputs[0];
                const r = parseMidiResult(j.resultJson);
                const range = r ? formatPitchRange(r.pitchRange) : "";
                return (
                  <li key={j.id}>
                    {out ? (
                      <ResultRow
                        path={out.path}
                        outputId={out.id}
                        missing={out.missing}
                        name={out.name}
                        icon="piano"
                        at={j.finishedAt || j.createdAt}
                        meta={
                          <>
                            {r && (
                              <Badge mono tip="Number of notes found in the track">
                                {r.notes} notes
                              </Badge>
                            )}
                            {range && <span data-tip="Lowest to highest note found"> {range}</span>}
                          </>
                        }
                      />
                    ) : null}
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
