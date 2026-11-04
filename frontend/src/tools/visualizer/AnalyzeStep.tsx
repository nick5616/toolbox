/**
 * Visualizer step 2 (SPEC.md §8.2): runs the analysis job, shows the four
 * stages ("✓ from earlier" for cached ones), then the summary chips, the
 * warnings and the Song Map.
 *
 * Props:
 *  - `onDone?()`: the "Design the visuals" button (the store step is set to "design" too).
 * It starts the job on mount when the store has no analysis; "Re-analyze with
 * different options" clears the analysis and goes back to Source (the cache stays).
 */
import { useEffect, useRef, useState } from "react";
import { Badge, Banner, Button, Icon, Meter, Spinner } from "@/components";
import { TranscribeService } from "@/lib/api";
import { useVisualizer } from "./store";
import { SongMap } from "./SongMap";
import { useAnalyzeRun } from "./source/analyzeRun";
import { languageName, stageRows, type StageState } from "./source/logic";
import styles from "./AnalyzeStep.module.css";

export interface AnalyzeStepProps {
  onDone?: () => void;
}

const STATE_TEXT: Record<StageState, string> = {
  pending: "Waiting",
  active: "Working…",
  done: "Done",
  cached: "✓ from earlier",
  failed: "Failed",
  stopped: "Stopped",
};

function StageIcon({ state }: { state: StageState }) {
  if (state === "active") return <Spinner size={12} />;
  if (state === "done" || state === "cached") return <Icon name="check" size={14} />;
  if (state === "failed") return <Icon name="circle-alert" size={14} />;
  return <span className={styles.dot} />;
}

export default function AnalyzeStep({ onDone }: AnalyzeStepProps) {
  const options = useVisualizer((s) => s.analyze);
  const analysis = useVisualizer((s) => s.analysis);
  const ref = useVisualizer((s) => s.ref);
  const run = useAnalyzeRun();
  const [playheadMs, setPlayheadMs] = useState(0);
  const started = useRef(false);
  const [langName, setLangName] = useState("");

  useEffect(() => {
    if (started.current || useVisualizer.getState().analysis) return;
    started.current = true;
    void run.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const code = ref?.summary.language ?? "";
  useEffect(() => {
    setLangName(languageName(code));
    if (!code) return;
    let cancelled = false;
    TranscribeService.Languages()
      .then((l) => {
        const hit = (l ?? []).find((x) => x.code === code);
        if (hit && !cancelled) setLangName(hit.name);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [code]);

  const back = () => {
    const s = useVisualizer.getState();
    s.setAnalysis(null, null);
    s.setStep("source");
  };
  const forward = () => {
    useVisualizer.getState().setStep("design");
    onDone?.();
  };

  // ---- result ----
  if (analysis && ref) {
    const sum = ref.summary;
    const warnings = sum.warnings ?? [];
    return (
      <div className={styles.body}>
        <div className={styles.chips} aria-label="Summary" data-tip="What the analysis found in this song">
          {sum.tempo > 0 && <Badge mono tip="Detected tempo in beats per minute">{Math.round(sum.tempo)} BPM</Badge>}
          {sum.key && <Badge tip="Detected musical key">{sum.key}</Badge>}
          <Badge tip="Parts of the song found (verse, chorus…); visuals can change at each one">{(sum.sections ?? []).length} sections</Badge>
          {sum.hasStems && <Badge tip="Drums, bass, vocals and other were separated, so each can drive its own visuals">4 instruments</Badge>}
          {sum.hasWords && (
            <Badge tip="Lines of words found, with timing, and their language">
              {sum.lines} lines{langName ? ` · ${langName}` : ""}
            </Badge>
          )}
          {sum.hasMeaning && <Badge tone="accent" tip="Each line was read for feeling and imagery, so visuals can match the words">Mood read</Badge>}
        </div>
        {warnings.length > 0 && (
          <Banner tone="warn" title={warnings.length === 1 ? "Heads up" : "A few things to know"}>
            <ul className={styles.warnings}>
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Banner>
        )}
        <SongMap analysis={analysis} playheadMs={playheadMs} onSeek={setPlayheadMs} />
        <div className={styles.footer}>
          <Button variant="ghost" icon="rotate-ccw" onClick={back} data-tip="Go back to the options and analyse again; finished stages are reused from the cache">
            Re-analyze with different options
          </Button>
          <Button icon="sparkles" onClick={forward} data-tip="Open the designer to choose how the visuals look and react">
            Design the visuals
          </Button>
        </div>
      </div>
    );
  }

  // ---- running / failed ----
  const phase = run.phase === "idle" ? "queued" : run.phase;
  const rows = stageRows(options, run.tracker, phase);
  const failed = run.phase === "failed";
  const active = run.phase === "queued" || run.phase === "running";
  return (
    <div className={styles.body}>
      <div className={styles.box} role="status" aria-live="polite">
        <div className={styles.head}>
          <span>{run.loading ? "Loading the analysis…" : run.phase === "queued" ? "Waiting to start…" : "Analysing…"}</span>
          {active && (
            <Button size="sm" variant="ghost" onClick={run.cancel} data-tip="Stop the analysis; finished stages are kept for next time">
              Cancel
            </Button>
          )}
        </div>
        <Meter
          value={run.job ? run.job.progress : -1}
          status={failed ? "failed" : run.phase === "cancelled" ? "cancelled" : run.phase === "queued" ? "queued" : "running"}
          label="Analysis progress"
        />
        <ol className={styles.stages} aria-label="Stages" data-tip="The steps of the analysis; earlier results are reused">
          {rows.map((r) => (
            <li key={r.id} className={styles.stage} data-state={r.state}>
              <StageIcon state={r.state} />
              <span className={styles.stageLabel}>{r.label}</span>
              <span className={styles.stageState}>{STATE_TEXT[r.state]}</span>
            </li>
          ))}
        </ol>
        {run.job?.message && active && <div className={styles.msg}>{run.job.message}</div>}
      </div>
      {(run.error || failed) && (
        <Banner tone="danger" title={run.error?.message || run.job?.error || "The analysis didn't work"}>
          {run.error?.hint || run.job?.errorHint}
        </Banner>
      )}
      {run.phase === "cancelled" && <Banner tone="info" title="Cancelled" />}
      {!active && !run.loading && (
        <div className={styles.footer}>
          <Button variant="ghost" icon="arrow-left" onClick={back} data-tip="Return to the source options">
            Back to options
          </Button>
          <Button
            data-tip="Run the analysis again with the same options"
            onClick={() => {
              started.current = true;
              void run.start();
            }}
          >
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}
