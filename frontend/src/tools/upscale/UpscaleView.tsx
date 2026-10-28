import { useEffect, useMemo, useRef, useState } from "react";
import { Banner, Section, SegmentedControl, Select, cx, toast } from "@/components";
import {
  FilesService,
  JobStatus,
  UpscaleDevice,
  UpscaleFormat,
  UpscaleService,
  type UpscaleLimits,
  type UpscaleModelInfo,
} from "@/lib/api";
import { useOrderedJobs } from "@/state/jobs";
import { FileToolLayout, runLabel, setRequiresOverride, useFileInputs, useModuleOptions } from "@/tools/_kit";
import { AUDIO_ENGINE_ID } from "@/tools/_kit/DepsGate";
import { submitJobs } from "@/tools/_kit/enqueue";
import type { ToolViewProps } from "../index";
import { basename, isHeic } from "../image/common";
import { RadioCards } from "../image/RadioCards";
import { ResultCards } from "../image/ResultCards";
import imageStyles from "../image/image.module.css";
import {
  DEFAULT_UPSCALE_OPTIONS,
  cpuEstimateSeconds,
  formatEstimate,
  rowVerdict,
  sanitizeUpscaleOptions,
  toResultItem,
  type ImageDims,
} from "./options";

const MAX_RESULTS = 24;
const GPU_ERROR = "No compatible GPU found";

const FORMAT_OPTIONS = [
  { value: UpscaleFormat.FormatSame, label: "Same as input" },
  { value: UpscaleFormat.FormatPNG, label: "PNG" },
  { value: UpscaleFormat.FormatJPG, label: "JPG" },
  { value: UpscaleFormat.FormatWebP, label: "WebP" },
];

const DEVICE_OPTIONS = [
  { value: UpscaleDevice.DeviceAuto, label: "Automatic" },
  { value: UpscaleDevice.DeviceGPU, label: "GPU" },
  { value: UpscaleDevice.DeviceCPU, label: "CPU (slower)" },
];

type SizeInfo = ImageDims | "heic";

export default function UpscaleView({ moduleId }: ToolViewProps) {
  const inputs = useFileInputs(moduleId);
  const [opts, setOpts] = useModuleOptions(moduleId, DEFAULT_UPSCALE_OPTIONS, sanitizeUpscaleOptions);
  const [models, setModels] = useState<UpscaleModelInfo[]>([]);
  const [limits, setLimits] = useState<UpscaleLimits | null>(null);
  const [sizes, setSizes] = useState<Record<string, SizeInfo>>({});
  const [running, setRunning] = useState(false);
  const [submitErrors, setSubmitErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<string | null>(null);
  const jobs = useOrderedJobs(moduleId);

  useEffect(() => {
    let cancelled = false;
    UpscaleService.Models()
      .then((m) => !cancelled && setModels(m ?? []))
      .catch(() => undefined);
    UpscaleService.Limits()
      .then((l) => !cancelled && setLimits(l))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // The CPU processor runs on the AI engine, not the upscaler binary.
  const cpu = opts.device === UpscaleDevice.DeviceCPU;
  useEffect(() => {
    setRequiresOverride(moduleId, cpu ? [AUDIO_ENGINE_ID] : null);
    return () => setRequiresOverride(moduleId, null);
  }, [moduleId, cpu]);

  // Read image sizes for new inputs (HEIC has no Go decoder).
  const requested = useRef(new Set<string>());
  useEffect(() => {
    for (const f of inputs.files) {
      if (requested.current.has(f.path)) continue;
      requested.current.add(f.path);
      if (isHeic(f.path)) {
        setSizes((s) => ({ ...s, [f.path]: "heic" }));
        continue;
      }
      FilesService.ImageSize(f.path)
        .then((sz) => setSizes((s) => ({ ...s, [f.path]: { w: sz.w, h: sz.h } })))
        .catch(() => undefined);
    }
  }, [inputs.files]);

  const verdicts = useMemo(
    () =>
      inputs.files.map((f) => ({
        path: f.path,
        v: rowVerdict(sizes[f.path], opts.scale, opts.device, limits),
      })),
    [inputs.files, sizes, opts.scale, opts.device, limits],
  );

  const overErrors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const { path, v } of verdicts) if (v.kind === "over") out[path] = v.reason;
    return out;
  }, [verdicts]);

  const estimate = useMemo(() => {
    if (!cpu) return "";
    const info = models.find((m) => m.id === opts.model);
    if (!info) return "";
    const dims = verdicts.flatMap(({ path, v }) => {
      const s = sizes[path];
      return v.kind === "ok" && s && s !== "heic" ? [s] : [];
    });
    if (dims.length === 0) return "";
    return formatEstimate(cpuEstimateSeconds(dims, info.cpuSecondsPerMPixel));
  }, [cpu, models, opts.model, verdicts, sizes]);

  const items = useMemo(
    () =>
      jobs
        .filter((j) => j.status === JobStatus.JobDone)
        .map(toResultItem)
        .filter((i) => i !== null)
        .slice(0, MAX_RESULTS),
    [jobs],
  );

  const gpuFailed = useMemo(() => {
    const last = jobs.find((j) => j.status === JobStatus.JobFailed);
    return !!last && last.error.includes(GPU_ERROR);
  }, [jobs]);

  const onRun = async () => {
    const all = inputs.files.map((f) => f.path);
    const paths = all.filter((p) => !overErrors[p]);
    const skipped = all.length - paths.length;
    if (skipped > 0) {
      toast({
        title: `Skipped ${skipped} ${skipped === 1 ? "image" : "images"} over the size limit`,
        tone: "warn",
      });
    }
    if (paths.length === 0) return;
    setRunning(true);
    const res = await submitJobs(() => UpscaleService.Enqueue(paths, opts), paths, ["image", "images"]);
    setRunning(false);
    setSubmitErrors(res.inputErrors);
    if (res.ok) inputs.clear();
  };

  const okCount = verdicts.filter((x) => x.v.kind !== "over").length;
  const modelOptions = (models.length > 0 ? models : []).map((m) => ({ value: m.id, label: m.label, hint: m.hint }));

  return (
    <FileToolLayout
      moduleId={moduleId}
      inputs={inputs}
      runLabel={runLabel("Upscale", okCount, "image", "images")}
      onRun={onRun}
      running={running}
      inputErrors={{ ...submitErrors, ...overErrors }}
      options={
        <>
          {gpuFailed && (
            <Banner tone="warn" title={GPU_ERROR}>
              The upscaler needs a GPU with Vulkan support. Set Processor to Automatic or CPU (slower) to use the AI
              engine instead.
            </Banner>
          )}
          <Section label="Options">
            <div className={imageStyles.options}>
              <RadioCards
                aria-label="Model"
                options={modelOptions}
                value={opts.model}
                onChange={(model) => setOpts((o) => ({ ...o, model }))}
              />
              <div className={imageStyles.optRow}>
                <span className={imageStyles.optLabel}>Scale</span>
                <SegmentedControl
                  aria-label="Scale"
                  value={String(opts.scale) as "2" | "4"}
                  onChange={(v) => setOpts((o) => ({ ...o, scale: Number(v) }))}
                  options={[
                    { value: "2", label: "2×" },
                    { value: "4", label: "4×" },
                  ]}
                />
              </div>
              <div className={imageStyles.optRow}>
                <label className={imageStyles.optLabel} htmlFor="upscale-format">
                  Format
                </label>
                <Select
                  id="upscale-format"
                  value={opts.format}
                  options={FORMAT_OPTIONS}
                  onChange={(format) => setOpts((o) => ({ ...o, format }))}
                />
              </div>
              <div className={imageStyles.optRow}>
                <label className={imageStyles.optLabel} htmlFor="upscale-device">
                  Processor
                </label>
                <Select
                  id="upscale-device"
                  value={opts.device}
                  options={DEVICE_OPTIONS}
                  onChange={(device) => setOpts((o) => ({ ...o, device }))}
                />
                {cpu && (
                  <span className={imageStyles.mono}>
                    {estimate ? `Estimated time ${estimate}` : "Runs on the AI engine, much slower than a GPU"}
                  </span>
                )}
              </div>
              {inputs.files.length > 0 && (
                <ul className={imageStyles.sizeList} aria-label="Image sizes">
                  {verdicts.map(({ path, v }) => (
                    <li key={path} className={cx(imageStyles.rowInfo, v.kind === "over" && imageStyles.rowWarn)}>
                      <span title={path}>{basename(path)}</span>
                      <span>
                        {v.kind === "heic"
                          ? "HEIC"
                          : v.kind === "unknown"
                            ? "…"
                            : `${(sizes[path] as ImageDims).w}×${(sizes[path] as ImageDims).h} → ${v.outW}×${v.outH}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Section>
        </>
      }
      results={
        <Section label="Results">
          <ResultCards
            items={items}
            preview={preview}
            onPreview={setPreview}
            empty={{ title: "Nothing upscaled yet.", body: "Upscale an image and the result appears here." }}
          />
        </Section>
      }
    />
  );
}
