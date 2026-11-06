import { useEffect, useState } from "react";
import { ColorSwatchPicker } from "@/components/ColorSwatchPicker";
import { Field } from "@/components/Field";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Select } from "@/components/Select";
import { Stepper } from "@/components/Stepper";
import { Switch } from "@/components/Switch";
import { TemplateField } from "@/components/TemplateField";
import { BatchCorner, BatchFit, BatchFormat, BatchResize, BatchWatermarkKind, ImageBatchService, type ImageBatchStepOptions } from "@/lib/api";
import { ASPECTS, DEFAULT_BATCH_OPTIONS, FALLBACK_FONTS, SIDE_LIMITS, sanitizeBatchOptions } from "@/tools/imagebatch/options";
import { ui } from "./phase14";
import { parseObject, registerSteps, type StepEditorProps } from "./registry";
import styles from "./phase14.module.css";

// Step editor of Image Batch ("imagebatch"), Phase 15. parse() keeps unknown
// fields and clamps everything to what Go accepts.

/** Mirrors modules/imagebatch DefaultStepOptions(). */
export const DEFAULT_IMAGEBATCH_STEP: ImageBatchStepOptions = { ...DEFAULT_BATCH_OPTIONS };

export function parseImageBatchStep(json: string): ImageBatchStepOptions {
  const r = parseObject(json);
  return { ...r, ...sanitizeBatchOptions(r, DEFAULT_IMAGEBATCH_STEP) };
}

function ImageBatchEditor({ value, onChange, vars }: StepEditorProps<ImageBatchStepOptions>) {
  const set = (patch: Partial<ImageBatchStepOptions>) => onChange({ ...value, ...patch });
  const setMark = (patch: Partial<ImageBatchStepOptions["watermark"]>) => onChange({ ...value, watermark: { ...value.watermark, ...patch } });
  const [fonts, setFonts] = useState<string[]>([...FALLBACK_FONTS]);
  useEffect(() => {
    let cancelled = false;
    ImageBatchService.Fonts()
      .then((f) => !cancelled && f && f.length > 0 && setFonts(f))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const wm = value.watermark;
  const padded = value.fit === BatchFit.FitPad && (value.aspect !== "" || value.resize === BatchResize.ResizeExact);
  return (
    <div className={styles.stack}>
      <Field label="Size">
        <SegmentedControl
          aria-label="Size"
          value={value.resize}
          options={[
            { value: BatchResize.ResizeLongSide, label: "Long side" },
            { value: BatchResize.ResizeExact, label: "Exact size" },
            { value: BatchResize.ResizeKeep, label: "Keep size" },
          ]}
          onChange={(resize) => set({ resize })}
        />
      </Field>
      {value.resize === BatchResize.ResizeLongSide && (
        <Field label="Long side">
          {(c) => <Stepper id={c.id} aria-label="Long side" value={value.longSide} min={SIDE_LIMITS.min} max={SIDE_LIMITS.max} step={128} unit="px" onChange={(longSide) => set({ longSide })} />}
        </Field>
      )}
      {value.resize === BatchResize.ResizeExact && (
        <div className={styles.pair}>
          <Field label="Width">{(c) => <Stepper id={c.id} aria-label="Width" value={value.width} min={1} max={SIDE_LIMITS.max} step={10} unit="px" onChange={(width) => set({ width })} />}</Field>
          <Field label="Height">{(c) => <Stepper id={c.id} aria-label="Height" value={value.height} min={1} max={SIDE_LIMITS.max} step={10} unit="px" onChange={(height) => set({ height })} />}</Field>
        </div>
      )}
      {value.resize !== BatchResize.ResizeExact && (
        <Field label="Shape">
          {(c) => <Select {...c} value={value.aspect} options={[{ value: "", label: "Keep each picture's own" }, ...ASPECTS.map((a) => ({ value: a as string, label: a }))]} onChange={(aspect) => set({ aspect })} />}
        </Field>
      )}
      {(value.aspect !== "" || value.resize === BatchResize.ResizeExact) && (
        <Field label="Different shape">
          <SegmentedControl
            aria-label="Different shape"
            value={value.fit}
            options={[
              { value: BatchFit.FitCrop, label: "Crop" },
              { value: BatchFit.FitPad, label: "Pad" },
            ]}
            onChange={(fit) => set({ fit })}
          />
        </Field>
      )}
      {padded && (
        <Field label="Pad colour">
          <ColorSwatchPicker aria-label="Pad colour" value={value.background} allowTransparent onChange={(background) => set({ background })} />
        </Field>
      )}
      <Field label="Format">
        <SegmentedControl
          aria-label="Format"
          value={value.format}
          options={[
            { value: BatchFormat.FormatJPG, label: "JPEG" },
            { value: BatchFormat.FormatPNG, label: "PNG" },
            { value: BatchFormat.FormatWebP, label: "WebP" },
            { value: BatchFormat.FormatSame, label: "Same" },
          ]}
          onChange={(format) => set({ format })}
        />
      </Field>
      {value.format !== BatchFormat.FormatPNG && (
        <Field label="Quality">
          {(c) => <Stepper id={c.id} aria-label="Quality" value={value.quality} min={1} max={100} step={5} onChange={(quality) => set({ quality })} />}
        </Field>
      )}
      <Field label="Watermark">
        <SegmentedControl
          aria-label="Watermark"
          value={wm.kind}
          options={[
            { value: BatchWatermarkKind.WatermarkNone, label: "None" },
            { value: BatchWatermarkKind.WatermarkText, label: "Text" },
            { value: BatchWatermarkKind.WatermarkLogo, label: "Logo" },
          ]}
          onChange={(kind) => setMark({ kind })}
        />
      </Field>
      {wm.kind === BatchWatermarkKind.WatermarkText && (
        <>
          <TemplateField label="Watermark text" value={wm.text} vars={vars} placeholder="© {project}" onChange={(text) => setMark({ text })} />
          <div className={styles.pair}>
            <Field label="Font">{(c) => <Select {...c} value={wm.font} options={fonts.map((f) => ({ value: f, label: f }))} onChange={(font) => setMark({ font })} />}</Field>
            <Field label="Colour">
              <ColorSwatchPicker aria-label="Text colour" value={wm.color} onChange={(color) => setMark({ color })} />
            </Field>
          </div>
        </>
      )}
      {wm.kind === BatchWatermarkKind.WatermarkLogo && (
        <TemplateField label="Logo file" value={wm.logo} vars={vars} placeholder="Path of a PNG logo" onChange={(logo) => setMark({ logo })} />
      )}
      {wm.kind !== BatchWatermarkKind.WatermarkNone && (
        <div className={styles.pair}>
          <Field label="Corner">
            {(c) => (
              <Select
                {...c}
                value={wm.corner}
                options={[
                  { value: BatchCorner.CornerBottomRight, label: "Bottom right" },
                  { value: BatchCorner.CornerBottomLeft, label: "Bottom left" },
                  { value: BatchCorner.CornerTopRight, label: "Top right" },
                  { value: BatchCorner.CornerTopLeft, label: "Top left" },
                  { value: BatchCorner.CornerCenter, label: "Centre" },
                ]}
                onChange={(corner) => setMark({ corner })}
              />
            )}
          </Field>
          <Field label="Opacity">
            {(c) => <Stepper id={c.id} aria-label="Opacity" value={Math.round(wm.opacity * 100)} min={5} max={100} step={5} unit="%" onChange={(p) => setMark({ opacity: p / 100 })} />}
          </Field>
        </div>
      )}
      <Switch checked={value.strip} onChange={(strip) => set({ strip })} label="Strip metadata" />
      <TemplateField label="File name" value={value.name} vars={vars} placeholder="{name}" onChange={(name) => set({ name })} />
      <p className={styles.hint}>{"{name}"} is each picture's own name, {"{n}"} a running number and {"{date}"} today's date.</p>
    </div>
  );
}

export const imagebatchSteps = [ui("imagebatch", parseImageBatchStep, ImageBatchEditor)];

registerSteps(imagebatchSteps);
