/**
 * The stage while there is no analysis (SPEC Phase 11 §5.5; the Analyze step):
 * it starts the analysis job by itself as soon as the file has been read and
 * the options can run, shows the four stages ("✓ from earlier" for cached
 * ones), and offers Cancel / Try again / the Analysis options. When the job is
 * done the store gets the analysis and the workspace swaps this for the designer.
 */
import { useEffect, useRef, useState } from "react";
import { Banner, Button, Icon, Meter, Spinner, useClickIn } from "@/components";
import { useMediaSource } from "@/components/media";
import { DepsGate } from "@/tools/_kit";
import { panelDrawerId } from "@/workspace";
import { ModelRows, useAnalysisBlock } from "./AnalysisPanel";
import { useAnalyzeRun } from "./source/analyzeRun";
import { stageRows, type StageState } from "./source/logic";
import { useVisualizer, VISUALIZER_ID } from "./store";
import styles from "./AnalysisStage.module.css";

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

export default function AnalysisStage() {
  const input = useVisualizer((s) => s.input);
  const options = useVisualizer((s) => s.analyze);
  const restored = useVisualizer((s) => s.restored);
  const run = useAnalyzeRun();
  const block = useAnalysisBlock();
  const media = useMediaSource(input);
  const { open } = useClickIn();
  const started = useRef(false);
  const [began, setBegan] = useState(false);

  // The file is read first (the probe decides audio or video), then the job starts by itself.
  const ready = !!input && !block.reason && media.status !== "loading";
  useEffect(() => {
    // A source that came back from the last session waits for the Analyze button.
    if (started.current || !ready || useVisualizer.getState().analysis || useVisualizer.getState().restored) return;
    started.current = true;
    setBegan(true);
    void run.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const openOptions = () => open(panelDrawerId("analysis"));

  const analyseNow = () => {
    useVisualizer.setState({ restored: false });
    started.current = true;
    setBegan(true);
    void run.start();
  };

  if (!began && !run.job && !run.error) {
    if (restored && !block.reason) {
      return (
        <div className={styles.body} data-testid="analysis-stage">
          <div className={styles.box} role="status">
            <div className={styles.head}>
              <span>Ready to analyse</span>
            </div>
            <div className={styles.msg}>This is the song from last time. Nothing has been analysed yet.</div>
            <div className={styles.footer}>
              <Button variant="ghost" icon="audio-lines" onClick={openOptions} data-tip="Choose where the words come from and what to analyse">
                Analysis options
              </Button>
              <Button variant="primary" disabled={!ready} onClick={analyseNow} data-tip="Analyse the song so the design can react to it">
                Analyze
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className={styles.body} data-testid="analysis-stage">
        {block.reason ? (
          <div className={styles.box} role="status">
            <div className={styles.head}>
              <span>Ready to analyse</span>
            </div>
            <div className={styles.msg}>{block.reason}</div>
            <DepsGate moduleId={VISUALIZER_ID} />
            <ModelRows ids={block.needed} moodMissing={block.moodMissing} />
            <div className={styles.footer}>
              <Button variant="ghost" icon="audio-lines" onClick={openOptions} data-tip="Choose where the words come from and what to analyse">
                Analysis options
              </Button>
            </div>
          </div>
        ) : (
          <div className={styles.box} role="status">
            <div className={styles.head}>
              <span>
                <Spinner size={12} /> Reading the file…
              </span>
            </div>
          </div>
        )}
      </div>
    );
  }

  const phase = run.phase === "idle" ? "queued" : run.phase;
  const rows = stageRows(options, run.tracker, phase);
  const failed = run.phase === "failed";
  const active = run.phase === "queued" || run.phase === "running";
  return (
    <div className={styles.body} data-testid="analysis-stage">
      <div className={styles.box} role="status" aria-live="polite">
        <div className={styles.head}>
          <span>{run.loading ? "Loading the analysis…" : run.phase === "queued" ? "Waiting to start…" : "Analysing…"}</span>
          {active && (
            <Button size="sm" variant="ghost" onClick={run.cancel} data-tip="Stop the analysis; finished stages are kept for next time">
              Cancel
            </Button>
          )}
        </div>
        <Meter value={run.job ? run.job.progress : -1} status={failed ? "failed" : run.phase === "cancelled" ? "cancelled" : run.phase === "queued" ? "queued" : "running"} label="Analysis progress" />
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
          <Button variant="ghost" icon="audio-lines" onClick={openOptions} data-tip="Change what is analysed, then try again">
            Analysis options
          </Button>
          <Button
            data-tip="Run the analysis again with the current options"
            onClick={() => {
              started.current = true;
              setBegan(true);
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
