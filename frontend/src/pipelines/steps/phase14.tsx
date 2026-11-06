import { useMemo } from "react";
import { Field } from "@/components/Field";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Select } from "@/components/Select";
import { Switch } from "@/components/Switch";
import { TemplateField } from "@/components/TemplateField";
import { EraserModel, EraserService, type EraserSavedMask, type EraserStepOptions, type PipelineRunStep } from "@/lib/api";
import { usePipelines } from "@/state/pipelines";
import { useCurrentPipelineId, useLoadedList } from "./context";
import { parseObject, registerSteps, type StepEditorProps, type StepUI } from "./registry";
import { PARAMS } from "./paramDefs";
import styles from "./phase14.module.css";

// Step editors of the tools that became pipeline steps in Phase 14 (SPEC §1.A):
// Dev Utilities, Post Builder, Clipboard History, Object Eraser and "Run
// another pipeline". (Photo Composer and the two editors are in phase14media.)
// Every parse() keeps fields it doesn't know and never throws.

export const str = (v: unknown, d: string): string => (typeof v === "string" ? v : d);
export const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
export const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
export const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => allowed.find((a) => a === v) ?? d;

export const ui = <T,>(type: string, parse: (json: string) => T, Editor: StepUI<T>["Editor"]): StepUI<never> =>
  ({ type, parse, Editor, params: PARAMS[type] }) as unknown as StepUI<never>;

// ---------- Dev Utilities ("dev-utils") ----------

export const DEVUTILS_ALGORITHMS = [
  { value: "sha256", label: "SHA-256" },
  { value: "sha1", label: "SHA-1" },
  { value: "md5", label: "MD5" },
  { value: "sha512", label: "SHA-512" },
  { value: "crc32", label: "CRC-32" },
] as const;
const ALGO_IDS = DEVUTILS_ALGORITHMS.map((a) => a.value);

export interface DevUtilsStep {
  action: "checksums" | "encode";
  format: "sidecar" | "csv";
  algorithms: string[];
  encoding: "base64" | "hex";
  name: string;
}

/** Mirrors modules/devutils DefaultStepOptions(). */
export const DEFAULT_DEVUTILS_STEP: DevUtilsStep = {
  action: "checksums",
  format: "sidecar",
  algorithms: ["sha256", "sha1", "md5"],
  encoding: "base64",
  name: "",
};

export function parseDevUtilsStep(json: string): DevUtilsStep {
  const r = parseObject(json);
  const d = DEFAULT_DEVUTILS_STEP;
  const algos = Array.isArray(r.algorithms) ? r.algorithms.filter((a): a is string => typeof a === "string" && (ALGO_IDS as readonly string[]).includes(a)) : d.algorithms;
  return {
    ...r,
    action: oneOf(r.action, ["checksums", "encode"] as const, d.action),
    format: oneOf(r.format, ["sidecar", "csv"] as const, d.format),
    algorithms: [...new Set(algos)],
    encoding: oneOf(r.encoding, ["base64", "hex"] as const, d.encoding),
    name: str(r.name, d.name),
  };
}

function DevUtilsEditor({ value, onChange, vars }: StepEditorProps<DevUtilsStep>) {
  const set = (patch: Partial<DevUtilsStep>) => onChange({ ...value, ...patch });
  const toggle = (id: string, on: boolean) => {
    const next = on ? [...value.algorithms, id] : value.algorithms.filter((a) => a !== id);
    set({ algorithms: ALGO_IDS.filter((a) => next.includes(a)) });
  };
  return (
    <div className={styles.stack}>
      <SegmentedControl
        aria-label="Action"
        value={value.action}
        options={[
          { value: "checksums", label: "Checksums" },
          { value: "encode", label: "Encode" },
        ]}
        onChange={(action) => set({ action })}
      />
      {value.action === "checksums" ? (
        <>
          <div className={styles.row} role="group" aria-label="Algorithms">
            {DEVUTILS_ALGORITHMS.map((a) => (
              <Switch key={a.value} label={a.label} checked={value.algorithms.includes(a.value)} onChange={(on) => toggle(a.value, on)} />
            ))}
          </div>
          {value.algorithms.length === 0 && <p className={styles.warn}>Pick at least one algorithm.</p>}
          <Field label="Save as">
            <SegmentedControl
              aria-label="Save as"
              value={value.format}
              options={[
                { value: "sidecar", label: "One file each" },
                { value: "csv", label: "One CSV" },
              ]}
              onChange={(format) => set({ format })}
            />
          </Field>
          <TemplateField label="File name (optional)" value={value.name} vars={vars} placeholder="The file's name" onChange={(name) => set({ name })} />
        </>
      ) : (
        <>
          <Field label="Encoding">
            <SegmentedControl
              aria-label="Encoding"
              value={value.encoding}
              options={[
                { value: "base64", label: "Base64" },
                { value: "hex", label: "Hex" },
              ]}
              onChange={(encoding) => set({ encoding })}
            />
          </Field>
          <p className={styles.hint}>Each file becomes a text file. Files up to 10 MiB.</p>
        </>
      )}
    </div>
  );
}

// ---------- Post Builder ("post-builder") ----------

export interface PostStep {
  format: "auto" | "carousel" | "reel" | "story";
  aspect: "4:5" | "1:1" | "3:4" | "1.91:1";
  name: string;
  caption: string;
  keepLocation: boolean;
}

/** Mirrors modules/posts DefaultStepOptions(). */
export const DEFAULT_POST_STEP: PostStep = { format: "auto", aspect: "4:5", name: "{item}", caption: "", keepLocation: false };

export function parsePostStep(json: string): PostStep {
  const r = parseObject(json);
  const d = DEFAULT_POST_STEP;
  return {
    ...r,
    format: oneOf(r.format, ["auto", "carousel", "reel", "story"] as const, d.format),
    aspect: oneOf(r.aspect, ["4:5", "1:1", "3:4", "1.91:1"] as const, d.aspect),
    name: str(r.name, d.name),
    caption: str(r.caption, d.caption),
    keepLocation: bool(r.keepLocation, d.keepLocation),
  };
}

const MAX_CAPTION = 2200;

function PostEditor({ value, onChange, vars }: StepEditorProps<PostStep>) {
  const set = (patch: Partial<PostStep>) => onChange({ ...value, ...patch });
  return (
    <div className={styles.stack}>
      <Field label="Make a">
        {(c) => (
          <Select
            {...c}
            value={value.format}
            options={[
              { value: "auto", label: "Reel for one video, otherwise carousel" },
              { value: "carousel", label: "Carousel" },
              { value: "reel", label: "Reel" },
              { value: "story", label: "Story" },
            ]}
            onChange={(format) => set({ format })}
          />
        )}
      </Field>
      {(value.format === "auto" || value.format === "carousel") && (
        <Field label="Carousel shape">
          <SegmentedControl
            aria-label="Carousel shape"
            value={value.aspect}
            options={[
              { value: "4:5", label: "4:5" },
              { value: "1:1", label: "1:1" },
              { value: "3:4", label: "3:4" },
              { value: "1.91:1", label: "1.91:1" },
            ]}
            onChange={(aspect) => set({ aspect })}
          />
        </Field>
      )}
      <TemplateField label="Post name" value={value.name} vars={vars} placeholder="{item}" onChange={(name) => set({ name })} />
      <TemplateField
        label="Caption"
        multiline
        minRows={3}
        value={value.caption}
        vars={vars}
        error={value.caption.length > MAX_CAPTION ? "The caption is too long (2,200 characters at most)" : undefined}
        placeholder="Optional, e.g. {reply}"
        onChange={(caption) => set({ caption })}
      />
      <Switch
        label="Keep location and metadata"
        checked={value.keepLocation}
        tip="Off: the exported post strips location and metadata from the photos"
        onChange={(keepLocation) => set({ keepLocation })}
      />
    </div>
  );
}

// ---------- Clipboard History ("clipboard"): Copy to clipboard ----------

export interface ClipboardStep {
  text: string;
}

export function parseClipboardStep(json: string): ClipboardStep {
  const r = parseObject(json);
  return { ...r, text: str(r.text, "") };
}

function ClipboardEditor({ value, onChange, vars }: StepEditorProps<ClipboardStep>) {
  return (
    <div className={styles.stack}>
      <TemplateField
        label="Text to copy"
        multiline
        minRows={3}
        value={value.text}
        vars={vars}
        placeholder="Leave empty to copy the first text file"
        onChange={(text) => onChange({ ...value, text })}
      />
      <p className={styles.hint}>
        {value.text.trim() ? "Copies this text (up to 256 KiB), with the variables filled in." : "Copies the first .txt or .md file the step receives."}
      </p>
    </div>
  );
}

// ---------- Object Eraser ("object-eraser") ----------

/** Mirrors modules/eraser DefaultStepOptions(). */
export const DEFAULT_ERASER_STEP: EraserStepOptions = { model: EraserModel.ModelBest, maskId: "" };

export function parseEraserStep(json: string): EraserStepOptions {
  const r = parseObject(json);
  return {
    ...r,
    model: oneOf(r.model, [EraserModel.ModelBest, EraserModel.ModelFast] as const, DEFAULT_ERASER_STEP.model),
    maskId: str(r.maskId, ""),
  };
}

function EraserEditor({ value, onChange }: StepEditorProps<EraserStepOptions>) {
  const masks = useLoadedList<EraserSavedMask>(() => EraserService.SavedMasks());
  const options = useMemo(() => {
    const list = masks.items.map((m) => ({ value: m.id, label: `${m.name} (${m.width}×${m.height})` }));
    const missing = value.maskId !== "" && !masks.loading && !masks.items.some((m) => m.id === value.maskId);
    return [
      { value: "", label: masks.loading ? "Loading…" : "Pick a saved mask" },
      ...(missing ? [{ value: value.maskId, label: "(this mask is gone)" }] : []),
      ...list,
    ];
  }, [masks.items, masks.loading, value.maskId]);
  return (
    <div className={styles.stack}>
      <Field label="Saved mask">{(c) => <Select {...c} value={value.maskId} options={options} onChange={(maskId) => onChange({ ...value, maskId })} />}</Field>
      {!masks.loading && masks.items.length === 0 && (
        <p className={styles.hint}>No saved masks yet. In Object Eraser, paint over the object and choose “Save mask for pipelines…”.</p>
      )}
      <Field label="Model">
        <SegmentedControl
          aria-label="Model"
          value={value.model}
          options={[
            { value: EraserModel.ModelBest, label: "Best" },
            { value: EraserModel.ModelFast, label: "Fast" },
          ]}
          onChange={(model) => onChange({ ...value, model })}
        />
      </Field>
      <p className={styles.hint}>Erases the masked area from every photo of the same shape as the mask.</p>
    </div>
  );
}

// ---------- Run another pipeline ("pipelines") ----------

export function parseRunStep(json: string): PipelineRunStep {
  const r = parseObject(json);
  return { ...r, pipelineId: str(r.pipelineId, "") };
}

function RunEditor({ value, onChange }: StepEditorProps<PipelineRunStep>) {
  const current = useCurrentPipelineId();
  const entries = usePipelines((s) => s.entries);
  const options = useMemo(() => {
    const others = entries.filter((e) => e.pipeline.id !== current).map((e) => ({ value: e.pipeline.id, label: e.pipeline.name || "Untitled pipeline" }));
    const missing = value.pipelineId !== "" && !entries.some((e) => e.pipeline.id === value.pipelineId);
    return [{ value: "", label: "Pick a pipeline" }, ...(missing ? [{ value: value.pipelineId, label: "(this pipeline is gone)" }] : []), ...others];
  }, [entries, current, value.pipelineId]);
  return (
    <div className={styles.stack}>
      <Field label="Pipeline">{(c) => <Select {...c} value={value.pipelineId} options={options} onChange={(pipelineId) => onChange({ ...value, pipelineId })} />}</Field>
      <p className={styles.hint}>
        Runs it on these files and carries on with what it keeps. A pipeline can&apos;t run itself, directly or through others.
      </p>
    </div>
  );
}

registerSteps([
  ui("dev-utils", parseDevUtilsStep, DevUtilsEditor),
  ui("post-builder", parsePostStep, PostEditor),
  ui("clipboard", parseClipboardStep, ClipboardEditor),
  ui("object-eraser", parseEraserStep, EraserEditor),
  ui("pipelines", parseRunStep, RunEditor),
]);
