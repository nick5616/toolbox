import { Field } from "@/components/Field";
import { Select } from "@/components/Select";
import { Stepper } from "@/components/Stepper";
import { Switch } from "@/components/Switch";
import type { CompressOptions } from "@/lib/api";
import {
  CODEC_CHOICES,
  COMPRESS_LIMITS,
  CUSTOM_TARGET,
  DEFAULT_COMPRESS_OPTIONS,
  IMAGE_FORMAT_CHOICES,
  MAX_HEIGHTS,
  STATIC_TARGETS,
  TOO_SMALL_CHOICES,
  maxHeightLabel,
  sanitizeCompressOptions,
} from "@/tools/compress/options";
import { ui } from "./phase14";
import { parseObject, registerSteps, type StepEditorProps } from "./registry";
import styles from "./phase14.module.css";

// Step editor of Compress to Size ("compress"), Phase 17. parse() keeps
// unknown fields and sanitises every field to what Go accepts.

/** Mirrors modules/compress DefaultOptions() (the step options are the tool's options). */
export const DEFAULT_COMPRESS_STEP: CompressOptions = { ...DEFAULT_COMPRESS_OPTIONS };

export function parseCompressStep(json: string): CompressOptions {
  const r = parseObject(json);
  return { ...r, ...sanitizeCompressOptions(r, DEFAULT_COMPRESS_STEP) };
}

function CompressEditor({ value, onChange }: StepEditorProps<CompressOptions>) {
  const set = (patch: Partial<CompressOptions>) => onChange({ ...value, ...patch });
  const known = STATIC_TARGETS.some(([id]) => id === value.targetId);
  const targets = known ? STATIC_TARGETS.map(([v, label]) => ({ value: v, label })) : [{ value: value.targetId, label: value.targetId }, ...STATIC_TARGETS.map(([v, label]) => ({ value: v, label }))];
  return (
    <div className={styles.stack}>
      <div className={styles.pair}>
        <Field label="Target">{(c) => <Select id={c.id} aria-label="Target" value={value.targetId} options={targets} onChange={(targetId) => set({ targetId })} />}</Field>
        {value.targetId === CUSTOM_TARGET && (
          <Field label="Custom size (MB)">
            {(c) => <Stepper id={c.id} aria-label="Custom size (MB)" value={value.targetMb} min={COMPRESS_LIMITS.targetMb.min} max={COMPRESS_LIMITS.targetMb.max} step={1} unit="MB" onChange={(targetMb) => set({ targetMb })} />}
          </Field>
        )}
      </div>
      <div className={styles.pair}>
        <Field label="If it would look bad">
          {(c) => <Select id={c.id} aria-label="If it would look bad" value={value.ifTooSmall} options={TOO_SMALL_CHOICES.map((o) => ({ ...o }))} onChange={(ifTooSmall) => set({ ifTooSmall })} />}
        </Field>
        <Field label="Video codec">
          {(c) => <Select id={c.id} aria-label="Video codec" value={value.videoCodec} options={CODEC_CHOICES.map((o) => ({ ...o }))} onChange={(videoCodec) => set({ videoCodec })} />}
        </Field>
      </div>
      <div className={styles.pair}>
        <Field label="Max video height">
          {(c) => (
            <Select
              id={c.id}
              aria-label="Max video height"
              value={String(value.maxHeight)}
              options={MAX_HEIGHTS.map((h) => ({ value: String(h), label: maxHeightLabel(h) }))}
              onChange={(h) => set({ maxHeight: Number(h) })}
            />
          )}
        </Field>
        <Field label="Photo format">
          {(c) => <Select id={c.id} aria-label="Photo format" value={value.imageFormat} options={IMAGE_FORMAT_CHOICES.map((o) => ({ ...o }))} onChange={(imageFormat) => set({ imageFormat })} />}
        </Field>
      </div>
      <Switch checked={value.keepAudio} onChange={(keepAudio) => set({ keepAudio })} label="Keep sound" />
      <Switch checked={value.keepMetadata} onChange={(keepMetadata) => set({ keepMetadata })} label="Keep location & camera data" />
      <p className={styles.hint}>
        Later steps get the compressed file (and each part when a video is split), and the variables {"{size_mb}"}, {"{fits}"} and {"{grade}"}.
      </p>
    </div>
  );
}

export const compressSteps = [ui("compress", parseCompressStep, CompressEditor)];

registerSteps(compressSteps);
