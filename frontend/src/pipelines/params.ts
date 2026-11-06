/**
 * Step parameters (Phase 16, SPEC.md §B): every scalar option of a step is a
 * parameter that shows as an input port on the left of its node and can be
 * wired to a variable (a built-in, a run parameter or an earlier step's).
 *
 * Parameters are derived from the step type's defaults (`deriveParams`) and
 * refined by the step editor's `params` overrides (`StepUI.params`): labels,
 * value types, choice lists, which ones show on the node by default, and
 * which are internal and never shown.
 *
 * Colours come from the value-type tokens in styles/tokens.css
 * (`--type-files`, `--type-text`, …) through `valueTypeVar`.
 */
import type { PipelineStep, ValueType as WireValueType } from "@/lib/api";
import { stepUI } from "./steps/registry";

/** The type of a value. "files" is a step's file stream (its main input and file outputs); the rest are single values. */
export type ValueType = "files" | "text" | "number" | "toggle" | "choice" | "color" | "file";

export const VALUE_TYPES: readonly ValueType[] = ["files", "file", "text", "number", "toggle", "choice", "color"];

/** Short names for the legend and tooltips. */
export const VALUE_TYPE_LABELS: Record<ValueType, string> = {
  files: "Files",
  file: "File path",
  text: "Text",
  number: "Number",
  toggle: "On / off",
  choice: "Choice",
  color: "Colour",
};

/** The CSS colour of a value type. */
export function valueTypeVar(t: ValueType | "any"): string {
  return `var(--type-${t})`;
}

/** A Go `core.ValueType` ("" = text) as a frontend value type. */
export function fromWireType(t: WireValueType | "" | undefined): ValueType {
  switch (t) {
    case "number":
    case "toggle":
    case "choice":
    case "color":
    case "file":
      return t;
    default:
      return "text";
  }
}

export interface ParamChoice {
  value: string;
  label: string;
}

/** One parameter of a step. */
export interface ParamDef {
  /** JSON pointer into the step's options ("/speed", "/show/music"). */
  pointer: string;
  label: string;
  type: Exclude<ValueType, "files">;
  /** For "choice": the allowed values with their labels. */
  choices?: readonly ParamChoice[];
  /** Shown on the node without expanding it. */
  primary: boolean;
  /** For "number": bounds (for display; the runner checks the real ones). */
  min?: number;
  max?: number;
  /** One line on what it does (tooltip). */
  tip?: string;
}

/** What a step editor may say about one of its options. Every field is optional. */
export interface ParamOverride {
  label?: string;
  type?: Exclude<ValueType, "files">;
  choices?: readonly ParamChoice[];
  /** Show on the node without expanding it (at most 4 per step). */
  primary?: boolean;
  /** Internal (ids, JSON blobs, layout state): never a parameter. */
  hidden?: boolean;
  min?: number;
  max?: number;
  tip?: string;
}

/** Overrides keyed by JSON pointer. */
export type ParamOverrides = Readonly<Record<string, ParamOverride>>;

// ── derivation ────────────────────────────────────────────────


const MAX_DEPTH = 3;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

/** "maxWidth" → "Max width", "bpm_exact" → "Bpm exact". */
export function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

const escapePtr = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");
const unescapePtr = (k: string) => k.replace(/~1/g, "/").replace(/~0/g, "~");

/** The value at a JSON pointer (RFC 6901), or undefined. */
export function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) return undefined;
  let cur: unknown = root;
  for (const raw of pointer.slice(1).split("/")) {
    const k = unescapePtr(raw);
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(k)) return undefined;
      cur = cur[Number(k)];
    } else if (cur && typeof cur === "object") {
      if (!Object.prototype.hasOwnProperty.call(cur, k)) return undefined;
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return cur;
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

/** Every scalar option of a step's defaults as a parameter, refined by overrides. */
export function deriveParams(defaultsJson: string, overrides: ParamOverrides = {}): ParamDef[] {
  const out: ParamDef[] = [];
  const walk = (v: unknown, ptr: string, key: string, depth: number) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (depth >= MAX_DEPTH) return;
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) walk(child, `${ptr}/${escapePtr(k)}`, k, depth + 1);
      return;
    }
    if (ptr === "") return;
    let type: ParamDef["type"];
    if (typeof v === "boolean") type = "toggle";
    else if (typeof v === "number") type = "number";
    else if (typeof v === "string") type = COLOR_RE.test(v) ? "color" : "text";
    else return; // arrays, null
    const o = overrides[ptr] ?? {};
    if (o.hidden) return;
    const def: ParamDef = { pointer: ptr, label: o.label ?? humanize(key), type: o.type ?? type, primary: o.primary ?? false };
    if (o.choices) def.choices = o.choices;
    if (o.min !== undefined) def.min = o.min;
    if (o.max !== undefined) def.max = o.max;
    if (o.tip) def.tip = o.tip;
    out.push(def);
  };
  walk(parseJson(defaultsJson), "", "", 0);
  if (!out.some((p) => p.primary)) for (const p of out.slice(0, 3)) p.primary = true;
  return [...out.filter((p) => p.primary), ...out.filter((p) => !p.primary)];
}

const memo = new Map<string, ParamDef[]>();

/** The parameters of a step type with these defaults (memoised). */
export function paramsOf(type: string, defaultsJson: string): ParamDef[] {
  const key = `${type}\u0000${defaultsJson}`;
  let hit = memo.get(key);
  if (!hit) {
    hit = deriveParams(defaultsJson, stepUI(type)?.params);
    if (memo.size > 500) memo.clear();
    memo.set(key, hit);
  }
  return hit;
}

// ── binds ─────────────────────────────────────────────────────

/** The variable a step's option is wired to, if any. */
export function bindOf(step: PipelineStep, pointer: string): string | undefined {
  return (step.binds ?? []).find((b) => b.option === pointer)?.var;
}

/** The step with `pointer` wired to `varName` (null removes the wire). */
export function setBind(step: PipelineStep, pointer: string, varName: string | null): PipelineStep {
  const rest = (step.binds ?? []).filter((b) => b.option !== pointer);
  return { ...step, binds: varName ? [...rest, { option: pointer, var: varName }] : rest };
}

export interface WireCheck {
  ok: boolean;
  /** Allowed, but the run fails if the value doesn't fit (drawn dashed). */
  loose?: boolean;
  reason?: string;
}

/** Whether a value of type `from` may feed a parameter of type `to` (SPEC phase-16 §3.1). */
export function canWire(from: ValueType, to: ValueType): WireCheck {
  if (from === "files" || to === "files") return from === to ? { ok: true } : { ok: false, reason: "Files only wire to a step's files input" };
  if (from === to || to === "text") return { ok: true };
  if (from === "text") return { ok: true, loose: true, reason: `Text into ${VALUE_TYPE_LABELS[to].toLowerCase()}: the run fails if it doesn't fit` };
  if (from === "number" && to === "choice") return { ok: true, loose: true, reason: "A number into a choice: the run fails if it isn't one of the choices" };
  return { ok: false, reason: `${VALUE_TYPE_LABELS[from]} can't go into ${VALUE_TYPE_LABELS[to].toLowerCase()}` };
}

// ── helpers for the graph and panels (additions) ──────────────

/** Type of a built-in variable ("n" is a number, the rest are text). */
export function builtinVarType(name: string): ValueType {
  return name === "n" ? "number" : "text";
}

/** The step's options as an object ({} when they aren't valid JSON). */
export function parseOptions(optionsJson: string): unknown {
  const v = parseJson(optionsJson);
  return v && typeof v === "object" ? v : {};
}

/** The scalar currently stored at `pointer` in the step's options, as a string ("" when missing). */
export function optionString(options: unknown, pointer: string): string {
  const v = resolvePointer(options, pointer);
  return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";
}

/** How a parameter's value reads on a node or in a panel ("On", "1.1", "am_adam", "(empty)"). */
export function displayValue(def: Pick<ParamDef, "type" | "choices">, raw: string): string {
  if (def.type === "toggle") return raw === "true" ? "On" : raw === "false" ? "Off" : raw || "(empty)";
  if (def.type === "choice") return def.choices?.find((c) => c.value === raw)?.label ?? (raw || "(empty)");
  return raw === "" ? "(empty)" : raw;
}

/** The parameter type of a stored scalar (used for wired options that have no definition). */
export function scalarType(v: unknown): Exclude<ValueType, "files"> {
  if (typeof v === "boolean") return "toggle";
  if (typeof v === "number") return "number";
  if (typeof v === "string" && COLOR_RE.test(v)) return "color";
  return "text";
}

export const VAR_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

/** A run-parameter name made from its label: valid, and not in `taken`. */
export function paramNameFromLabel(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(base)) base = `p_${base}`.replace(/_+$/, "");
  base = base.slice(0, 28).replace(/_+$/, "") || "param";
  if (!used.has(base) && VAR_NAME_RE.test(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const name = `${base}_${i}`;
    if (!used.has(name)) return name;
  }
  return base;
}

/** True when `value` is a legal value for a run parameter of this type (mirrors the Go validation). */
export function validParamValue(type: Exclude<ValueType, "files" | "file">, value: string, choices: readonly string[] = []): boolean {
  if (value.length > 1000) return false;
  switch (type) {
    case "number":
      return value.trim() !== "" && Number.isFinite(Number(value));
    case "toggle":
      return /^(true|false|yes|no|on|off|1|0)$/i.test(value.trim());
    case "choice":
      return choices.includes(value);
    case "color":
      return COLOR_RE.test(value);
    default:
      return true;
  }
}
