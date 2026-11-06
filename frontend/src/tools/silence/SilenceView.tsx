import { useEffect, useMemo, useState } from "react";
import { Section, Select, Stepper, Switch } from "@/components";
import { Timeline } from "@/components/media";
import { JobStatus, MediaService, SilenceService, type SilenceAnalysis } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { FileToolLayout, ResultRow, ResultTable, runLabel, summarize, useFileInputs, useModuleOptions } from "@/tools/_kit";
import type { ResultColumn } from "@/tools/_kit";
import { FileActions } from "@/tools/_kit/FileActions";
import { submitJobs } from "@/tools/_kit/enqueue";
import { basename } from "@/tools/_kit/image/common";
import { useToolJobs } from "@/tools/_kit/session";
import type { ToolViewProps } from "../index";
import {
  DEFAULT_SILENCE_OPTIONS,
  SILENCE_LIMITS,
  analysisKey,
  analysisSummary,
  formatSpan,
  parseCut,
  removedRanges,
  sanitizeSilenceOptions,
  type CutOutcome,
} from "./options";
import styles from "./SilenceView.module.css";

const WAVE_BUCKETS = 800;
const ANALYSE_DELAY_MS = 450;
const MAX_ROWS = 50;

type Analysed = { key: string; analysis: SilenceAnalysis } | { key: string; error: string };

export default function SilenceView({ moduleId }: ToolViewProps) {
  const inputs = useFileInputs(moduleId);
  const [opts, setOpts, loaded] = useModuleOptions(moduleId, DEFAULT_SILENCE_OPTIONS, sanitizeSilenceOptions);
  const [running, setRunning] = useState(false);
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState("");
  const jobs = useToolJobs(moduleId);

  const paths = useMemo(() => inputs.files.map((f) => f.path), [inputs.files]);
  const path = paths.includes(selected) ? selected : (paths[0] ?? "");

  // The waveform of the file being looked at.
  const [peaks, setPeaks] = useState<number[]>([]);
  useEffect(() => {
    setPeaks([]);
    if (!path) return;
    let cancelled = false;
    MediaService.Waveform(path, WAVE_BUCKETS)
      .then((p) => !cancelled && setPeaks(p ?? []))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [path]);

  // A quick listen, repeated (debounced) whenever what counts as silence changes.
  const key = path ? analysisKey(path, opts) : "";
  const [result, setResult] = useState<Analysed | null>(null);
  useEffect(() => {
    if (!path || !loaded) return;
    let cancelled = false;
    const t = setTimeout(() => {
      SilenceService.Analyse(path, opts)
        .then((analysis) => !cancelled && setResult({ key, analysis }))
        .catch((e: unknown) => !cancelled && setResult({ key, error: toAppError(e).message }));
    }, ANALYSE_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // `key` covers every option Analyse depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, loaded]);

  const current = result && result.key === key ? result : null;
  const analysis = current && "analysis" in current ? current.analysis : null;
  const problem = current && "error" in current ? current.error : "";
  const ranges = useMemo(() => removedRanges(analysis?.removed), [analysis]);

  const onRun = async () => {
    setRunning(true);
    const res = await submitJobs(() => SilenceService.Enqueue(paths, opts), paths, ["file", "files"]);
    setRunning(false);
    setInputErrors(res.inputErrors);
    if (res.ok) inputs.clear();
  };

  const rows = useMemo(() => {
    const out: Array<CutOutcome & { id: string; outputId?: string; missing?: boolean; listId?: string; listMissing?: boolean }> = [];
    for (const j of jobs) {
      if (j.status !== JobStatus.JobDone) continue;
      const c = parseCut(j.resultJson);
      if (!c) continue;
      const o = j.outputs.find((x) => x.path === c.output);
      const l = c.cutList ? j.outputs.find((x) => x.path === c.cutList) : undefined;
      out.push({ ...c, id: j.id, outputId: o?.id, missing: o?.missing, listId: l?.id, listMissing: l?.missing });
    }
    return out.slice(0, MAX_ROWS);
  }, [jobs]);

  const columns: ResultColumn<(typeof rows)[number]>[] = [
    { key: "file", header: "File", render: (r) => <span data-tip={r.output}>{basename(r.output)}</span>, text: (r) => basename(r.output) },
    { key: "removed", header: "Removed", align: "right", mono: true, render: (r) => formatSpan(r.removedMs), text: (r) => String(r.removedMs / 1000) },
    { key: "kept", header: "Kept", align: "right", mono: true, render: (r) => formatSpan(r.keptMs), text: (r) => String(r.keptMs / 1000) },
    {
      key: "actions",
      header: "",
      render: (r) => <FileActions outputId={r.outputId} path={r.output} disabled={r.missing} />,
      text: (r) => r.output,
    },
  ];

  const L = SILENCE_LIMITS;
  return (
    <FileToolLayout
      moduleId={moduleId}
      inputs={inputs}
      runLabel={runLabel("Cut", paths.length, "file", "files")}
      onRun={onRun}
      running={running}
      inputErrors={inputErrors}
      runDisabledReason={analysis && analysis.removed?.length === 0 ? "Nothing is silent with these settings" : undefined}
      primary={
        <>
          <div className={styles.options}>
            <div className={styles.row}>
              <span className={styles.label} data-tip="Sound quieter than this counts as silence. Raise it (closer to 0) to cut more">Silence below</span>
              <Stepper
                aria-label="Silence threshold"
                data-tip="Quieter than this many decibels is silence; -35 suits most speech"
                value={opts.thresholdDb}
                min={L.thresholdDb.min}
                max={L.thresholdDb.max}
                step={1}
                unit="dB"
                onChange={(thresholdDb) => setOpts((o) => ({ ...o, thresholdDb }))}
              />
            </div>
            <div className={styles.row}>
              <span className={styles.label} data-tip="Quiet stretches shorter than this are left alone">Shortest silence</span>
              <Stepper
                aria-label="Shortest silence"
                data-tip="Only cut quiet stretches at least this long, in seconds"
                value={opts.minSilenceMs / 1000}
                min={L.minSilenceMs.min / 1000}
                max={L.minSilenceMs.max / 1000}
                step={0.1}
                unit="s"
                onChange={(s) => setOpts((o) => ({ ...o, minSilenceMs: Math.round(s * 1000) }))}
              />
            </div>
          </div>
          {path && (
            <Section label="What would be cut" tip="Shaded stretches are removed; the rest is kept">
              <div className={styles.analysis} data-testid="silence-analysis">
                <div className={styles.head}>
                  {paths.length > 1 ? (
                    <Select
                      aria-label="File to look at"
                      size="sm"
                      value={path}
                      onChange={setSelected}
                      options={paths.map((p) => ({ value: p, label: basename(p) }))}
                    />
                  ) : (
                    <span className={styles.fileName}>{basename(path)}</span>
                  )}
                </div>
                {analysis && analysis.durationMs > 0 && (
                  <Timeline durationMs={analysis.durationMs} playheadMs={0} onSeek={() => undefined} waveform={peaks} ranges={ranges} />
                )}
                {analysis ? (
                  <p className={styles.summary} data-testid="silence-summary">{analysisSummary(analysis)}</p>
                ) : problem ? (
                  <p className={styles.error} role="alert">{problem}</p>
                ) : (
                  <p className={styles.status}>Listening…</p>
                )}
              </div>
            </Section>
          )}
        </>
      }
      advancedSummary={summarize(`${opts.paddingMs} ms padding`, opts.crossfadeMs > 0 && `${opts.crossfadeMs} ms smooth joins`, opts.cutList && "cut list") || "No extras"}
      advanced={
        <div className={styles.options}>
          <div className={styles.row}>
            <span className={styles.label} data-tip="Sound kept on each side of a cut so words don't feel clipped">Padding</span>
            <Stepper
              aria-label="Padding"
              data-tip="Milliseconds of the silence kept on each side of every cut"
              value={opts.paddingMs}
              min={L.paddingMs.min}
              max={L.paddingMs.max}
              step={50}
              unit="ms"
              onChange={(paddingMs) => setOpts((o) => ({ ...o, paddingMs }))}
            />
          </div>
          <div className={styles.row}>
            <span className={styles.label} data-tip="A very short fade across each join so it doesn't click">Smooth joins</span>
            <Stepper
              aria-label="Smooth joins"
              data-tip="Length of the fade at each join, in milliseconds; 0 for hard cuts"
              value={opts.crossfadeMs}
              min={L.crossfadeMs.min}
              max={L.crossfadeMs.max}
              step={5}
              unit="ms"
              onChange={(crossfadeMs) => setOpts((o) => ({ ...o, crossfadeMs }))}
            />
          </div>
          <div>
            <Switch
              checked={opts.cutList}
              onChange={(cutList) => setOpts((o) => ({ ...o, cutList }))}
              label="Also save a cut list"
              tip="Writes a .csv next to the result listing every kept and removed range"
            />
            <p className={styles.hint}>Video is re-encoded so every cut is exact.</p>
          </div>
        </div>
      }
      results={
        <Section label="Results" tip="Finished cuts with how much was removed">
          <ResultTable
            rows={rows}
            columns={columns}
            rowKey={(r) => r.id}
            label="cuts"
            rowFile={(r) => ({ path: r.output, outputId: r.outputId, missing: r.missing })}
            empty="No cuts yet. Cut files appear here with how much silence was removed."
          />
          {rows.some((r) => r.cutList) && (
            <div aria-label="Cut lists">
              {rows
                .filter((r) => r.cutList)
                .map((r) => (
                  <ResultRow key={`${r.id}-list`} path={r.cutList} outputId={r.listId || undefined} missing={r.listMissing} icon="file-text" meta="Cut list" />
                ))}
            </div>
          )}
        </Section>
      }
    />
  );
}
