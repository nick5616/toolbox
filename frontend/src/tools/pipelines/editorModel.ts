import { Category, type OutputKind, type Pipeline, type PipelineCheck, type PipelineEntry, type PipelineStep, type StepFilter, type StepType } from "@/lib/api";
import { defaultFrom, describeAccepts, FROM_INPUT, FROM_NONE } from "@/pipelines/compat";

// Pure helpers for the pipeline editor (SPEC.md §11.2–11.4): step defaults,
// insert/remove/move with the Keep and From rules, and names.

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 8;

/** A fresh 8-character step ID ([a-z0-9]) that is not in `taken`. */
export function newStepId(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (;;) {
    const bytes = new Uint8Array(ID_LENGTH);
    crypto.getRandomValues(bytes);
    let id = "";
    for (const b of bytes) id += ID_ALPHABET.charAt(b % ID_ALPHABET.length);
    if (!used.has(id)) return id;
  }
}

/** Step types that can run without files (From "none"). */
export const NO_FILES_TYPES: ReadonlySet<string> = new Set(["pipelines.chat", "pipelines.table"]);

/** Tools whose manual step should not continue by itself when the tool finishes. */
export const AUTO_CONTINUE_OFF: ReadonlySet<string> = new Set(["subtitles", "lyric-video", "visualizer", "pdf"]);

export const CHECK_TYPE = "pipelines.check";

/** Default AutoContinue of a manual step of this type. */
export function autoContinueFor(type: string): boolean {
  return !AUTO_CONTINUE_OFF.has(type);
}

/** A filter with no nulls (Go's nil slices arrive as null). */
export interface Filter {
  roles: string[];
  kinds: OutputKind[];
  exts: string[];
  name: string;
}

export function filterOf(f: StepFilter | null | undefined): Filter {
  return { roles: f?.roles ?? [], kinds: f?.kinds ?? [], exts: f?.exts ?? [], name: f?.name ?? "" };
}

/** A pipeline's steps, never null. */
export function stepsOf(p: Pipeline): PipelineStep[] {
  return p.steps ?? [];
}

export function emptyFilter(): StepFilter {
  return { roles: [], kinds: [], exts: [], name: "" };
}

export function isFilterEmpty(f: Filter): boolean {
  return f.roles.length === 0 && f.kinds.length === 0 && f.exts.length === 0 && f.name.trim() === "";
}

export function typeById(catalog: readonly StepType[], id: string): StepType | undefined {
  return catalog.find((t) => t.id === id);
}

/** A new step of `type` for position `index`; Keep is left off (see insertStep). */
export function newStep(type: StepType, steps: readonly PipelineStep[], check: PipelineCheck | undefined, index: number): PipelineStep {
  const manualOnly = !type.auto && type.manual;
  const noFiles = NO_FILES_TYPES.has(type.id);
  return {
    id: newStepId(steps.map((s) => s.id)),
    type: type.id,
    label: "",
    optionsJson: manualOnly || type.id === CHECK_TYPE ? "{}" : type.defaultsJson || "{}",
    from: defaultFrom(steps, check, index, type.accepts, noFiles),
    filter: emptyFilter(),
    manual: manualOnly,
    autoContinue: autoContinueFor(type.id),
    keep: false,
    note: "",
  };
}

/**
 * Inserts `step` at `index`. A step that becomes the last one gets Keep on,
 * and the previous last step's Keep goes off unless the user set it.
 */
export function insertStep(steps: readonly PipelineStep[], index: number, step: PipelineStep, touchedKeep: ReadonlySet<string>): PipelineStep[] {
  const at = Math.max(0, Math.min(index, steps.length));
  const out = steps.map((s) => ({ ...s }));
  const last = at === steps.length;
  const prev = out[out.length - 1];
  if (last && prev && !touchedKeep.has(prev.id)) prev.keep = false;
  out.splice(at, 0, { ...step, keep: last });
  return out;
}

/** Removes a step; steps that read it read what it read instead. */
export function removeStep(steps: readonly PipelineStep[], id: string): PipelineStep[] {
  const gone = steps.find((s) => s.id === id);
  if (!gone) return steps.slice();
  const heir = gone.from === FROM_NONE ? FROM_INPUT : gone.from;
  return steps.filter((s) => s.id !== id).map((s) => (s.from === id ? { ...s, from: heir } : s));
}

/** Moves a step; steps that would now read a later step read their new predecessor (or the input). */
export function moveStep(steps: readonly PipelineStep[], from: number, to: number): PipelineStep[] {
  if (from === to || from < 0 || to < 0 || from >= steps.length || to >= steps.length) return steps.slice();
  const out = steps.slice();
  const [m] = out.splice(from, 1);
  if (!m) return steps.slice();
  out.splice(to, 0, m);
  return out.map((s, i) => {
    if (s.from === FROM_INPUT || s.from === FROM_NONE) return s;
    const at = out.findIndex((o) => o.id === s.from);
    if (at >= 0 && at < i) return s;
    const prev = out[i - 1];
    return { ...s, from: prev ? prev.id : FROM_INPUT };
  });
}

/** Copies a step right after itself, with a new ID. */
export function duplicateStep(steps: readonly PipelineStep[], id: string): { steps: PipelineStep[]; id: string } {
  const at = steps.findIndex((s) => s.id === id);
  const src = steps[at];
  if (!src) return { steps: steps.slice(), id: "" };
  const copy: PipelineStep = { ...src, id: newStepId(steps.map((s) => s.id)), filter: { ...src.filter }, keep: false };
  const out = steps.slice();
  out.splice(at + 1, 0, copy);
  return { steps: out, id: copy.id };
}

/** "New pipeline", "New pipeline 2", … not used by `taken` (case-insensitive). */
export function uniqueName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!used.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** A blank pipeline: one Downloader step reading the input, with the catalogue's defaults. */
export function blankPipeline(catalog: readonly StepType[], takenNames: readonly string[]): Pipeline {
  const dl = typeById(catalog, "downloader");
  const step: PipelineStep = dl
    ? { ...newStep(dl, [], undefined, 0), from: FROM_INPUT, keep: true }
    : {
        id: newStepId([]),
        type: "downloader",
        label: "",
        optionsJson: "{}",
        from: FROM_INPUT,
        filter: emptyFilter(),
        manual: false,
        autoContinue: true,
        keep: true,
        note: "",
      };
  return {
    id: "",
    name: uniqueName("New pipeline", takenNames),
    description: "",
    templateId: "",
    layout: "",
    steps: [step],
    watch: { enabled: false, folder: "" },
    createdAt: 0,
    updatedAt: 0,
  };
}

/** Replaces (or appends) one entry in a list of entries. */
export function withEntry(entries: readonly PipelineEntry[], entry: PipelineEntry): PipelineEntry[] {
  const i = entries.findIndex((e) => e.pipeline.id === entry.pipeline.id);
  if (i < 0) return [...entries, entry];
  const out = entries.slice();
  out[i] = entry;
  return out;
}

/** "images", "audio & video", "links" — what a step reads, without the trailing "files". */
export function acceptsNoun(type: StepType): string {
  const s = describeAccepts(type.accepts);
  return s.replace(/ files$/, "");
}

export const CATEGORY_LABELS: Record<string, string> = {
  [Category.CategoryMedia]: "Video & media",
  [Category.CategoryAudio]: "Audio",
  [Category.CategoryImage]: "Images",
  [Category.CategoryDocument]: "Documents",
  [Category.CategoryAI]: "AI",
  [Category.CategoryUtility]: "Utilities",
};

export const CATEGORY_ORDER: string[] = [
  Category.CategoryMedia,
  Category.CategoryAudio,
  Category.CategoryImage,
  Category.CategoryDocument,
  Category.CategoryAI,
  Category.CategoryUtility,
];

/** The first problem anywhere in a check (pipeline-level first), for Run's tooltip. */
export function firstProblem(check: PipelineCheck | undefined): string {
  if (!check) return "";
  const p = check.problems?.[0];
  if (p) return p;
  for (let i = 0; i < (check.steps ?? []).length; i++) {
    const s = (check.steps ?? [])[i];
    const sp = s?.problems?.[0];
    if (sp) return `Step ${i + 1}: ${sp}`;
  }
  if ((check.missing?.length ?? 0) > 0) return "Some tools this pipeline needs aren't installed";
  return "";
}
