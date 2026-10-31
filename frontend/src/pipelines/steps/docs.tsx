import {
  BgModel,
  BgOutput,
  ExifAction,
  PdfAction,
  UpscaleDevice,
  UpscaleFormat,
  UpscaleModel,
  type BgRemoveOptions,
  type ExifOptions,
  type PdfStepOptions,
  type UpscaleOptions,
  type VaultStepOptions,
} from "@/lib/api";
import { ColorSwatchPicker } from "@/components/ColorSwatchPicker";
import { Field } from "@/components/Field";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Select } from "@/components/Select";
import { Stepper } from "@/components/Stepper";
import { Switch } from "@/components/Switch";
import { TemplateField } from "@/components/TemplateField";
import { DEFAULT_BG_OPTIONS, sanitizeBgOptions } from "@/tools/bgremove/options";
import { FIELD_HINTS, FIELD_LABELS, DEFAULT_EDITABLE_FIELDS } from "@/tools/exif/options";
import { DEFAULT_UPSCALE_OPTIONS, sanitizeUpscaleOptions } from "@/tools/upscale/options";
import { parseObject, registerSteps, type StepEditorProps, type StepUI } from "./registry";
import styles from "./docs.module.css";

// Step editors owned by WP-AD3 (pdf, vault, bg-remover, upscaler, exif).

function pick<T extends string | number>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((a) => a === v) ?? fallback;
}

// ---------- PDF Toolkit ----------

const PDF_STEP_ACTIONS = [
  PdfAction.ActionMerge,
  PdfAction.ActionSplit,
  PdfAction.ActionCompress,
  PdfAction.ActionImagesToPDF,
  PdfAction.ActionPDFToImages,
  PdfAction.ActionProtect,
  PdfAction.ActionUnlock,
] as const;

const PDF_ACTION_OPTIONS = [
  { value: PdfAction.ActionMerge, label: "Merge into one PDF" },
  { value: PdfAction.ActionSplit, label: "Split a PDF" },
  { value: PdfAction.ActionCompress, label: "Compress a PDF" },
  { value: PdfAction.ActionImagesToPDF, label: "Photos to one PDF" },
  { value: PdfAction.ActionPDFToImages, label: "PDF pages to images" },
  { value: PdfAction.ActionProtect, label: "Add a password" },
  { value: PdfAction.ActionUnlock, label: "Remove the password" },
];

export const DEFAULT_PDF_STEP: PdfStepOptions = {
  action: PdfAction.ActionMerge,
  every: 1,
  level: "balanced",
  pageSize: "a4",
  margin: "small",
  imageFormat: "png",
  dpi: 150,
};

export function parsePdfStep(json: string): PdfStepOptions {
  const r = parseObject(json);
  const d = DEFAULT_PDF_STEP;
  return {
    action: pick(r.action, PDF_STEP_ACTIONS, d.action),
    every: typeof r.every === "number" && Number.isInteger(r.every) && r.every >= 1 ? r.every : d.every,
    level: pick(r.level, ["small", "balanced", "high"] as const, d.level),
    pageSize: pick(r.pageSize, ["a4", "letter", "fit"] as const, d.pageSize),
    margin: pick(r.margin, ["none", "small"] as const, d.margin),
    imageFormat: pick(r.imageFormat, ["png", "jpg"] as const, d.imageFormat),
    dpi: pick(r.dpi, [72, 150, 300] as const, d.dpi),
  };
}

function PdfEditor({ value, onChange }: StepEditorProps<PdfStepOptions>) {
  const set = (patch: Partial<PdfStepOptions>) => onChange({ ...value, ...patch });
  return (
    <div className={styles.stack}>
      <Field label="What to do">
        {(c) => <Select {...c} value={value.action} options={PDF_ACTION_OPTIONS} onChange={(action) => set({ action })} />}
      </Field>
      {value.action === PdfAction.ActionMerge && (
        <p className={styles.note}>Joins the PDFs of every item, in order, into one file. A single PDF passes through unchanged.</p>
      )}
      {value.action === PdfAction.ActionSplit && (
        <Field label="Pages per file">
          {(c) => <Stepper id={c.id} aria-label="Pages per file" value={value.every} min={1} max={10000} onChange={(every) => set({ every })} />}
        </Field>
      )}
      {value.action === PdfAction.ActionCompress && (
        <Field label="Compression" hint="A PDF that can't get meaningfully smaller passes through unchanged.">
          {(c) => (
            <Select
              {...c}
              value={value.level}
              options={[
                { value: "small", label: "Smallest file" },
                { value: "balanced", label: "Balanced" },
                { value: "high", label: "Best quality" },
              ]}
              onChange={(level) => set({ level })}
            />
          )}
        </Field>
      )}
      {value.action === PdfAction.ActionImagesToPDF && (
        <>
          <Field label="Page size">
            {(c) => (
              <Select
                {...c}
                value={value.pageSize}
                options={[
                  { value: "a4", label: "A4" },
                  { value: "letter", label: "US Letter" },
                  { value: "fit", label: "Fit to each image" },
                ]}
                onChange={(pageSize) => set({ pageSize })}
              />
            )}
          </Field>
          <Field label="Margin">
            <SegmentedControl
              aria-label="Margin"
              value={value.margin}
              options={[
                { value: "none", label: "None" },
                { value: "small", label: "Small" },
              ]}
              onChange={(margin) => set({ margin })}
            />
          </Field>
        </>
      )}
      {value.action === PdfAction.ActionPDFToImages && (
        <div className={styles.row}>
          <Field label="Format">
            <SegmentedControl
              aria-label="Image format"
              value={value.imageFormat}
              options={[
                { value: "png", label: "PNG" },
                { value: "jpg", label: "JPG" },
              ]}
              onChange={(imageFormat) => set({ imageFormat })}
            />
          </Field>
          <Field label="Resolution">
            <SegmentedControl
              aria-label="Resolution"
              value={String(value.dpi)}
              options={[
                { value: "72", label: "72 dpi" },
                { value: "150", label: "150 dpi" },
                { value: "300", label: "300 dpi" },
              ]}
              onChange={(dpi) => set({ dpi: Number(dpi) })}
            />
          </Field>
        </div>
      )}
      {(value.action === PdfAction.ActionProtect || value.action === PdfAction.ActionUnlock) && (
        <p className={styles.note}>The password is asked when the run starts. It is kept in memory only, never saved.</p>
      )}
    </div>
  );
}

// ---------- Vault ----------

export const DEFAULT_VAULT_STEP: VaultStepOptions = { folder: "" };

export function parseVaultStep(json: string): VaultStepOptions {
  const r = parseObject(json);
  return { folder: typeof r.folder === "string" ? r.folder : "" };
}

function VaultEditor({ value, onChange, vars, check }: StepEditorProps<VaultStepOptions>) {
  return (
    <div className={styles.stack}>
      <TemplateField
        label="Folder in the Vault"
        value={value.folder}
        vars={vars}
        placeholder="Leave empty for the top level"
        onChange={(folder) => onChange({ folder })}
      />
      <p className={styles.note}>
        Files are copied in, encrypted; the originals stay where they are. The run waits while the Vault is locked.
      </p>
      {check?.problems?.map((p) => (
        <p key={p} className={styles.note} role="alert">
          {p}
        </p>
      ))}
    </div>
  );
}

// ---------- Background Remover ----------

export function parseBgStep(json: string): BgRemoveOptions {
  return sanitizeBgOptions(parseObject(json), DEFAULT_BG_OPTIONS);
}

function BgEditor({ value, onChange }: StepEditorProps<BgRemoveOptions>) {
  const set = (patch: Partial<BgRemoveOptions>) => onChange({ ...value, ...patch });
  return (
    <div className={styles.stack}>
      <Field label="Quality">
        <SegmentedControl
          aria-label="Quality"
          value={value.model}
          options={[
            { value: BgModel.ModelFast, label: "Fast" },
            { value: BgModel.ModelBalanced, label: "Balanced" },
            { value: BgModel.ModelBest, label: "Best" },
          ]}
          onChange={(model) => set({ model })}
        />
      </Field>
      <Field label="Result">
        <SegmentedControl
          aria-label="Result"
          value={value.output}
          options={[
            { value: BgOutput.OutputTransparent, label: "Transparent" },
            { value: BgOutput.OutputColor, label: "Solid colour" },
            { value: BgOutput.OutputMask, label: "Mask only" },
          ]}
          onChange={(output) => set({ output })}
        />
      </Field>
      {value.output === BgOutput.OutputColor && (
        <Field label="Background colour">
          <ColorSwatchPicker aria-label="Background colour" value={value.color} onChange={(color) => set({ color })} />
        </Field>
      )}
      {value.output !== BgOutput.OutputMask && (
        <>
          <Switch label="Crop to the subject" checked={value.crop} onChange={(crop) => set({ crop })} />
          {value.crop && (
            <Field label="Padding">
              {(c) => <Stepper id={c.id} aria-label="Padding" value={value.padding} min={0} max={500} unit="px" onChange={(padding) => set({ padding })} />}
            </Field>
          )}
          <Switch label="Clean edge colours" checked={value.cleanEdges} onChange={(cleanEdges) => set({ cleanEdges })} />
          <Switch label="Refine edges" checked={value.refine} onChange={(refine) => set({ refine })} />
        </>
      )}
    </div>
  );
}

// ---------- Upscaler ----------

export function parseUpscaleStep(json: string): UpscaleOptions {
  return sanitizeUpscaleOptions(parseObject(json), DEFAULT_UPSCALE_OPTIONS);
}

function UpscaleEditor({ value, onChange }: StepEditorProps<UpscaleOptions>) {
  const set = (patch: Partial<UpscaleOptions>) => onChange({ ...value, ...patch });
  return (
    <div className={styles.stack}>
      <Field label="Kind of image">
        <SegmentedControl
          aria-label="Kind of image"
          value={value.model}
          options={[
            { value: UpscaleModel.ModelPhoto, label: "Photo" },
            { value: UpscaleModel.ModelIllustration, label: "Illustration" },
            { value: UpscaleModel.ModelFast, label: "Fast" },
          ]}
          onChange={(model) => set({ model })}
        />
      </Field>
      <div className={styles.row}>
        <Field label="Scale">
          <SegmentedControl
            aria-label="Scale"
            value={String(value.scale)}
            options={[
              { value: "2", label: "2×" },
              { value: "4", label: "4×" },
            ]}
            onChange={(s) => set({ scale: Number(s) })}
          />
        </Field>
        <Field label="Save as">
          {(c) => (
            <Select
              {...c}
              value={value.format}
              options={[
                { value: UpscaleFormat.FormatSame, label: "Same as the original" },
                { value: UpscaleFormat.FormatPNG, label: "PNG" },
                { value: UpscaleFormat.FormatJPG, label: "JPG" },
                { value: UpscaleFormat.FormatWebP, label: "WebP" },
              ]}
              onChange={(format) => set({ format })}
            />
          )}
        </Field>
      </div>
      <Field label="Runs on">
        {(c) => (
          <Select
            {...c}
            value={value.device}
            options={[
              { value: UpscaleDevice.DeviceAuto, label: "Automatic" },
              { value: UpscaleDevice.DeviceGPU, label: "GPU" },
              { value: UpscaleDevice.DeviceCPU, label: "CPU (slower)" },
            ]}
            onChange={(device) => set({ device })}
          />
        )}
      </Field>
      <p className={styles.note}>An image that is too large for the chosen scale fails with a message instead of being upscaled.</p>
    </div>
  );
}

// ---------- EXIF ----------

export const DEFAULT_EXIF_STEP: ExifOptions = {
  action: ExifAction.ActionStripLocation,
  keepOrientation: true,
  fields: {},
};

export function parseExifStep(json: string): ExifOptions {
  const r = parseObject(json);
  const fields: Record<string, string> = {};
  if (typeof r.fields === "object" && r.fields !== null && !Array.isArray(r.fields)) {
    for (const [k, v] of Object.entries(r.fields)) {
      if (DEFAULT_EDITABLE_FIELDS.includes(k) && typeof v === "string") fields[k] = v;
    }
  }
  return {
    action: pick(r.action, [ExifAction.ActionStripLocation, ExifAction.ActionStripAll, ExifAction.ActionEdit] as const, DEFAULT_EXIF_STEP.action),
    keepOrientation: typeof r.keepOrientation === "boolean" ? r.keepOrientation : DEFAULT_EXIF_STEP.keepOrientation,
    fields,
  };
}

function ExifEditor({ value, onChange, vars }: StepEditorProps<ExifOptions>) {
  const fields = value.fields ?? {};
  const setField = (name: string, on: boolean, text?: string) => {
    const next = { ...fields };
    if (!on) delete next[name];
    else next[name] = text ?? next[name] ?? "";
    onChange({ ...value, fields: next });
  };
  return (
    <div className={styles.stack}>
      <SegmentedControl
        aria-label="What to do"
        value={value.action}
        options={[
          { value: ExifAction.ActionStripLocation, label: "Strip location" },
          { value: ExifAction.ActionStripAll, label: "Strip all" },
          { value: ExifAction.ActionEdit, label: "Edit fields" },
        ]}
        onChange={(action) => onChange({ ...value, action })}
      />
      {value.action === ExifAction.ActionStripLocation && (
        <p className={styles.note}>Removes GPS position and place names. Everything else stays.</p>
      )}
      {value.action === ExifAction.ActionStripAll && (
        <>
          <p className={styles.note}>Removes all metadata from a copy of each photo.</p>
          <Switch
            label="Keep orientation and colour profile"
            checked={value.keepOrientation}
            onChange={(keepOrientation) => onChange({ ...value, keepOrientation })}
          />
        </>
      )}
      {value.action === ExifAction.ActionEdit && (
        <div className={styles.stack}>
          {DEFAULT_EDITABLE_FIELDS.map((name) => {
            const on = name in fields;
            const label = FIELD_LABELS[name] ?? name;
            return (
              <div key={name} className={styles.fieldRow}>
                <Switch label={`Set ${label.toLowerCase()}`} checked={on} onChange={(v) => setField(name, v)} />
                {on && (
                  <>
                    <TemplateField label={label} value={fields[name] ?? ""} vars={vars} onChange={(text) => setField(name, true, text)} />
                    <p className={styles.hint}>{[FIELD_HINTS[name], "Leave empty to remove it."].filter(Boolean).join(" ")}</p>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const ui = <T,>(type: string, parse: (json: string) => T, Editor: StepUI<T>["Editor"]): StepUI<never> =>
  ({ type, parse, Editor }) as unknown as StepUI<never>;

registerSteps([
  ui("pdf", parsePdfStep, PdfEditor),
  ui("vault", parseVaultStep, VaultEditor),
  ui("bg-remover", parseBgStep, BgEditor),
  ui("upscaler", parseUpscaleStep, UpscaleEditor),
  ui("exif", parseExifStep, ExifEditor),
]);
