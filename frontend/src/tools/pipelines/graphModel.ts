import { CellStatus, WaitKind, type OutputKind, type Pipeline, type PipelineCheck, type PipelineStep, type StepCheck, type StepProduct, type StepType } from "@/lib/api";
import { canRead, filterProducts, FROM_INPUT, FROM_NONE, kindOfPath } from "@/pipelines/compat";
import type { RunView } from "@/state/pipelines";
import { acceptsNoun, CHECK_TYPE, emptyFilter, newStep, NO_FILES_TYPES, stepsOf } from "./editorModel";

// Pure logic of the node-graph pipeline builder (SPEC.md §12): pipeline ⇄ graph,
// connect rules, topological order, layout. The steps stay the source of truth;
// every edit here is a function from steps to steps, so the List view and the
// Graph view always show the same pipeline.

export const INPUT_NODE = FROM_INPUT;
/** The output port that carries everything a step makes. */
export const ALL_PORT = "*";
export const MAX_STEPS = 30;

export const NODE_W = 200;
export const HEAD_H = 34;
export const SUMMARY_H = 20;
export const PORT_H = 20;
export const NODE_PAD = 6;
const COL_GAP = 60;
const ROW_GAP = 20;

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2;

export type WireKind = "audio" | "video" | "image" | "document" | "text" | "other" | "any";

export interface Pt {
  x: number;
  y: number;
}

export interface View {
  x: number;
  y: number;
  zoom: number;
}

export interface Layout {
  v: 1;
  nodes: Record<string, Pt>;
  view: View;
}

export interface GraphPort {
  id: string;
  label: string;
  kind: WireKind;
}

export interface GraphNode {
  id: string;
  type: "input" | "step";
  x: number;
  y: number;
  w: number;
  h: number;
  ports: GraphPort[];
}

export interface GraphWire {
  /** "<from>|<port>|<to>" */
  id: string;
  from: string;
  port: string;
  to: string;
  /** The step's role filter (the wire shows one port, but a List-view filter may name several). */
  roles: string[];
  kind: WireKind;
}

export interface Graph {
  nodes: GraphNode[];
  wires: GraphWire[];
}

// ── layout JSON ───────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function defaultView(): View {
  return { x: 24, y: 24, zoom: 1 };
}

/** Reads Pipeline.layout; anything missing or malformed gives an empty layout. */
export function parseLayout(json: string): Layout {
  const out: Layout = { v: 1, nodes: {}, view: defaultView() };
  if (!json.trim()) return out;
  try {
    const raw: unknown = JSON.parse(json);
    if (!raw || typeof raw !== "object") return out;
    const r = raw as { nodes?: unknown; view?: unknown };
    if (r.nodes && typeof r.nodes === "object" && !Array.isArray(r.nodes)) {
      for (const [id, p] of Object.entries(r.nodes as Record<string, unknown>)) {
        const q = p as { x?: unknown; y?: unknown } | null;
        if (q && num(q.x) && num(q.y)) out.nodes[id] = { x: q.x, y: q.y };
      }
    }
    const v = r.view as { x?: unknown; y?: unknown; zoom?: unknown } | null | undefined;
    if (v && num(v.x) && num(v.y) && num(v.zoom)) out.view = { x: v.x, y: v.y, zoom: clamp(v.zoom, MIN_ZOOM, MAX_ZOOM) };
  } catch {
    return { v: 1, nodes: {}, view: defaultView() };
  }
  return out;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Layout JSON for the pipeline: only positions of `liveIds` are kept. */
export function serializeLayout(layout: Layout, liveIds: Iterable<string>): string {
  const live = new Set(liveIds);
  const nodes: Record<string, Pt> = {};
  for (const [id, p] of Object.entries(layout.nodes)) if (live.has(id)) nodes[id] = { x: round(p.x), y: round(p.y) };
  return JSON.stringify({ v: 1, nodes, view: { x: round(layout.view.x), y: round(layout.view.y), zoom: Math.round(layout.view.zoom * 100) / 100 } });
}

// ── kinds ─────────────────────────────────────────────────────

function productKind(p: StepProduct): WireKind {
  const k = p.kind as OutputKind | "";
  if (k === "audio" || k === "video" || k === "image" || k === "document") return k;
  const e = (p.exts ?? [])[0];
  if (e) {
    const guess = kindOfPath(`x${e.startsWith(".") ? e : `.${e}`}`);
    if (guess === "audio" || guess === "video" || guess === "image" || guess === "text") return guess;
    if (guess === "PDF") return "document";
  }
  return k === "other" ? "other" : "any";
}

export function kindOfProducts(products: readonly StepProduct[]): WireKind {
  const kinds = new Set(products.map(productKind));
  if (kinds.size === 1) return [...kinds][0] ?? "any";
  return "any";
}

// ── ports and graph ───────────────────────────────────────────

function productsOf(check: PipelineCheck | undefined, stepId: string): StepProduct[] {
  return check?.steps?.find((s) => s.stepId === stepId)?.info.produces ?? [];
}

/** Output ports of a step: "all files" first, then one per named role. */
export function stepPorts(stepId: string, check: PipelineCheck | undefined, steps: readonly PipelineStep[]): GraphPort[] {
  const products = productsOf(check, stepId);
  const ports: GraphPort[] = [{ id: ALL_PORT, label: "All files", kind: kindOfProducts(products) }];
  const add = (role: string, label: string) => {
    if (role && !ports.some((p) => p.id === role)) ports.push({ id: role, label, kind: kindOfProducts(products.filter((p) => p.role === role)) });
  };
  for (const p of products) add(p.role, p.label || p.role);
  // A wire may name a role Describe doesn't (yet) know; keep the port so the wire has somewhere to start.
  for (const s of steps) {
    const roles = s.filter?.roles ?? [];
    if (s.from === stepId && roles.length === 1) add(roles[0] ?? "", roles[0] ?? "");
  }
  return ports;
}

export function nodeHeight(portCount: number): number {
  return HEAD_H + SUMMARY_H + Math.max(1, portCount) * PORT_H + NODE_PAD;
}

export function outPortPos(n: GraphNode, portId: string): Pt {
  const i = Math.max(0, n.ports.findIndex((p) => p.id === portId));
  return { x: n.x + n.w, y: n.y + HEAD_H + SUMMARY_H + i * PORT_H + PORT_H / 2 };
}

export function inPortPos(n: GraphNode): Pt {
  return { x: n.x, y: n.y + HEAD_H / 2 };
}

/** Control points of a wire's cubic bezier from an output port to an input port. */
export function wireBezier(a: Pt, b: Pt): [Pt, Pt, Pt, Pt] {
  const d = Math.max(48, Math.abs(b.x - a.x) / 2);
  return [a, { x: a.x + d, y: a.y }, { x: b.x - d, y: b.y }, b];
}

export function wirePath(a: Pt, b: Pt): string {
  const [p0, p1, p2, p3] = wireBezier(a, b);
  return `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`;
}

/** The point of the bezier at t (0..1). */
export function bezierAt(c: readonly [Pt, Pt, Pt, Pt], t: number): Pt {
  const u = 1 - t;
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return { x: c[0].x * w[0]! + c[1].x * w[1]! + c[2].x * w[2]! + c[3].x * w[3]!, y: c[0].y * w[0]! + c[1].y * w[1]! + c[2].y * w[2]! + c[3].y * w[3]! };
}

/** Depth of each step (the input is 0); steps with no source are in column 1 too. */
function depths(steps: readonly PipelineStep[]): Map<string, number> {
  const d = new Map<string, number>([[INPUT_NODE, 0]]);
  for (const s of steps) d.set(s.id, s.from === FROM_INPUT || s.from === FROM_NONE || !d.has(s.from) ? 1 : (d.get(s.from) ?? 0) + 1);
  return d;
}

/** Layered left-to-right layout for nodes that have no saved position. */
export function autoLayout(steps: readonly PipelineStep[], heights: ReadonlyMap<string, number>): Record<string, Pt> {
  const d = depths(steps);
  const colY = new Map<number, number>();
  const out: Record<string, Pt> = {};
  const place = (id: string) => {
    const col = d.get(id) ?? 0;
    const y = colY.get(col) ?? 0;
    out[id] = { x: col * (NODE_W + COL_GAP), y };
    colY.set(col, y + (heights.get(id) ?? nodeHeight(1)) + ROW_GAP);
  };
  place(INPUT_NODE);
  for (const s of steps) place(s.id);
  return out;
}

/** Builds the graph of a pipeline; saved positions win, the rest is laid out. */
export function buildGraph(steps: readonly PipelineStep[], check: PipelineCheck | undefined, layout: Layout): Graph {
  const heights = new Map<string, number>();
  const portsBy = new Map<string, GraphPort[]>();
  const inputPorts: GraphPort[] = [{ id: ALL_PORT, label: "Files you run it on", kind: "any" }];
  portsBy.set(INPUT_NODE, inputPorts);
  heights.set(INPUT_NODE, nodeHeight(1));
  for (const s of steps) {
    const ports = stepPorts(s.id, check, steps);
    portsBy.set(s.id, ports);
    heights.set(s.id, nodeHeight(ports.length));
  }
  const auto = autoLayout(steps, heights);
  const mk = (id: string, type: "input" | "step"): GraphNode => {
    const p = layout.nodes[id] ?? auto[id] ?? { x: 0, y: 0 };
    return { id, type, x: p.x, y: p.y, w: NODE_W, h: heights.get(id) ?? nodeHeight(1), ports: portsBy.get(id) ?? [] };
  };
  const nodes = [mk(INPUT_NODE, "input"), ...steps.map((s) => mk(s.id, "step"))];
  const wires: GraphWire[] = [];
  for (const s of steps) {
    if (s.from === FROM_NONE || s.from === "") continue;
    if (s.from !== FROM_INPUT && !steps.some((o) => o.id === s.from)) continue;
    const roles = s.filter?.roles ?? [];
    const port = roles.length === 1 ? (roles[0] ?? ALL_PORT) : ALL_PORT;
    const src = portsBy.get(s.from);
    const kind = src?.find((p) => p.id === port)?.kind ?? "any";
    wires.push({ id: `${s.from}|${port}|${s.id}`, from: s.from, port, to: s.id, roles: [...roles], kind });
  }
  return { nodes, wires };
}

// ── editing ───────────────────────────────────────────────────

/** Steps ordered so every step comes after the step it reads (stable otherwise). */
export function topoSort(steps: readonly PipelineStep[]): PipelineStep[] {
  const placed = new Set<string>();
  const out: PipelineStep[] = [];
  let rest = steps.slice();
  while (rest.length > 0) {
    const i = rest.findIndex((s) => s.from === FROM_INPUT || s.from === FROM_NONE || placed.has(s.from));
    if (i < 0) {
      // A cycle or a dangling source (never made by the editor): cut the wires so the order is valid.
      for (const s of rest) out.push({ ...s, from: FROM_NONE });
      break;
    }
    const s = rest[i];
    if (!s) break;
    out.push(s);
    placed.add(s.id);
    rest = rest.filter((_, k) => k !== i);
  }
  return out;
}

/** True when `ancestor` is `id` or one of the steps it (indirectly) reads from. */
function reads(steps: readonly PipelineStep[], id: string, ancestor: string): boolean {
  const seen = new Set<string>();
  let cur: string = id;
  while (cur && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    const s = steps.find((x) => x.id === cur);
    if (!s) return false;
    cur = s.from;
  }
  return false;
}

export type ConnectResult = { ok: true; steps: PipelineStep[] } | { ok: false; reason: string };

function nameOf(steps: readonly PipelineStep[], catalog: readonly StepType[], id: string): string {
  if (id === INPUT_NODE) return "The run's input";
  const s = steps.find((x) => x.id === id);
  return s?.label.trim() || catalog.find((t) => t.id === s?.type)?.name || "That step";
}

/** Why `fromId`'s `port` can't feed step `toId` ("" = it can). */
export function connectReason(
  steps: readonly PipelineStep[],
  check: PipelineCheck | undefined,
  catalog: readonly StepType[],
  fromId: string,
  port: string,
  toId: string,
): string {
  const target = steps.find((s) => s.id === toId);
  if (!target) return "That isn't a step";
  if (fromId === toId) return "A step can't read its own files";
  if (fromId !== INPUT_NODE && !steps.some((s) => s.id === fromId)) return "That isn't a step";
  if (fromId !== INPUT_NODE && reads(steps, fromId, toId)) return "That would make a loop: the source already reads from this step";
  const type = catalog.find((t) => t.id === target.type);
  if (!type || fromId === INPUT_NODE || type.accepts.any || NO_FILES_TYPES.has(type.id) || type.id === CHECK_TYPE) return "";
  const all = productsOf(check, fromId);
  const products = port === ALL_PORT ? all : filterProducts(all, { ...emptyFilter(), roles: [port] });
  if (products.length === 0 || canRead(type.accepts, products)) return "";
  const noun = acceptsNoun(type);
  const made = [...new Set(products.map(productKind))].join(" & ");
  return `${type.name} reads ${noun}; ${nameOf(steps, catalog, fromId)} makes ${made === "any" ? "other files" : `${made} files`}`;
}

/**
 * Wires `fromId`'s `port` into step `toId` (replacing its one incoming wire) and
 * re-orders the steps. The source's Keep goes off unless the user set it.
 */
export function connect(
  steps: readonly PipelineStep[],
  check: PipelineCheck | undefined,
  catalog: readonly StepType[],
  fromId: string,
  port: string,
  toId: string,
  touchedKeep: ReadonlySet<string> = new Set(),
): ConnectResult {
  const reason = connectReason(steps, check, catalog, fromId, port, toId);
  if (reason) return { ok: false, reason };
  const next = steps.map((s) => {
    if (s.id === toId) return { ...s, from: fromId, filter: { ...s.filter, roles: port === ALL_PORT ? [] : [port] } };
    if (s.id === fromId && !touchedKeep.has(s.id)) return { ...s, keep: false };
    return s;
  });
  return { ok: true, steps: topoSort(next) };
}

/** Removes the incoming wire of a step (it then reads nothing until wired again). */
export function disconnect(steps: readonly PipelineStep[], toId: string): PipelineStep[] {
  return steps.map((s) => (s.id === toId ? { ...s, from: FROM_NONE, filter: { ...s.filter, roles: [] } } : s));
}

/** Removes steps; whatever read them is left unwired. */
export function deleteSteps(steps: readonly PipelineStep[], ids: ReadonlySet<string>): PipelineStep[] {
  return steps.filter((s) => !ids.has(s.id)).map((s) => (ids.has(s.from) ? { ...s, from: FROM_NONE, filter: { ...s.filter, roles: [] } } : s));
}

/** A new, unwired step of `type`; it is a leaf, so its files are kept. */
export function newGraphStep(type: StepType, steps: readonly PipelineStep[], check: PipelineCheck | undefined): PipelineStep {
  return { ...newStep(type, steps, check, steps.length), from: FROM_NONE, keep: true };
}

export function addGraphStep(steps: readonly PipelineStep[], step: PipelineStep): PipelineStep[] {
  return [...steps, step];
}

/** Copies steps (each copy reads what the original read); returns the new IDs by old ID. */
export function duplicateSteps(steps: readonly PipelineStep[], ids: ReadonlySet<string>, newId: (taken: string[]) => string): { steps: PipelineStep[]; idMap: Map<string, string> } {
  const out = steps.slice();
  const idMap = new Map<string, string>();
  for (const s of steps) {
    if (!ids.has(s.id)) continue;
    const id = newId(out.map((x) => x.id));
    idMap.set(s.id, id);
    out.push({ ...s, id, filter: { ...s.filter, roles: [...(s.filter?.roles ?? [])] }, keep: true });
  }
  // A copy of a step that read another copied step reads that step's copy.
  return { steps: topoSort(out.map((s) => (idMap.has(s.from) && [...idMap.values()].includes(s.id) ? { ...s, from: idMap.get(s.from) ?? s.from } : s))), idMap };
}

/** Pipeline with `steps` and a layout holding every node's position. */
export function withSteps(p: Pipeline, steps: PipelineStep[], layout?: string): Pipeline {
  return { ...p, steps, layout: layout ?? p.layout };
}

// ── live run status ───────────────────────────────────────────

export interface StepRunCounts {
  pending: number;
  running: number;
  waiting: number;
  needsYou: number;
  done: number;
  failed: number;
}

export function emptyCounts(): StepRunCounts {
  return { pending: 0, running: 0, waiting: 0, needsYou: 0, done: 0, failed: 0 };
}

/** Counts a step's cells over the given (active) runs. */
export function stepRunCounts(runs: readonly RunView[], stepId: string): StepRunCounts {
  const c = emptyCounts();
  for (const r of runs) {
    for (const it of r.items) {
      if (it.merged.length > 0) continue;
      for (const cell of it.cells) {
        if (cell.stepId !== stepId) continue;
        switch (cell.status) {
          case CellStatus.CellRunning:
          case CellStatus.CellPreparing:
            c.running++;
            break;
          case CellStatus.CellWaiting:
            if (cell.wait === WaitKind.WaitManual || cell.wait === WaitKind.WaitCheck) c.needsYou++;
            else c.waiting++;
            break;
          case CellStatus.CellDone:
          case CellStatus.CellMerged:
            c.done++;
            break;
          case CellStatus.CellFailed:
          case CellStatus.CellCancelled:
          case CellStatus.CellBlocked:
            c.failed++;
            break;
          case CellStatus.CellPending:
            c.pending++;
            break;
          default:
            break;
        }
      }
    }
  }
  return c;
}

export type WireRunState = "idle" | "flow" | "done" | "failed";

/** What a wire into `stepId` looks like during a run. */
export function wireRunState(c: StepRunCounts): WireRunState {
  if (c.failed > 0) return "failed";
  if (c.running > 0 || c.waiting > 0 || c.needsYou > 0) return "flow";
  if (c.done > 0 && c.pending === 0) return "done";
  return "idle";
}

/** "2 running · 3 done" or "" */
export function countsText(c: StepRunCounts): string {
  const parts: string[] = [];
  if (c.needsYou > 0) parts.push(`${c.needsYou} need you`);
  if (c.running > 0) parts.push(`${c.running} running`);
  if (c.waiting > 0) parts.push(`${c.waiting} waiting`);
  if (c.pending > 0) parts.push(`${c.pending} pending`);
  if (c.done > 0) parts.push(`${c.done} done`);
  if (c.failed > 0) parts.push(`${c.failed} failed`);
  return parts.join(" · ");
}

export function stepCheckOf(check: PipelineCheck | undefined, id: string): StepCheck | undefined {
  return check?.steps?.find((s) => s.stepId === id);
}

export { stepsOf };
