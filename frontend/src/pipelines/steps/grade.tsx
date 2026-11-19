import { useEffect, useMemo, useState } from "react";
import { Field } from "@/components/Field";
import { Select } from "@/components/Select";
import { Slider } from "@/components/Slider";
import { TemplateField } from "@/components/TemplateField";
import { GradeService, type GradeServiceRecipe, type GradeStepOptions } from "@/lib/api";
import { builtInLook, builtInLooks } from "@/tools/grade/builtins";
import { toService } from "@/tools/grade/recipe";
import { num, oneOf, str, ui } from "./phase14";
import { parseObject, registerSteps, type StepEditorProps } from "./registry";
import styles from "./phase14.module.css";

// Color Grader's step "Grade with a look" ("grade"), Phase 21 SPEC §E1.
// Picking a look also stores the resolved recipe in a hidden `recipe` option,
// so the step renders the same look even if a saved look is renamed later.

/**
 * The step's options with the hidden resolved look. (G2 adds `recipe` to
 * `StepOptions`; until the bindings carry it this extends them locally.)
 */
export type GradeStep = GradeStepOptions & { recipe?: GradeServiceRecipe };

/** Mirrors modules/grade DefaultStepOptions(). */
export const DEFAULT_GRADE_STEP: GradeStepOptions = { look: "teal-orange", wild: 0.5, seed: 0, vibe: "", format: "same" };

const FORMATS = ["same", "jpg", "png", "webp"] as const;

/** A saved look's id in a step (its name behind this prefix). */
export const SAVED_PREFIX = "saved:";

function validRecipe(v: unknown): v is GradeServiceRecipe {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.name === "string" && Array.isArray(r.ops);
}

export function parseGradeStep(json: string): GradeStep {
  const r = parseObject(json);
  const d = DEFAULT_GRADE_STEP;
  const wild = num(r.wild, d.wild);
  const seed = Math.round(num(r.seed, d.seed));
  const { recipe, ...rest } = r;
  const out: GradeStep = {
    ...rest,
    look: str(r.look, d.look),
    wild: wild >= 0 && wild <= 1 ? wild : d.wild,
    seed: seed >= 0 && seed <= 0xffffffff ? seed : d.seed,
    vibe: str(r.vibe, d.vibe),
    format: oneOf(r.format, FORMATS, d.format as (typeof FORMATS)[number]),
  };
  if (validRecipe(recipe)) out.recipe = recipe;
  return out;
}

const TIER_LABEL: Record<string, string> = { film: "Film", bold: "Bold", bonkers: "Bonkers" };

function GradeEditor({ value, onChange, vars }: StepEditorProps<GradeStep>) {
  const [saved, setSaved] = useState<GradeServiceRecipe[]>([]);
  useEffect(() => {
    let live = true;
    GradeService.Looks()
      .then((l) => live && setSaved(l ?? []))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const options = useMemo(() => {
    const built = builtInLooks().map((l) => ({ value: l.id, label: `${TIER_LABEL[l.recipe.tier] ?? "Look"} · ${l.recipe.name}` }));
    const mine = saved.map((r) => ({ value: `${SAVED_PREFIX}${r.name}`, label: `Mine · ${r.name}` }));
    const all = [...built, ...mine];
    // A look this build doesn't know (an older or newer one) stays selectable.
    return all.some((o) => o.value === value.look) ? all : [{ value: value.look, label: value.look }, ...all];
  }, [saved, value.look]);

  const set = (patch: Partial<GradeStep>) => onChange({ ...value, ...patch });
  const pick = (look: string) => {
    let recipe: GradeServiceRecipe | undefined;
    if (look.startsWith(SAVED_PREFIX)) recipe = saved.find((r) => `${SAVED_PREFIX}${r.name}` === look);
    else {
      const b = builtInLook(look);
      if (b) recipe = toService(b.recipe);
    }
    const next: GradeStep = { ...value, look };
    if (recipe) next.recipe = recipe;
    else delete next.recipe;
    onChange(next);
  };

  return (
    <div className={styles.stack}>
      <Field label="Look">
        {(c) => (
          <Select
            {...c}
            value={value.look}
            options={options}
            aria-label="Look"
            onChange={pick}
          />
        )}
      </Field>
      <Field label={`Wildness · ${Math.round(value.wild * 100)}%`} hint="Tasteful at 0, Bold at 50, Bonkers at 100">
        {() => <Slider value={value.wild} min={0} max={1} step={0.05} onChange={(wild) => set({ wild })} aria-label="Wildness" data-tip="How far the look goes" format={(v) => `${Math.round(v * 100)}%`} />}
      </Field>
      <TemplateField
        label="Vibe (the chat model writes the look)"
        value={value.vibe}
        vars={vars}
        placeholder="{name} as a fever dream"
        onChange={(vibe) => set({ vibe })}
      />
      <Field label="Pictures as">
        {(c) => (
          <Select
            {...c}
            value={value.format}
            aria-label="Picture format"
            options={[
              { value: "same", label: "Same as the input" },
              { value: "jpg", label: "JPEG" },
              { value: "png", label: "PNG" },
              { value: "webp", label: "WebP" },
            ]}
            onChange={(format) => set({ format })}
          />
        )}
      </Field>
    </div>
  );
}

registerSteps([ui<GradeStep>("grade", parseGradeStep, GradeEditor)]);
