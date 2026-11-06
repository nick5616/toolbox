import { useMemo } from "react";
import { Field } from "@/components/Field";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Select } from "@/components/Select";
import { Stepper } from "@/components/Stepper";
import { TemplateField } from "@/components/TemplateField";
import {
  ComposerService,
  EditStudioService,
  type ComposerStepOptions,
  type EditAssembleRequest,
  type EditBeatRequest,
  type ProjectInfo,
} from "@/lib/api";
import { useLoadedList } from "./context";
import { num, oneOf, str, ui } from "./phase14";
import { parseObject, registerSteps, type StepEditorProps } from "./registry";
import styles from "./phase14.module.css";

// Step editors of Photo Composer ("Fill a template"), the Video Editor ("Assemble
// a video") and Edit Studio ("Cut to the beat"), Phase 14. parse() keeps unknown
// fields and fills what Go treats as "0 = default" with the default itself.

const ASPECTS = ["9:16", "4:5", "1:1", "16:9"] as const;
const FPS = ["30", "60"] as const;
const HEIGHTS = ["720", "1080", "1440"] as const;

function intIn(v: unknown, d: number, lo: number, hi: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : d;
}

/** A select of saved projects: "pick one", the saved choice if it's gone, then the list. */
function projectOptions(items: readonly ProjectInfo[], loading: boolean, selected: string, selectedName: string, noneLabel: string, goneLabel: string) {
  const missing = selected !== "" && !loading && !items.some((p) => p.id === selected);
  return [
    { value: "", label: loading ? "Loading…" : noneLabel },
    ...(missing ? [{ value: selected, label: selectedName ? `${selectedName} (${goneLabel})` : goneLabel }] : []),
    ...items.map((p) => ({ value: p.id, label: p.name || "Untitled" })),
  ];
}

// ---------- Photo Composer ("photo-composer"): Fill a template ----------

/** Mirrors modules/composer DefaultStepOptions(). */
export const DEFAULT_COMPOSER_STEP: ComposerStepOptions = { templateId: "", templateName: "", format: "", scale: 1, name: "" };

export function parseComposerStep(json: string): ComposerStepOptions {
  const r = parseObject(json);
  const d = DEFAULT_COMPOSER_STEP;
  return {
    ...r,
    templateId: str(r.templateId, d.templateId),
    templateName: str(r.templateName, d.templateName),
    format: oneOf(r.format, ["", "jpg", "png"] as const, d.format),
    scale: typeof r.scale === "number" && r.scale >= 0.25 && r.scale <= 4 ? r.scale : d.scale,
    name: str(r.name, d.name),
  };
}

function ComposerEditor({ value, onChange, vars }: StepEditorProps<ComposerStepOptions>) {
  const list = useLoadedList<ProjectInfo>(() => ComposerService.List());
  const options = useMemo(
    () => projectOptions(list.items, list.loading, value.templateId, value.templateName, "Pick a composition", "gone"),
    [list.items, list.loading, value.templateId, value.templateName],
  );
  const pick = (templateId: string) => {
    const p = list.items.find((x) => x.id === templateId);
    onChange({ ...value, templateId, templateName: p ? p.name : "" });
  };
  return (
    <div className={styles.stack}>
      <Field label="Template">{(c) => <Select {...c} value={value.templateId} options={options} onChange={pick} />}</Field>
      {!list.loading && list.items.length === 0 && <p className={styles.hint}>No saved compositions yet. Make one in Photo Composer and mark its photo layers as template slots.</p>}
      <Field label="Save as">
        <SegmentedControl
          aria-label="Save as"
          value={value.format}
          options={[
            { value: "", label: "Template's" },
            { value: "jpg", label: "JPEG" },
            { value: "png", label: "PNG" },
          ]}
          onChange={(format) => onChange({ ...value, format })}
        />
      </Field>
      <Field label="Size">
        {(c) => (
          <Stepper id={c.id} aria-label="Size" value={value.scale} min={0.25} max={4} step={0.25} unit="×" onChange={(scale) => onChange({ ...value, scale })} />
        )}
      </Field>
      <TemplateField label="File name (optional)" value={value.name} vars={vars} placeholder="Template - photo" onChange={(name) => onChange({ ...value, name })} />
      <p className={styles.hint}>Each photo, or each group of photos for a template with several slots, fills the template.</p>
    </div>
  );
}

// ---------- Video Editor ("video-studio"): Assemble a video ----------

/** Mirrors modules/editstudio DefaultAssembleRequest(). */
export const DEFAULT_ASSEMBLE_STEP: EditAssembleRequest = {
  templateId: "",
  templateName: "",
  transition: "cut",
  transitionMs: 500,
  title: "",
  titleMs: 3000,
  music: "",
  aspect: "9:16",
  fps: 30,
  height: 1080,
  stillMs: 3000,
  fit: "fill",
  name: "",
};

export function parseAssembleStep(json: string): EditAssembleRequest {
  const r = parseObject(json);
  const d = DEFAULT_ASSEMBLE_STEP;
  return {
    ...r,
    templateId: str(r.templateId, d.templateId),
    templateName: str(r.templateName, d.templateName),
    transition: oneOf(r.transition, ["cut", "crossfade"] as const, d.transition),
    transitionMs: intIn(r.transitionMs || d.transitionMs, d.transitionMs, 100, 2000),
    title: str(r.title, d.title),
    titleMs: intIn(r.titleMs || d.titleMs, d.titleMs, 500, 10_000),
    music: str(r.music, d.music),
    aspect: oneOf(r.aspect, ASPECTS, d.aspect),
    fps: r.fps === 60 ? 60 : 30,
    height: [720, 1080, 1440].includes(num(r.height, 0)) ? num(r.height, 1080) : d.height,
    stillMs: intIn(r.stillMs || d.stillMs, d.stillMs, 500, 60_000),
    fit: oneOf(r.fit, ["fill", "fit", "fit-blur"] as const, d.fit),
    name: str(r.name, d.name),
  };
}

const asSeconds = (ms: number) => Math.round(ms / 100) / 10;

function AssembleEditor({ value, onChange, vars }: StepEditorProps<EditAssembleRequest>) {
  const set = (patch: Partial<EditAssembleRequest>) => onChange({ ...value, ...patch });
  const list = useLoadedList<ProjectInfo>(() => EditStudioService.List());
  const options = useMemo(
    () => projectOptions(list.items, list.loading, value.templateId, value.templateName, "A new edit", "gone"),
    [list.items, list.loading, value.templateId, value.templateName],
  );
  const pick = (templateId: string) => {
    const p = list.items.find((x) => x.id === templateId);
    set({ templateId, templateName: p ? p.name : "" });
  };
  const fromTemplate = value.templateId !== "";
  return (
    <div className={styles.stack}>
      <Field label="Based on">{(c) => <Select {...c} value={value.templateId} options={options} onChange={pick} />}</Field>
      <p className={styles.hint}>{fromTemplate ? "The saved edit's clips are replaced, in order, by the files this step gets." : "Puts the files one after another in a new edit."}</p>
      {!fromTemplate && (
        <>
          <Field label="Shape">
            <SegmentedControl aria-label="Shape" value={value.aspect as (typeof ASPECTS)[number]} options={ASPECTS.map((a) => ({ value: a, label: a }))} onChange={(aspect) => set({ aspect })} />
          </Field>
          <div className={styles.pair}>
            <Field label="Frame rate">
              <SegmentedControl aria-label="Frame rate" value={String(value.fps) as (typeof FPS)[number]} options={FPS.map((f) => ({ value: f, label: `${f} fps` }))} onChange={(f) => set({ fps: Number(f) })} />
            </Field>
            <Field label="Quality">
              <SegmentedControl aria-label="Quality" value={String(value.height) as (typeof HEIGHTS)[number]} options={HEIGHTS.map((h) => ({ value: h, label: `${h}p` }))} onChange={(h) => set({ height: Number(h) })} />
            </Field>
          </div>
          <Field label="Fit">
            {(c) => (
              <Select
                {...c}
                value={value.fit as "fill" | "fit" | "fit-blur"}
                options={[
                  { value: "fill", label: "Fill the frame" },
                  { value: "fit", label: "Fit inside" },
                  { value: "fit-blur", label: "Fit on a blurred background" },
                ]}
                onChange={(fit) => set({ fit })}
              />
            )}
          </Field>
        </>
      )}
      <Field label="Photos show for">
        {(c) => <Stepper id={c.id} aria-label="Photos show for" value={asSeconds(value.stillMs)} min={0.5} max={60} step={0.5} unit="s" onChange={(s) => set({ stillMs: Math.round(s * 1000) })} />}
      </Field>
      <Field label="Between clips">
        <SegmentedControl
          aria-label="Between clips"
          value={value.transition as "cut" | "crossfade"}
          options={[
            { value: "cut", label: "Cut" },
            { value: "crossfade", label: "Crossfade" },
          ]}
          onChange={(transition) => set({ transition })}
        />
      </Field>
      {value.transition === "crossfade" && (
        <Field label="Crossfade lasts">
          {(c) => <Stepper id={c.id} aria-label="Crossfade lasts" value={asSeconds(value.transitionMs)} min={0.1} max={2} step={0.1} unit="s" onChange={(s) => set({ transitionMs: Math.round(s * 1000) })} />}
        </Field>
      )}
      <TemplateField label="Title (optional)" value={value.title} vars={vars} placeholder="Shown over the start" onChange={(title) => set({ title })} />
      {value.title.trim() !== "" && (
        <Field label="Title shows for">
          {(c) => <Stepper id={c.id} aria-label="Title shows for" value={asSeconds(value.titleMs)} min={0.5} max={10} step={0.5} unit="s" onChange={(s) => set({ titleMs: Math.round(s * 1000) })} />}
        </Field>
      )}
      <TemplateField label="Music (optional)" value={value.music} vars={vars} placeholder="An audio file, or the step's audio input" onChange={(music) => set({ music })} />
      <TemplateField label="File name (optional)" value={value.name} vars={vars} placeholder="The edit's or first clip's name" onChange={(name) => set({ name })} />
    </div>
  );
}

// ---------- Edit Studio ("edit-studio"): Cut to the beat ----------

/** Mirrors modules/editstudio DefaultBeatRequest(). */
export const DEFAULT_BEAT_STEP: EditBeatRequest = {
  recipeId: "downbeat",
  seed: 1,
  order: "recipe",
  song: "",
  startMs: 0,
  lengthMs: 30_000,
  aspect: "9:16",
  fps: 30,
  height: 1080,
  name: "",
};

const FALLBACK_RECIPES = ["downbeat", "kick", "chorus-double", "hold-verse", "drop-slam", "anime-drop"];
const RECIPE_LABELS: Record<string, string> = {
  downbeat: "Cut on the downbeat",
  kick: "Cut on the kick",
  "chorus-double": "Twice as fast in the chorus",
  "hold-verse": "Hold longer in the verse",
  "drop-slam": "Slam on the drop",
  "anime-drop": "Anime drop",
};
const ORDERS = [
  { value: "recipe", label: "The style decides" },
  { value: "sequential", label: "In order" },
  { value: "shuffleNoRepeat", label: "Shuffled, no repeats" },
  { value: "byTag", label: "By tag" },
] as const;

export function parseBeatStep(json: string): EditBeatRequest {
  const r = parseObject(json);
  const d = DEFAULT_BEAT_STEP;
  return {
    ...r,
    recipeId: str(r.recipeId, d.recipeId) || d.recipeId,
    seed: intIn(r.seed || d.seed, d.seed, 1, 2_147_483_647),
    order: oneOf(r.order, ORDERS.map((o) => o.value), d.order as (typeof ORDERS)[number]["value"]),
    song: str(r.song, d.song),
    startMs: intIn(r.startMs, d.startMs, 0, 24 * 3_600_000),
    lengthMs: intIn(r.lengthMs || d.lengthMs, d.lengthMs, 1000, 600_000),
    aspect: oneOf(r.aspect, ASPECTS, d.aspect as (typeof ASPECTS)[number]),
    fps: r.fps === 60 ? 60 : 30,
    height: [720, 1080, 1440].includes(num(r.height, 0)) ? num(r.height, 1080) : d.height,
    name: str(r.name, d.name),
  };
}

function BeatEditor({ value, onChange, vars }: StepEditorProps<EditBeatRequest>) {
  const set = (patch: Partial<EditBeatRequest>) => onChange({ ...value, ...patch });
  const recipes = useLoadedList<string>(() => EditStudioService.BeatRecipes());
  const options = useMemo(() => {
    const ids = recipes.items.length > 0 ? recipes.items : FALLBACK_RECIPES;
    const all = ids.includes(value.recipeId) ? ids : [value.recipeId, ...ids];
    return all.map((id) => ({ value: id, label: RECIPE_LABELS[id] ?? id }));
  }, [recipes.items, value.recipeId]);
  return (
    <div className={styles.stack}>
      <Field label="Cutting style">{(c) => <Select {...c} value={value.recipeId} options={options} onChange={(recipeId) => set({ recipeId })} />}</Field>
      <Field label="Clips">{(c) => <Select {...c} value={value.order as (typeof ORDERS)[number]["value"]} options={ORDERS.map((o) => ({ ...o }))} onChange={(order) => set({ order })} />}</Field>
      <TemplateField label="Song (optional)" value={value.song} vars={vars} placeholder="The first audio file the step gets" onChange={(song) => set({ song })} />
      <div className={styles.pair}>
        <Field label="Start at">
          {(c) => <Stepper id={c.id} aria-label="Start at" value={Math.round(value.startMs / 1000)} min={0} max={86_400} unit="s" onChange={(s) => set({ startMs: s * 1000 })} />}
        </Field>
        <Field label="Length">
          {(c) => <Stepper id={c.id} aria-label="Length" value={Math.round(value.lengthMs / 1000)} min={1} max={600} unit="s" onChange={(s) => set({ lengthMs: s * 1000 })} />}
        </Field>
      </div>
      <Field label="Shape">
        <SegmentedControl aria-label="Shape" value={value.aspect as (typeof ASPECTS)[number]} options={ASPECTS.map((a) => ({ value: a, label: a }))} onChange={(aspect) => set({ aspect })} />
      </Field>
      <div className={styles.pair}>
        <Field label="Frame rate">
          <SegmentedControl aria-label="Frame rate" value={String(value.fps) as (typeof FPS)[number]} options={FPS.map((f) => ({ value: f, label: `${f} fps` }))} onChange={(f) => set({ fps: Number(f) })} />
        </Field>
        <Field label="Quality">
          <SegmentedControl aria-label="Quality" value={String(value.height) as (typeof HEIGHTS)[number]} options={HEIGHTS.map((h) => ({ value: h, label: `${h}p` }))} onChange={(h) => set({ height: Number(h) })} />
        </Field>
      </div>
      <Field label="Seed">
        {(c) => <Stepper id={c.id} aria-label="Seed" value={value.seed} min={1} max={2_147_483_647} onChange={(seed) => set({ seed })} />}
      </Field>
      <p className={styles.hint}>The same clips and seed always give the same cut.</p>
      <TemplateField label="File name (optional)" value={value.name} vars={vars} placeholder="The song's name" onChange={(name) => set({ name })} />
    </div>
  );
}

registerSteps([
  ui("photo-composer", parseComposerStep, ComposerEditor),
  ui("video-studio", parseAssembleStep, AssembleEditor),
  ui("edit-studio", parseBeatStep, BeatEditor),
]);
