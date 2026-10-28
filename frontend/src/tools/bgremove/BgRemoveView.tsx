import { useEffect, useMemo, useState } from "react";
import { ColorSwatchPicker, Section, SegmentedControl, Stepper, Switch } from "@/components";
import { BgOutput, BgRemoveService, JobStatus, type PresetInfo } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { useOrderedJobs } from "@/state/jobs";
import { FileToolLayout, runLabel, useFileInputs, useModuleOptions } from "@/tools/_kit";
import { submitJobs } from "@/tools/_kit/enqueue";
import type { ToolViewProps } from "../index";
import { RadioCards } from "../image/RadioCards";
import { ResultCards } from "../image/ResultCards";
import imageStyles from "../image/image.module.css";
import { DEFAULT_BG_OPTIONS, sanitizeBgOptions, submitOptions, toResultItem } from "./options";

const MAX_RESULTS = 24;

const MODEL_HINT: Record<string, string> = {
  fast: "~1 s, softer hair",
  balanced: "~8 s, great edges · needs ~7 GB RAM",
  best: "~15 s, finest detail · needs ~7 GB RAM",
};

const FALLBACK_PRESETS: Array<{ id: string; label: string }> = [
  { id: "fast", label: "Fast" },
  { id: "balanced", label: "Balanced" },
  { id: "best", label: "Best" },
];

export default function BgRemoveView({ moduleId }: ToolViewProps) {
  const inputs = useFileInputs(moduleId);
  const [opts, setOpts] = useModuleOptions(moduleId, DEFAULT_BG_OPTIONS, sanitizeBgOptions);
  const [presets, setPresets] = useState<PresetInfo[]>([]);
  const [running, setRunning] = useState(false);
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<string | null>(null);
  const jobs = useOrderedJobs(moduleId);

  useEffect(() => {
    let cancelled = false;
    BgRemoveService.Presets()
      .then((p) => !cancelled && setPresets(p ?? []))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const items = useMemo(
    () =>
      jobs
        .filter((j) => j.status === JobStatus.JobDone)
        .map(toResultItem)
        .filter((i) => i !== null)
        .slice(0, MAX_RESULTS),
    [jobs],
  );

  const cardOptions = useMemo(() => {
    const base = presets.length > 0 ? presets.map((p) => ({ id: p.id, label: p.label, bytes: p.downloadBytes })) : FALLBACK_PRESETS.map((p) => ({ ...p, bytes: 0 }));
    return base.map((p) => ({
      value: p.id as typeof opts.model,
      label: p.label,
      hint: MODEL_HINT[p.id],
      note: p.bytes > 0 ? `${formatBytes(p.bytes)} first-use download` : undefined,
    }));
  }, [presets, opts]);

  const n = inputs.files.length;
  const onRun = async () => {
    const paths = inputs.files.map((f) => f.path);
    setRunning(true);
    const res = await submitJobs(() => BgRemoveService.Enqueue(paths, submitOptions(opts)), paths, ["image", "images"]);
    setRunning(false);
    setInputErrors(res.inputErrors);
    if (res.ok) inputs.clear();
  };

  return (
    <FileToolLayout
      moduleId={moduleId}
      inputs={inputs}
      runLabel={runLabel("Remove background", n, "image", "images")}
      onRun={onRun}
      running={running}
      inputErrors={inputErrors}
      options={
        <Section label="Options">
          <div className={imageStyles.options}>
            <RadioCards
              aria-label="Model"
              options={cardOptions}
              value={opts.model}
              onChange={(model) => setOpts((o) => ({ ...o, model }))}
            />
            <div className={imageStyles.optRow}>
              <span className={imageStyles.optLabel}>Background</span>
              <SegmentedControl
                aria-label="Background"
                value={opts.output}
                onChange={(output) => setOpts((o) => ({ ...o, output }))}
                options={[
                  { value: BgOutput.OutputTransparent, label: "Transparent" },
                  { value: BgOutput.OutputColor, label: "Colour" },
                  { value: BgOutput.OutputMask, label: "Mask only" },
                ]}
              />
              {opts.output === BgOutput.OutputColor && (
                <ColorSwatchPicker
                  aria-label="Background colour"
                  value={opts.color}
                  onChange={(color) => setOpts((o) => ({ ...o, color }))}
                />
              )}
            </div>
            <div className={imageStyles.optRow}>
              <Switch
                checked={opts.crop}
                onChange={(crop) => setOpts((o) => ({ ...o, crop }))}
                label="Crop to subject"
              />
              {opts.crop && (
                <Stepper
                  aria-label="Padding"
                  value={opts.padding}
                  min={0}
                  max={500}
                  step={8}
                  unit="px"
                  onChange={(padding) => setOpts((o) => ({ ...o, padding }))}
                />
              )}
            </div>
            <Switch
              checked={opts.cleanEdges}
              onChange={(cleanEdges) => setOpts((o) => ({ ...o, cleanEdges }))}
              label="Clean edges"
            />
            <div>
              <Switch
                checked={opts.refine}
                onChange={(refine) => setOpts((o) => ({ ...o, refine }))}
                label="Refine edges"
              />
              <p className={imageStyles.help}>Sharper hair, may leak on busy backgrounds</p>
            </div>
          </div>
        </Section>
      }
      results={
        <Section label="Results">
          <ResultCards
            items={items}
            preview={preview}
            onPreview={setPreview}
            empty={{ title: "No cut-outs yet.", body: "Remove a background and the result appears here." }}
          />
        </Section>
      }
    />
  );
}
