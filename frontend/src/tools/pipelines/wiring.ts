import type { Pipeline, PipelineCheck, PipelineParam, PipelineStep, StepType, ValueType as WireValueType } from "@/lib/api";
import { FROM_INPUT } from "@/pipelines/compat";
import {
  bindOf,
  builtinVarType,
  canWire,
  fromWireType,
  humanize,
  optionString,
  paramNameFromLabel,
  paramsOf,
  parseOptions,
  resolvePointer,
  scalarType,
  setBind,
  type ParamDef,
  type ValueType,
  type WireCheck,
} from "@/pipelines/params";
import { BUILTIN_VARS } from "@/pipelines/vars";
import { CHECK_TYPE } from "./editorModel";
import { stepName } from "./stepHelpers";

// Pure logic of value wiring (Phase 16): which variables a step's parameters can
// take, whether a wire is legal and why not, binds, and "Ask when the run
// starts". The graph and the step panel both use it.

export const MAX_RUN_PARAMS = 20;

/** A variable a parameter can be wired to. */
export interface ValueSource {
  /** The node that makes it: INPUT ("input") for built-ins and run parameters, else a step id. */
  node: string;
  name: string;
  label: string;
  type: ValueType;
  /** "builtin" and "param" live on the Input node. */
  origin: "builtin" | "param" | "step";
}

export const paramsOfPipeline = (p: Pick<Pipeline, "params">): PipelineParam[] => p.params ?? [];

export function builtinSources(): ValueSource[] {
  return BUILTIN_VARS.map((v) => ({ node: FROM_INPUT, name: v.name, label: v.label, type: builtinVarType(v.name), origin: "builtin" as const }));
}

export function runParamSources(params: readonly PipelineParam[]): ValueSource[] {
  return params.map((p) => ({ node: FROM_INPUT, name: p.name, label: p.label, type: fromWireType(p.type), origin: "param" as const }));
}

/** The variables a step makes (from Describe). */
export function stepVarSources(check: PipelineCheck | undefined, stepId: string): ValueSource[] {
  const sc = check?.steps?.find((s) => s.stepId === stepId);
  return (sc?.info.vars ?? []).map((v) => ({ node: stepId, name: v.name, label: v.label || v.name, type: fromWireType(v.type), origin: "step" as const }));
}

/** Every variable that exists in the pipeline: the input's, then each step's in order. */
export function allSources(steps: readonly PipelineStep[], check: PipelineCheck | undefined, params: readonly PipelineParam[]): ValueSource[] {
  return [...builtinSources(), ...runParamSources(params), ...steps.flatMap((s) => stepVarSources(check, s.id))];
}

/** The variables step `index` can take: the input's and those of the steps before it. A later step's same-named variable wins, as in Describe. */
export function sourcesBefore(steps: readonly PipelineStep[], index: number, check: PipelineCheck | undefined, params: readonly PipelineParam[]): ValueSource[] {
  const out = [...builtinSources(), ...runParamSources(params)];
  for (let j = 0; j < index && j < steps.length; j++) {
    for (const v of stepVarSources(check, steps[j]?.id ?? "")) {
      const k = out.findIndex((o) => o.name === v.name);
      if (k >= 0) out[k] = v;
      else out.push(v);
    }
  }
  return out;
}

/** The source a bound variable resolves to for the step at `index` (undefined = nothing makes it). */
export function resolveSource(steps: readonly PipelineStep[], index: number, check: PipelineCheck | undefined, params: readonly PipelineParam[], name: string): ValueSource | undefined {
  return sourcesBefore(steps, index, check, params).find((s) => s.name === name);
}

/** Display name of a node ("The run's input" or the step's name). */
export function nodeName(steps: readonly PipelineStep[], catalog: readonly StepType[], id: string): string {
  if (id === FROM_INPUT) return "Input";
  const s = steps.find((x) => x.id === id);
  return s ? stepName(s, catalog.find((t) => t.id === s.type)) : "That step";
}

// ── a step's parameters ───────────────────────────────────────

/** A parameter of a step as the graph and panel show it. */
export interface StepParam extends ParamDef {
  /** The option's current value as a string. */
  value: string;
  /** Not in the step type's definitions (wired by a template or an older version). */
  extra?: boolean;
}

/** The parameters of a step: its type's, plus wired options the definitions don't know. Manual steps and Check have none. */
export function stepParams(step: PipelineStep, type: StepType | undefined): StepParam[] {
  const options = parseOptions(step.optionsJson);
  const out: StepParam[] = [];
  if (!step.manual && step.type !== CHECK_TYPE) {
    const defaults = type?.defaultsJson && type.defaultsJson !== "{}" ? type.defaultsJson : step.optionsJson;
    const defs = paramsOf(step.type, defaults);
    const defaultObj = parseOptions(defaults);
    let primaries = 0;
    for (const d of defs) {
      const primary = d.primary && primaries < 4;
      if (d.primary) primaries++;
      // An option the step doesn't store yet reads as its default.
      const own = resolvePointer(options, d.pointer) !== undefined ? optionString(options, d.pointer) : optionString(defaultObj, d.pointer);
      out.push({ ...d, primary, value: own });
    }
  }
  for (const b of step.binds ?? []) {
    if (out.some((p) => p.pointer === b.option)) continue;
    const raw = resolvePointer(options, b.option);
    const last = b.option.split("/").pop() ?? b.option;
    out.push({ pointer: b.option, label: humanize(last.replace(/~1/g, "/").replace(/~0/g, "~")), type: scalarType(raw), primary: true, value: optionString(options, b.option), extra: true });
  }
  return out;
}

// ── legality ──────────────────────────────────────────────────

export interface WireVerdict extends WireCheck {
  /** Set when the wire is refused. */
  reason?: string;
}

/**
 * Whether `source` can feed `param` of the step `toId`. A value flows down the
 * step order, so it must come from the input or a step before the target.
 */
export function valueWireVerdict(
  steps: readonly PipelineStep[],
  catalog: readonly StepType[],
  source: Pick<ValueSource, "node" | "type" | "label" | "name">,
  toId: string,
  param: Pick<ParamDef, "type" | "label">,
): WireVerdict {
  const ti = steps.findIndex((s) => s.id === toId);
  if (ti < 0) return { ok: false, reason: "That isn't a step" };
  if (source.node !== FROM_INPUT) {
    const si = steps.findIndex((s) => s.id === source.node);
    if (si < 0) return { ok: false, reason: "That isn't a step" };
    if (si === ti) return { ok: false, reason: "A step can't use its own values" };
    if (si > ti) return { ok: false, reason: `${nodeName(steps, catalog, source.node)} runs after this step` };
  }
  const v = canWire(source.type, param.type);
  return v.ok ? v : { ok: false, reason: v.reason ?? "That doesn't fit" };
}

/** Wires `name` into `pointer` of step `toId` (replacing the pointer's old wire). */
export function bindValue(steps: readonly PipelineStep[], toId: string, pointer: string, name: string): PipelineStep[] {
  return steps.map((s) => (s.id === toId ? setBind(s, pointer, name) : s));
}

/** Removes the wire into `pointer` of step `toId`. */
export function unbindValue(steps: readonly PipelineStep[], toId: string, pointer: string): PipelineStep[] {
  return steps.map((s) => (s.id === toId ? setBind(s, pointer, null) : s));
}

/** Removes every bind of a variable (a run parameter that goes away). */
export function unbindVar(steps: readonly PipelineStep[], name: string): PipelineStep[] {
  return steps.map((s) => ((s.binds ?? []).some((b) => b.var === name) ? { ...s, binds: (s.binds ?? []).filter((b) => b.var !== name) } : s));
}

/** How many binds use a variable. */
export function bindCount(steps: readonly PipelineStep[], name: string): number {
  return steps.reduce((n, s) => n + (s.binds ?? []).filter((b) => b.var === name).length, 0);
}

/** Whether `def` can be offered as a run parameter, and why not. */
export function askReason(def: Pick<ParamDef, "type" | "choices">, params: readonly PipelineParam[]): string {
  if (def.type === "file") return "A file can't be asked for when the run starts";
  if (def.type === "choice" && (def.choices?.length ?? 0) < 2) return "This choice has nothing to pick from";
  if (params.length >= MAX_RUN_PARAMS) return `A pipeline can have ${MAX_RUN_PARAMS} run parameters`;
  return "";
}

export type AskResult = { ok: true; pipeline: Pipeline; name: string } | { ok: false; reason: string };

/**
 * "Ask when the run starts": adds a run parameter with the parameter's label,
 * type, current value as the default and its choices, and wires it to the option.
 */
export function askAtStart(pipeline: Pipeline, check: PipelineCheck | undefined, stepId: string, def: StepParam): AskResult {
  const params = paramsOfPipeline(pipeline);
  const reason = askReason(def, params);
  if (reason) return { ok: false, reason };
  const steps = pipeline.steps ?? [];
  if (!steps.some((s) => s.id === stepId)) return { ok: false, reason: "That isn't a step" };
  const taken = [...BUILTIN_VARS.map((v) => v.name), "file", ...params.map((p) => p.name), ...allSources(steps, check, params).map((s) => s.name)];
  const name = paramNameFromLabel(def.label, taken);
  const type = def.type as Exclude<ValueType, "files" | "file">;
  const choices = def.type === "choice" ? (def.choices ?? []).map((c) => c.value) : [];
  let value = def.value;
  if (type === "choice" && !choices.includes(value)) value = choices[0] ?? "";
  if (type === "toggle" && value !== "true" && value !== "false") value = "false";
  if (type === "number" && value === "") value = "0";
  const param: PipelineParam = {
    name,
    label: def.label.slice(0, 60),
    type: type as unknown as WireValueType,
    default: value,
    choices,
  };
  return { ok: true, name, pipeline: { ...pipeline, params: [...params, param], steps: bindValue(steps, stepId, def.pointer, name) } };
}

/** The variables step `index` can wire into a parameter of type `type` (legal wires only, ⚠ ones included). */
export function compatibleSources(steps: readonly PipelineStep[], index: number, check: PipelineCheck | undefined, params: readonly PipelineParam[], type: Exclude<ValueType, "files">): ValueSource[] {
  return sourcesBefore(steps, index, check, params).filter((s) => canWire(s.type, type).ok);
}

/** "Step name · Variable" (or just the variable for the input's built-ins and run parameters). */
export function sourceText(steps: readonly PipelineStep[], catalog: readonly StepType[], s: Pick<ValueSource, "node" | "label" | "origin">): string {
  return s.origin === "step" ? `${nodeName(steps, catalog, s.node)} · ${s.label}` : s.origin === "param" ? `Run parameter · ${s.label}` : `Input · ${s.label}`;
}

/** Binds of a step as [pointer, variable] pairs. */
export const bindsOf = (step: PipelineStep): ReadonlyArray<{ option: string; var: string }> => step.binds ?? [];

export { bindOf };
