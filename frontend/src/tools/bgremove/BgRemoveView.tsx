import { useEffect, useMemo, useState } from "react";
import { ColorSwatchPicker, Section, SegmentedControl, Stepper, Switch } from "@/components";
import { BgOutput, BgRemoveService, JobStatus, type PresetInfo } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { useToolJobs } from "@/tools/_kit/session";
import { FileToolLayout, summarize, useFileInputs, useModuleOptions } from "@/tools/_kit";
import { submitJobs } from "@/tools/_kit/enqueue";
import type { ToolViewProps } from "../index";
import { RadioCards } from "@/tools/_kit/image/RadioCards";
import { ResultCards } from "@/tools/_kit/image/ResultCards";
import imageStyles from "@/tools/_kit/image/image.module.css";
import { DEFAULT_BG_OPTIONS, sanitizeBgOptions, submitOptions, toResultItem } from "./options";

const MAX_RESULTS = 24;

const MODEL_HINT: Record<string, string> = {
  fast: "~1 s, softer hair",
  balanced: "~8 s, great edges · needs ~7 GB RAM",
  best: "~15 s, finest detail · needs ~7 GB RAM",
};

const MODEL_TIP: Record<string, string> = {
  fast: "Quickest and lightest; edges and hair come out a bit softer",
  balanced: "Good edges at a moderate speed; the best everyday choice, needs about 7 GB of memory",
  best: "Finest detail on hair and fur but the slowest, needs about 7 GB of memory",
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
  const jobs = useToolJobs(moduleId);

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
      tip: `${MODEL_TIP[p.id] ?? p.label}${p.bytes > 0 ? `; ${formatBytes(p.bytes)} model download on first use` : ""}`,
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
  };

  return (
    <FileToolLayout
      moduleId={moduleId}
      inputs={inputs}
      runLabel={n > 1 ? `Remove backgrounds (${n})` : "Remove backgrounds"}
      onRun={onRun}
      running={running}
      inputErrors={inputErrors}
      primary={
        <div className={imageStyles.optRow}>
          <span className={imageStyles.optLabel} data-tip="What the area behind the subject becomes">Background</span>
          <SegmentedControl
            aria-label="Background"
            value={opts.output}
            onChange={(output) => setOpts((o) => ({ ...o, output }))}
            options={[
              { value: BgOutput.OutputTransparent, label: "Transparent", tip: "Save a PNG with a see-through background" },
              { value: BgOutput.OutputColor, label: "Colour", tip: "Fill the background with a solid colour of your choice" },
              { value: BgOutput.OutputMask, label: "Mask only", tip: "Save a black and white cut-out mask instead of the photo, for use in other editors" },
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
      }
      advancedSummary={summarize(
        opts.model.charAt(0).toUpperCase() + opts.model.slice(1),
        opts.crop && `crop ${opts.padding} px`,
        opts.cleanEdges && "clean edges",
        opts.refine && "refine edges",
      )}
      advanced={
        <div className={imageStyles.options}>
          <Section label="Model" tip="Quality versus speed of the cut-out model">
            <RadioCards
              aria-label="Model"
              options={cardOptions}
              value={opts.model}
              onChange={(model) => setOpts((o) => ({ ...o, model }))}
            />
          </Section>
          <Section label="Cut-out" tip="How the cut-out is trimmed and cleaned">
            <div className={imageStyles.options}>
              <div className={imageStyles.optRow}>
                <Switch
                  checked={opts.crop}
                  onChange={(crop) => setOpts((o) => ({ ...o, crop }))}
                  label="Crop to subject"
                  tip="Trim the empty space around the subject so the file is only as big as the cut-out"
                />
                {opts.crop && (
                  <Stepper
                    aria-label="Padding"
                    data-tip="Empty margin kept around the subject, in pixels"
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
                tip="Removes the faint halo and stray specks around the cut-out edge"
              />
              <div>
                <Switch
                  checked={opts.refine}
                  onChange={(refine) => setOpts((o) => ({ ...o, refine }))}
                  label="Refine edges"
                  tip="Extra pass for finer hair and fur detail; can let background show through on busy scenes"
                />
                <p className={imageStyles.help}>Sharper hair, may leak on busy backgrounds</p>
              </div>
            </div>
          </Section>
        </div>
      }
      results={
        <Section label="Results" tip="Finished cut-outs; drag the slider on a card to compare with the original">
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
