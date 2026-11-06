import { useEffect, useMemo, useState } from "react";
import { SegmentedControl, Section, Select, Stepper, Switch, cx } from "@/components";
import { CompressService, JobStatus, type CompressEstimate, type CompressTarget } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { FileToolLayout, ResultTable, runLabel, summarize, useFileInputs, useModuleOptions } from "@/tools/_kit";
import type { ResultColumn } from "@/tools/_kit";
import { FileActions } from "@/tools/_kit/FileActions";
import { submitJobs } from "@/tools/_kit/enqueue";
import { basename } from "@/tools/_kit/image/common";
import { useToolJobs } from "@/tools/_kit/session";
import type { ToolViewProps } from "../index";
import {
  COMPRESS_LIMITS,
  CODEC_CHOICES,
  CUSTOM_TARGET,
  DEFAULT_COMPRESS_OPTIONS,
  GRADE_LABELS,
  GRADE_TIPS,
  IMAGE_FORMAT_CHOICES,
  MAX_HEIGHTS,
  TOO_SMALL_CHOICES,
  advancedSummaryParts,
  cantFitLine,
  estimateKey,
  estimateTotals,
  fillFraction,
  formatBytes,
  maxHeightLabel,
  parseCompressResult,
  sanitizeCompressOptions,
  sizeLine,
  targetLabel,
  type CompressedFile,
} from "./options";
import styles from "./CompressView.module.css";

const ESTIMATE_DELAY_MS = 400;
const MAX_ROWS = 100;

type Estimated = { key: string; list: CompressEstimate[] } | { key: string; error: string };

function GradeChip({ grade }: { grade: string }) {
  const label = GRADE_LABELS[grade];
  if (!label) return null;
  return (
    <span className={cx(styles.chip, styles[grade])} data-tip={GRADE_TIPS[grade]}>
      {label}
    </span>
  );
}

export default function CompressView({ moduleId }: ToolViewProps) {
  const inputs = useFileInputs(moduleId);
  const [opts, setOpts, loaded] = useModuleOptions(moduleId, DEFAULT_COMPRESS_OPTIONS, sanitizeCompressOptions);
  const [running, setRunning] = useState(false);
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const [targets, setTargets] = useState<CompressTarget[]>([]);
  const jobs = useToolJobs(moduleId);

  const paths = useMemo(() => inputs.files.map((f) => f.path), [inputs.files]);

  useEffect(() => {
    let cancelled = false;
    CompressService.Targets()
      .then((t) => !cancelled && setTargets(t ?? []))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Estimates: debounced, and a stale answer is ignored by its key.
  const key = paths.length > 0 ? estimateKey(paths, opts) : "";
  const [estimated, setEstimated] = useState<Estimated | null>(null);
  useEffect(() => {
    if (!key || !loaded) return;
    let cancelled = false;
    const t = setTimeout(() => {
      CompressService.Estimate(paths, opts)
        .then((list) => !cancelled && setEstimated({ key, list: list ?? [] }))
        .catch((e: unknown) => !cancelled && setEstimated({ key, error: toAppError(e).message }));
    }, ESTIMATE_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // `key` covers the paths and every option Estimate depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, loaded]);

  const current = estimated && estimated.key === key ? estimated : null;
  const list = current && "list" in current ? current.list : null;
  const problem = current && "error" in current ? current.error : "";

  const target = targets.find((t) => t.id === opts.targetId);
  const targetOptions = useMemo(
    () => [
      ...(targets.length === 0 && opts.targetId !== CUSTOM_TARGET ? [{ value: opts.targetId, label: opts.targetId }] : []),
      ...targets.map((t) => ({ value: t.id, label: targetLabel(t) })),
      { value: CUSTOM_TARGET, label: "Custom size…" },
    ],
    [targets, opts.targetId],
  );

  const onRun = async () => {
    setRunning(true);
    const res = await submitJobs(() => CompressService.Enqueue(paths, opts), paths, ["file", "files"]);
    setRunning(false);
    setInputErrors(res.inputErrors);
    if (res.ok) inputs.clear();
  };

  const rows = useMemo(() => {
    const out: Array<CompressedFile & { id: string; outputId?: string; missing?: boolean }> = [];
    for (const j of jobs) {
      if (j.status !== JobStatus.JobDone) continue;
      for (const f of parseCompressResult(j.resultJson)) {
        const o = j.outputs.find((x) => x.path === f.path);
        out.push({ ...f, id: `${j.id}:${f.part}`, outputId: o?.id, missing: o?.missing });
      }
    }
    return out.slice(0, MAX_ROWS);
  }, [jobs]);

  const columns: ResultColumn<(typeof rows)[number]>[] = [
    {
      key: "file",
      header: "File",
      render: (r) => (
        <span data-tip={r.plan || r.path}>
          {basename(r.path)}
          {r.parts > 1 ? ` — part ${r.part} of ${r.parts}` : ""}
        </span>
      ),
      text: (r) => basename(r.path),
    },
    {
      key: "size",
      header: "Size",
      align: "right",
      mono: true,
      render: (r) => (r.alreadyFit ? "Already fits" : `${formatBytes(r.originalBytes)} → ${formatBytes(r.finalBytes)}`),
      text: (r) => String(r.finalBytes),
    },
    {
      key: "limit",
      header: "Limit",
      render: (r) => (
        <span className={styles.bar} data-tip={`${formatBytes(r.finalBytes)} of ${formatBytes(r.limitBytes)}`}>
          <span className={cx(styles.barFill, !r.fits && styles.barOver)} style={{ width: `${fillFraction(r.finalBytes, r.limitBytes) * 100}%` }} />
        </span>
      ),
      text: (r) => String(r.limitBytes),
    },
    { key: "grade", header: "Quality", render: (r) => <GradeChip grade={r.grade} />, text: (r) => GRADE_LABELS[r.grade] ?? "" },
    {
      key: "actions",
      header: "",
      render: (r) => <FileActions outputId={r.outputId} path={r.path} disabled={r.missing} />,
      text: (r) => r.path,
    },
  ];

  const isCustom = opts.targetId === CUSTOM_TARGET;
  const cantFit = list ? list.some((e) => !e.alreadyFits && !e.possible) : false;

  return (
    <FileToolLayout
      moduleId={moduleId}
      inputs={inputs}
      runLabel={runLabel("Compress", paths.length, "file", "files")}
      onRun={onRun}
      running={running}
      inputErrors={inputErrors}
      primary={
        <>
          <div className={styles.options}>
            <div className={styles.row}>
              <span className={styles.label} data-tip="Where the file is going. It is shrunk to fit that place's size limit">Make it fit</span>
              <Select
                aria-label="Target"
                value={opts.targetId}
                options={targetOptions}
                onChange={(targetId) => setOpts((o) => ({ ...o, targetId }))}
              />
              {isCustom && (
                <Stepper
                  aria-label="Custom size"
                  data-tip="The largest size the result may be, in megabytes (1 MB = 1,000,000 bytes)"
                  value={opts.targetMb}
                  min={COMPRESS_LIMITS.targetMb.min}
                  max={COMPRESS_LIMITS.targetMb.max}
                  step={1}
                  unit="MB"
                  onChange={(targetMb) => setOpts((o) => ({ ...o, targetMb }))}
                />
              )}
            </div>
            {!isCustom && target?.note && <p className={styles.note}>{target.note}</p>}
          </div>
          {paths.length > 0 && (
            <Section label="What would happen" tip="A quick estimate for each file with these settings">
              <div className={styles.estimates} data-testid="compress-estimates">
                {list ? (
                  <>
                    <p className={styles.total} data-testid="compress-total">{estimateTotals(list)}</p>
                    {list.map((e) => {
                      const cant = cantFitLine(e, opts.ifTooSmall);
                      return (
                        <div key={e.path} className={styles.est} data-testid="compress-estimate" data-tip={e.note || undefined}>
                          <span className={styles.name}>{e.name || basename(e.path)}</span>
                          {e.problem ? (
                            <span className={styles.problem} data-tip={e.problem}>{e.problem}</span>
                          ) : (
                            <>
                              <span className={styles.size}>{sizeLine(e)}</span>
                              {cant ? <span className={styles.warn}>{cant}</span> : e.plan && !e.alreadyFits && <span className={styles.plan} data-tip={e.plan}>{e.plan}</span>}
                              {!e.alreadyFits && <GradeChip grade={e.grade} />}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </>
                ) : problem ? (
                  <p className={styles.problem} role="alert">{problem}</p>
                ) : (
                  <p className={styles.note}>Working out the sizes…</p>
                )}
              </div>
            </Section>
          )}
        </>
      }
      advancedSummary={summarize(...advancedSummaryParts(opts)) || "Defaults"}
      advanced={
        <div className={styles.options}>
          <div className={styles.row}>
            <span className={styles.label} data-tip="What to do when the file can't look decent at that size">If it would look bad</span>
            <SegmentedControl
              aria-label="If it would look bad"
              size="sm"
              value={opts.ifTooSmall}
              options={TOO_SMALL_CHOICES.map((c) => ({ ...c }))}
              onChange={(ifTooSmall) => setOpts((o) => ({ ...o, ifTooSmall }))}
            />
            {cantFit && <span className={styles.warn}>Some files can't fit</span>}
          </div>
          <div className={styles.row}>
            <span className={styles.label} data-tip="The video encoder">Video codec</span>
            <Select
              aria-label="Video codec"
              size="sm"
              value={opts.videoCodec}
              options={CODEC_CHOICES.map((c) => ({ ...c }))}
              onChange={(videoCodec) => setOpts((o) => ({ ...o, videoCodec }))}
            />
          </div>
          <div className={styles.row}>
            <span className={styles.label} data-tip="Never make the picture taller than this">Max video height</span>
            <Select
              aria-label="Max video height"
              size="sm"
              value={String(opts.maxHeight)}
              options={MAX_HEIGHTS.map((h) => ({ value: String(h), label: maxHeightLabel(h) }))}
              onChange={(h) => setOpts((o) => ({ ...o, maxHeight: Number(h) }))}
            />
          </div>
          <div className={styles.row}>
            <span className={styles.label} data-tip="The format photos are saved in">Photo format</span>
            <Select
              aria-label="Photo format"
              size="sm"
              value={opts.imageFormat}
              options={IMAGE_FORMAT_CHOICES.map((c) => ({ ...c }))}
              onChange={(imageFormat) => setOpts((o) => ({ ...o, imageFormat }))}
            />
          </div>
          <Switch checked={opts.keepAudio} onChange={(keepAudio) => setOpts((o) => ({ ...o, keepAudio }))} label="Keep sound" tip="Turn off to drop the audio track of videos" />
          <Switch
            checked={opts.keepMetadata}
            onChange={(keepMetadata) => setOpts((o) => ({ ...o, keepMetadata }))}
            label="Keep location & camera data"
            tip="Videos and audio keep their tags (location included). Re-encoded photos always lose them"
          />
        </div>
      }
      results={
        <Section label="Results" tip="Finished files with their size against the limit">
          <ResultTable
            rows={rows}
            columns={columns}
            rowKey={(r) => r.id}
            label="compressed"
            rowFile={(r) => ({ path: r.path, outputId: r.outputId, missing: r.missing })}
            empty="Nothing compressed yet. Smaller files appear here."
          />
        </Section>
      }
    />
  );
}
