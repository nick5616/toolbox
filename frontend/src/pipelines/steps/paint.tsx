import { useMemo } from "react";
import { Field } from "@/components/Field";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Select } from "@/components/Select";
import { Slider } from "@/components/Slider";
import { Stepper } from "@/components/Stepper";
import { EraserService, PaintService, PaintStepAction, type EraserSavedMask, type PaintStepOptions, type ProjectInfo } from "@/lib/api";
import { useLoadedList } from "./context";
import { num, oneOf, str, ui } from "./phase14";
import { parseObject, registerSteps, type StepEditorProps } from "./registry";
import styles from "./phase14.module.css";

// Paint+'s pipeline step (Phase 19, SPEC §2.7): draw a saved painting over
// each picture, or Dissolve each picture with a mask.

/** Mirrors modules/paint DefaultStepOptions(). */
export const DEFAULT_PAINT_STEP: PaintStepOptions = {
  action: PaintStepAction.StepOverlay,
  project: "",
  layer: "",
  mask: "",
  fit: "contain",
  passes: 6,
  ghost: 0.3,
  drift: 0.5,
  seed: 1,
  model: "fast",
};

const FITS = ["contain", "cover", "stretch"] as const;
const MODELS = ["fast", "best"] as const;

export function parsePaintStep(json: string): PaintStepOptions {
  const r = parseObject(json);
  const d = DEFAULT_PAINT_STEP;
  return {
    ...r,
    action: oneOf(r.action, [PaintStepAction.StepOverlay, PaintStepAction.StepDissolve] as const, d.action),
    project: str(r.project, ""),
    layer: str(r.layer, ""),
    mask: str(r.mask, ""),
    fit: oneOf(r.fit, FITS, "contain"),
    passes: Math.round(Math.min(12, Math.max(1, num(r.passes, d.passes)))),
    ghost: Math.min(1, Math.max(0, num(r.ghost, d.ghost))),
    drift: Math.min(1, Math.max(0, num(r.drift, d.drift))),
    seed: Math.round(num(r.seed, d.seed)),
    model: oneOf(r.model, MODELS, "fast"),
  };
}

function projectOptions(items: readonly ProjectInfo[], loading: boolean, selected: string) {
  const missing = selected !== "" && !loading && !items.some((p) => p.id === selected);
  return [
    { value: "", label: loading ? "Loading…" : "Pick a painting" },
    ...(missing ? [{ value: selected, label: "(this painting is gone)" }] : []),
    ...items.map((p) => ({ value: p.id, label: p.name || "Untitled" })),
  ];
}

function PaintEditor({ value, onChange }: StepEditorProps<PaintStepOptions>) {
  const projects = useLoadedList<ProjectInfo>(() => PaintService.Projects());
  const masks = useLoadedList<EraserSavedMask>(() => EraserService.SavedMasks());
  const projectOpts = useMemo(() => projectOptions(projects.items, projects.loading, value.project), [projects.items, projects.loading, value.project]);
  const maskOpts = useMemo(
    () => [{ value: "", label: masks.loading ? "Loading…" : "Use a layer of the painting" }, ...masks.items.map((m) => ({ value: m.id, label: `Saved mask: ${m.name}` }))],
    [masks.items, masks.loading],
  );
  const dissolve = value.action === PaintStepAction.StepDissolve;
  return (
    <div className={styles.stack}>
      <Field label="What it does">
        <SegmentedControl
          aria-label="What it does"
          value={value.action}
          options={[
            { value: PaintStepAction.StepOverlay, label: "Draw over", tip: "Draw a saved painting's visible layers over each picture" },
            { value: PaintStepAction.StepDissolve, label: "Dissolve", tip: "Fill a masked area again and again, so it dissolves into its surroundings" },
          ]}
          onChange={(action) => onChange({ ...value, action })}
        />
      </Field>
      <Field label="Painting">{(c) => <Select {...c} value={value.project} options={projectOpts} onChange={(project) => onChange({ ...value, project })} />}</Field>
      {dissolve ? (
        <>
          <Field label="Mask">{(c) => <Select {...c} value={value.mask} options={maskOpts} onChange={(mask) => onChange({ ...value, mask })} />}</Field>
          {value.mask === "" && (
            <p className={styles.hint}>The painting&apos;s layer named “Mask” (or its top layer) marks what dissolves.</p>
          )}
          <Field label="Passes">{(c) => <Stepper {...c} value={value.passes} min={1} max={12} onChange={(passes) => onChange({ ...value, passes })} />}</Field>
          <Field label="Ghost">{(c) => <Slider {...c} min={0} max={100} value={Math.round(value.ghost * 100)} format={(v) => `${v}%`} onChange={(v) => onChange({ ...value, ghost: v / 100 })} />}</Field>
          <Field label="Drift">{(c) => <Slider {...c} min={0} max={100} value={Math.round(value.drift * 100)} format={(v) => `${v}`} onChange={(v) => onChange({ ...value, drift: v / 100 })} />}</Field>
          <Field label="Fill">
            <SegmentedControl
              aria-label="Fill"
              value={value.model}
              options={[
                { value: "fast", label: "Fast" },
                { value: "best", label: "Best" },
              ]}
              onChange={(model) => onChange({ ...value, model })}
            />
          </Field>
        </>
      ) : (
        <Field label="Fit">
          <SegmentedControl
            aria-label="Fit"
            value={value.fit}
            options={FITS.map((f) => ({ value: f, label: f[0]!.toUpperCase() + f.slice(1) }))}
            onChange={(fit) => onChange({ ...value, fit })}
          />
        </Field>
      )}
      {!projects.loading && projects.items.length === 0 && <p className={styles.hint}>No paintings yet. Make one in Paint+ first.</p>}
    </div>
  );
}

registerSteps([ui("paint", parsePaintStep, PaintEditor)]);
