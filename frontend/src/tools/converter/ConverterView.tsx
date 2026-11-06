import { useEffect, useMemo, useState } from "react";
import { Field, Section, Select, Switch } from "@/components";
import { ConverterService, MaxHeight, OutputKind, type PresetInfo } from "@/lib/api";
import { useRecentOutputs } from "@/state/library";
import { EmptyLine, FileToolLayout, runLabel, summarize, useFileInputs, useModuleOptions } from "@/tools/_kit";
import type { ToolViewProps } from "@/tools";
import { ResultRow } from "@/tools/_kit/ResultRow";
import { submitJobs } from "@/tools/_kit/enqueue";
import shared from "@/tools/_kit/results.module.css";
import {
  DEFAULT_CONVERTER_OPTIONS,
  incompatibleInputs,
  presetHint,
  presetSelectOptions,
  sanitizeConverterOptions,
} from "./options";
import styles from "./ConverterView.module.css";

const HEIGHTS: { value: MaxHeight; label: string }[] = [
  { value: MaxHeight.HeightKeep, label: "Keep original" },
  { value: MaxHeight.Height2160, label: "2160p" },
  { value: MaxHeight.Height1440, label: "1440p" },
  { value: MaxHeight.Height1080, label: "1080p" },
  { value: MaxHeight.Height720, label: "720p" },
  { value: MaxHeight.Height480, label: "480p" },
];

const KIND_ICON: Record<string, string> = {
  [OutputKind.KindAudio]: "music",
  [OutputKind.KindVideo]: "film",
  [OutputKind.KindImage]: "image",
};

export default function ConverterView({ moduleId }: ToolViewProps) {
  const inputs = useFileInputs(moduleId);
  const [opts, setOpts] = useModuleOptions(moduleId, DEFAULT_CONVERTER_OPTIONS, sanitizeConverterOptions);
  const [presets, setPresets] = useState<PresetInfo[]>([]);
  const [running, setRunning] = useState(false);
  const [submitErrors, setSubmitErrors] = useState<Record<string, string>>({});
  const recent = useRecentOutputs(moduleId, 20);

  useEffect(() => {
    let cancelled = false;
    ConverterService.Presets()
      .then((p) => {
        if (!cancelled) setPresets(p ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const preset = presets.find((p) => p.id === opts.preset);
  const hasHeight = preset?.kind === OutputKind.KindVideo || preset?.kind === OutputKind.KindImage;
  const heightLabel = HEIGHTS.find((h) => h.value === opts.maxHeight)?.label ?? "";
  const kindErrors = useMemo(() => incompatibleInputs(inputs.files, preset), [inputs.files, preset]);
  const inputErrors = useMemo(() => ({ ...submitErrors, ...kindErrors }), [submitErrors, kindErrors]);
  const compatible = inputs.files.filter((f) => !kindErrors[f.path]);
  const allBad = inputs.files.length > 0 && compatible.length === 0;

  const n = compatible.length;
  const onRun = async () => {
    const paths = compatible.map((f) => f.path);
    setRunning(true);
    const res = await submitJobs(() => ConverterService.Enqueue(paths, opts), paths, ["conversion", "conversions"]);
    setRunning(false);
    setSubmitErrors(res.inputErrors);
    if (res.ok) inputs.clear();
  };

  return (
    <FileToolLayout
      moduleId={moduleId}
      inputs={inputs}
      runLabel={runLabel("Convert", n, "file", "files")}
      onRun={onRun}
      running={running}
      inputErrors={inputErrors}
      runDisabledReason={allBad ? `No selected file fits ${preset?.label ?? "this preset"}` : undefined}
      primary={
        <Field label="Preset" hint={presetHint(preset)}>
          {(c) => (
            <Select
              id={c.id}
              aria-describedby={c["aria-describedby"]}
              data-tip={preset ? `${preset.label}: ${presetHint(preset)}` : "Pick the kind of file to produce; each preset sets format and quality for you"}
              value={opts.preset}
              options={presetSelectOptions(presets)}
              onChange={(id) => setOpts((o) => ({ ...o, preset: id }))}
            />
          )}
        </Field>
      }
      advancedSummary={summarize(hasHeight && (heightLabel === "Keep original" ? "Original size" : `Up to ${heightLabel}`), opts.keepMetadata ? "keep metadata" : "strip metadata")}
      advanced={
        <div className={styles.stack}>
          {hasHeight && (
            <Field label="Max height">
              {(c) => (
                <Select
                  id={c.id}
                  value={opts.maxHeight}
                  options={HEIGHTS}
                  data-tip="Shrink anything taller than this; smaller sizes make smaller files. Never enlarges"
                  onChange={(maxHeight) => setOpts((o) => ({ ...o, maxHeight }))} />
              )}
            </Field>
          )}
          <Switch
            tip="Copy tags, dates and camera info from the original; turn off to strip them for privacy"
            label="Keep metadata" checked={opts.keepMetadata} onChange={(keepMetadata) => setOpts((o) => ({ ...o, keepMetadata }))} />
        </div>
      }
      results={
        <Section label="Results" tip="Files this tool converted lately">
          {recent.length === 0 ? (
            <EmptyLine title="Nothing converted yet." body="Converted files appear here." />
          ) : (
            <ul className={shared.list}>
              {recent.map((o) => (
                <li key={o.id}>
                  <ResultRow path={o.path} outputId={o.id} missing={o.missing} name={o.name} sizeBytes={o.sizeBytes} at={o.createdAt} icon={KIND_ICON[o.kind] ?? "file"} />
                </li>
              ))}
            </ul>
          )}
        </Section>
      }
    />
  );
}
