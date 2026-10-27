import { useEffect, useMemo, useState } from "react";
import { EmptyState, Field, Icon, Section, Select, Switch, cx } from "@/components";
import { ConverterService, MaxHeight, OutputKind, type PresetInfo } from "@/lib/api";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { useRecentOutputs } from "@/state/library";
import { FileToolLayout, runLabel, useFileInputs, useModuleOptions } from "@/tools/_kit";
import type { ToolViewProps } from "@/tools";
import { FileActions } from "@/tools/_kit/FileActions";
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
  const isVideo = preset?.kind === OutputKind.KindVideo;
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
      options={
        <Section label="Options">
          <div className={styles.stack}>
            <Field label="Preset" hint={presetHint(preset)}>
              {(c) => (
                <Select
                  id={c.id}
                  aria-describedby={c["aria-describedby"]}
                  value={opts.preset}
                  options={presetSelectOptions(presets)}
                  onChange={(id) => setOpts((o) => ({ ...o, preset: id }))}
                />
              )}
            </Field>
            {isVideo && (
              <Field label="Max height">
                {(c) => (
                  <Select id={c.id} value={opts.maxHeight} options={HEIGHTS} onChange={(maxHeight) => setOpts((o) => ({ ...o, maxHeight }))} />
                )}
              </Field>
            )}
            <Switch label="Keep metadata" checked={opts.keepMetadata} onChange={(keepMetadata) => setOpts((o) => ({ ...o, keepMetadata }))} />
          </div>
        </Section>
      }
      results={
        <Section label="Recent conversions">
          {recent.length === 0 ? (
            <EmptyState icon="repeat" title="Nothing converted yet." body="Converted files appear here." />
          ) : (
            <ul className={shared.list}>
              {recent.map((o) => (
                <li key={o.id} className={cx(shared.row, o.missing && shared.missing)}>
                  <Icon name={KIND_ICON[o.kind] ?? "file"} size={14} className={shared.icon} />
                  <span className={shared.name} title={o.path}>
                    {o.name}
                  </span>
                  <span className={shared.meta}>{formatBytes(o.sizeBytes)}</span>
                  <span className={shared.meta}>{formatRelativeTime(o.createdAt)}</span>
                  <span className={shared.actions}>
                    <FileActions outputId={o.id} path={o.path} disabled={o.missing} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      }
    />
  );
}
