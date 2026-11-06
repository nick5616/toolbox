import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Button, IconButton, toast } from "@/components";
import type { Pipeline, PipelineCheck, PipelineStep, StepType } from "@/lib/api";
import { useElementSize } from "@/lib/useElementSize";
import { hasTool, readTool } from "@/lib/fileDrag";
import type { ModuleView } from "@/state/modules";
import type { RunView } from "@/state/pipelines";
import { newStepId, stepsOf } from "./editorModel";
import {
  ALL_PORT,
  addGraphStep,
  autoLayout,
  bezierAt,
  buildGraph,
  connect,
  connectReason,
  connectValue,
  deleteSteps,
  disconnect,
  duplicateSteps,
  HEAD_H,
  inPortPos,
  INPUT_NODE,
  MAX_STEPS,
  MAX_ZOOM,
  MIN_ZOOM,
  newGraphStep,
  NODE_W,
  nodeHeights,
  valueDepsOf,
  outPortPos,
  paramPortPos,
  parseLayout,
  serializeLayout,
  stepCheckOf,
  stepRunCounts,
  topoSort,
  valueConnectReason,
  valueOutPos,
  wireBezier,
  wirePath,
  wiredPortsByNode,
  wireRunState,
  withSteps,
  type GraphNode,
  type GraphWire,
  type Pt,
  type View,
} from "./graphModel";
import { WireCanvas, type WireSpec } from "./graph/WireCanvas";
import { svgWireStyle, type WireVisualState } from "./graph/wireStyle";
import { GraphNodeView, type NodePortApi, type PortKind, type PortState } from "./GraphNodeView";
import { Legend } from "./Legend";
import { DRAG_TYPE, QuickAdd, ToolStore } from "./ToolStore";
import { askAtStart, askReason, unbindValue } from "./wiring";
import styles from "./GraphEditor.module.css";

export interface GraphEditorProps {
  pipeline: Pipeline;
  check: PipelineCheck;
  catalog: readonly StepType[];
  modules: readonly ModuleView[];
  /** Active runs of this pipeline (nodes show their live status). */
  runs: readonly RunView[];
  onEdit: (fn: (p: Pipeline) => Pipeline) => void;
  /** Layout-only changes: saved, but nothing to re-check. */
  onLayout: (layout: string, undoable?: boolean) => void;
  /** The gear on a node, or a click on one of its parameter rows (with the option's pointer): the app shows the Step panel for it. */
  onOpenStep?: (id: string, pointer?: string) => void;
  touchedKeep: Set<string>;
  /** Makes the canvas a drop target that runs this pipeline on dropped files (the id the file router looks for). */
  dropTargetId?: string;
}

export const STORE_KEY = "toolbox.pipelines.storeOpen";
const STORE_AUTO_OPEN_WIDTH = 760;
const LEGEND_OPEN_MIN = { width: 760, height: 520 };

function loadStorePref(): boolean | null {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}

const FIT_MIN_ZOOM = 0.75;
const DRAG_THRESHOLD = 3;
const LAYOUT_DELAY_MS = 400;
const clampZoom = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

/** A wire being drawn. `files` wires start at a files output; `value` wires at a value output (`end: "out"`) or at a parameter (`end: "param"`). */
interface Wiring {
  kind: "files" | "value";
  end: "out" | "param";
  from: string;
  /** The files port, the variable name (end "out") or the option pointer (end "param"). */
  port: string;
  /** World position of the cursor. */
  x: number;
  y: number;
  /** Started by a click (not a drag): the next click on a target completes it. */
  sticky: boolean;
}

interface PortMenuState {
  nodeId: string;
  pointer: string;
  /** Position inside the viewport. */
  x: number;
  y: number;
}

/** The node-graph editor of a pipeline (SPEC.md §12): tool store, canvas, options drawer. */
export function GraphEditor({ pipeline, check, catalog, modules, runs, onEdit, onLayout, onOpenStep, touchedKeep, dropTargetId }: GraphEditorProps) {
  const steps = stepsOf(pipeline);
  const runParams = pipeline.params ?? [];
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const rootSize = useElementSize(root);
  // Open by default when the editor is wide enough; the user's toggle is remembered.
  const [storePref, setStorePref] = useState<boolean | null>(loadStorePref);
  const storeOpen = storePref ?? rootSize.width >= STORE_AUTO_OPEN_WIDTH;
  const setStoreOpen = (f: (o: boolean) => boolean) => {
    const next = f(storeOpen);
    setStorePref(next);
    try {
      localStorage.setItem(STORE_KEY, next ? "1" : "0");
    } catch {
      // not remembered; fine
    }
  };
  const layout = useMemo(() => parseLayout(pipeline.layout), [pipeline.layout]);
  const [view, setViewState] = useState<View>(layout.view);
  const [move, setMove] = useState<{ ids: ReadonlySet<string>; dx: number; dy: number } | null>(null);
  const [selNodes, setSelNodes] = useState<ReadonlySet<string>>(new Set());
  const [selWire, setSelWire] = useState<string | null>(null);
  const [wiring, setWiringState] = useState<Wiring | null>(null);
  const [hover, setHover] = useState<{ id: string; reason: string } | null>(null);
  const [refusal, setRefusal] = useState<{ x: number; y: number; text: string } | null>(null);
  const [quick, setQuick] = useState<{ sx: number; sy: number; wx: number; wy: number } | null>(null);
  const [portMenu, setPortMenu] = useState<PortMenuState | null>(null);
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [glActive, setGlActive] = useState(false);
  const [vp, setVp] = useState<HTMLDivElement | null>(null);
  const size = useElementSize(vp);

  const graph = useMemo(() => buildGraph(steps, check, layout, { catalog, params: runParams }), [steps, check, layout, catalog, runParams]);
  const nodes = useMemo<GraphNode[]>(
    () => (move ? graph.nodes.map((n) => (move.ids.has(n.id) ? { ...n, x: n.x + move.dx, y: n.y + move.dy } : n)) : graph.nodes),
    [graph.nodes, move],
  );
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n] as const)), [nodes]);
  const wiredBy = useMemo(() => wiredPortsByNode(graph), [graph]);

  // Latest values for handlers registered on window.
  const latest = useRef({ steps, check, catalog, graph, view, selNodes, selWire, wiring, pipeline, runParams, expanded: layout.expanded ?? [], nodeById });
  latest.current = { steps, check, catalog, graph, view, selNodes, selWire, wiring, pipeline, runParams, expanded: layout.expanded ?? [], nodeById };
  const viewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refusalTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cleanup = useRef<(() => void) | null>(null);
  const cascade = useRef(0);
  // A click that ended a node drag or completed a wire must not also open the options.
  const swallowClick = useRef(false);
  // Always fit the graph to the view when a pipeline opens (the saved pan/zoom is not restored).
  const fitted = useRef(false);

  useEffect(
    () => () => {
      clearTimeout(viewTimer.current);
      clearTimeout(refusalTimer.current);
      cleanup.current?.();
    },
    [],
  );

  const setWiring = (w: Wiring | null) => {
    latest.current.wiring = w;
    setWiringState(w);
  };

  // ── coordinates and view ────────────────────────────────────

  const toWorld = useCallback(
    (cx: number, cy: number): Pt => {
      const r = vp?.getBoundingClientRect();
      const v = latest.current.view;
      const fx = Number.isFinite(cx) ? cx : 0;
      const fy = Number.isFinite(cy) ? cy : 0;
      return { x: (fx - (r?.left ?? 0) - v.x) / v.zoom, y: (fy - (r?.top ?? 0) - v.y) / v.zoom };
    },
    [vp],
  );
  const toLocal = (cx: number, cy: number): Pt => {
    const r = vp?.getBoundingClientRect();
    return { x: cx - (r?.left ?? 0), y: cy - (r?.top ?? 0) };
  };
  /** Screen position (inside the viewport) of a node's top left. */
  const nodeLocal = (id: string): Pt => {
    const n = latest.current.nodeById.get(id);
    const v = latest.current.view;
    return n ? { x: n.x * v.zoom + v.x, y: n.y * v.zoom + v.y } : { x: 0, y: 0 };
  };

  /** Positions of every node as the user sees them now (auto-laid-out ones included). */
  const positions = (extra?: Record<string, Pt>): Record<string, Pt> => {
    const out: Record<string, Pt> = {};
    for (const n of latest.current.graph.nodes) out[n.id] = { x: n.x, y: n.y };
    return { ...out, ...extra };
  };

  const pushLayout = (v: View, pos: Record<string, Pt>, ids: Iterable<string>, undoable = false, expanded: readonly string[] = latest.current.expanded) => {
    const json = serializeLayout({ v: 1, nodes: pos, view: v, expanded: [...expanded] }, ids);
    if (json !== latest.current.pipeline.layout) onLayout(json, undoable);
  };

  const setView = (next: View | ((v: View) => View)) => {
    const v = typeof next === "function" ? next(latest.current.view) : next;
    latest.current.view = v;
    setViewState(v);
    clearTimeout(viewTimer.current);
    viewTimer.current = setTimeout(() => {
      const g = latest.current.graph;
      pushLayout(latest.current.view, positions(), g.nodes.map((n) => n.id));
    }, LAYOUT_DELAY_MS);
  };

  const zoomAt = (factor: number, at: Pt) => {
    setView((v) => {
      const zoom = clampZoom(v.zoom * factor);
      const k = zoom / v.zoom;
      return { zoom, x: at.x - (at.x - v.x) * k, y: at.y - (at.y - v.y) * k };
    });
  };

  const fit = useCallback(() => {
    const ns = latest.current.graph.nodes;
    if (ns.length === 0 || size.width === 0 || size.height === 0) return;
    const x0 = Math.min(...ns.map((n) => n.x));
    const y0 = Math.min(...ns.map((n) => n.y));
    const x1 = Math.max(...ns.map((n) => n.x + n.w));
    const y1 = Math.max(...ns.map((n) => n.y + n.h));
    const pad = 28;
    const zx = (size.width - pad * 2) / (x1 - x0);
    const zy = (size.height - pad * 2) / (y1 - y0);
    // Readable text wins over seeing everything: never below 75 %, never above 100 %.
    const zoom = Math.max(FIT_MIN_ZOOM, Math.min(1, zx, zy));
    // An axis that fits is centred; one that does not starts at the margin (pan for the rest).
    const x = zx >= FIT_MIN_ZOOM ? (size.width - (x1 - x0) * zoom) / 2 - x0 * zoom : pad - x0 * zoom;
    const y = zy >= FIT_MIN_ZOOM ? (size.height - (y1 - y0) * zoom) / 2 - y0 * zoom : pad - y0 * zoom;
    setView({ zoom, x, y });
  }, [size.width, size.height]);

  useEffect(() => {
    if (fitted.current || size.width === 0) return;
    fitted.current = true;
    fit();
  }, [size.width, fit]);

  // The wheel pans; Ctrl/Cmd+wheel zooms at the cursor. Needs a non-passive listener.
  useEffect(() => {
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element | null)?.closest("[data-no-wheel]")) return;
      e.preventDefault();
      const r = vp.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.0015), { x: e.clientX - r.left, y: e.clientY - r.top });
      else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, [vp]);

  // ── editing ─────────────────────────────────────────────────

  /** Layout JSON for the pipeline as it will be: every node's position, the view and the open "more" rows. */
  const layoutJson = (steps2: readonly PipelineStep[], extra?: Record<string, Pt>): string => {
    const pos = positions(extra);
    const ids = [INPUT_NODE, ...steps2.map((s) => s.id)];
    return serializeLayout({ v: 1, nodes: pos, view: latest.current.view, expanded: [...latest.current.expanded] }, ids);
  };

  /** Applies a change to the steps and saves every node's position with it. */
  const commit = (steps2: PipelineStep[], extra?: Record<string, Pt>) => {
    const json = layoutJson(steps2, extra);
    onEdit((p) => withSteps(p, steps2, json));
  };

  const addNode = (type: StepType, at?: Pt) => {
    const cur = latest.current.steps;
    if (cur.length >= MAX_STEPS) {
      toast({ title: "That's the most steps a pipeline can have", description: `A pipeline can hold ${MAX_STEPS} steps.`, tone: "warn" });
      return;
    }
    const s = newGraphStep(type, cur, latest.current.check);
    let p = at;
    if (!p) {
      const v = latest.current.view;
      const off = (cascade.current++ % 6) * 28;
      p = { x: (size.width / 2 - v.x) / v.zoom - NODE_W / 2 + off, y: (size.height / 2 - v.y) / v.zoom - 40 + off };
    }
    const pos = { x: p.x - NODE_W / 2, y: p.y - HEAD_H / 2 };
    let next = addGraphStep(cur, s);
    if (at) {
      // A tool dropped just right of a node (and level with it) follows that node, when the wire is legal.
      const near = latest.current.graph.nodes
        .filter((n) => n.x + n.w <= pos.x + 40 && pos.x - (n.x + n.w) < 320 && Math.abs(n.y + n.h / 2 - at.y) < 160)
        .sort((a, b) => Math.hypot(pos.x - (a.x + a.w), at.y - (a.y + a.h / 2)) - Math.hypot(pos.x - (b.x + b.w), at.y - (b.y + b.h / 2)))[0];
      if (near) {
        const res = connect(next, latest.current.check, latest.current.catalog, near.id, ALL_PORT, s.id, touchedKeep);
        if (res.ok) next = res.steps;
      }
    }
    commit(next, { [s.id]: at ? pos : p });
    setSelNodes(new Set([s.id]));
    setSelWire(null);
    setQuick(null);
  };

  const removeNodes = (ids: ReadonlySet<string>) => {
    const real = new Set([...ids].filter((i) => i !== INPUT_NODE));
    if (real.size === 0) return;
    const cur = latest.current.steps;
    if (real.size >= cur.length) {
      toast({ title: "A pipeline needs at least one step", tone: "warn" });
      return;
    }
    commit(deleteSteps(cur, real));
    setSelNodes(new Set());
  };

  const duplicateNodes = (ids: ReadonlySet<string>) => {
    const real = new Set([...ids].filter((i) => i !== INPUT_NODE));
    const cur = latest.current.steps;
    if (real.size === 0) return;
    if (cur.length + real.size > MAX_STEPS) {
      toast({ title: "That's the most steps a pipeline can have", tone: "warn" });
      return;
    }
    const res = duplicateSteps(cur, real, newStepId);
    const extra: Record<string, Pt> = {};
    for (const [old, id] of res.idMap) {
      const n = latest.current.graph.nodes.find((x) => x.id === old);
      if (n) extra[id] = { x: n.x + 40, y: n.y + 40 };
    }
    commit(res.steps, extra);
    setSelNodes(new Set(res.idMap.values()));
    setSelWire(null);
  };

  const removeWire = (id: string) => {
    const w = latest.current.graph.wires.find((x) => x.id === id);
    if (!w) return;
    commit(w.channel === "value" ? unbindValue(latest.current.steps, w.to, w.param ?? "") : disconnect(latest.current.steps, w.to));
    setSelWire(null);
  };

  const showRefusal = (at: Pt, text: string) => {
    setRefusal({ x: at.x, y: at.y, text });
    clearTimeout(refusalTimer.current);
    refusalTimer.current = setTimeout(() => setRefusal(null), 3500);
  };

  const tryConnect = (from: string, port: string, to: string, at: Pt): boolean => {
    const { steps: cur, check: chk, catalog: cat } = latest.current;
    const res = connect(cur, chk, cat, from, port, to, touchedKeep);
    if (!res.ok) {
      showRefusal(at, res.reason);
      return false;
    }
    commit(res.steps);
    setSelWire(`${from}|${port}|${to}`);
    setSelNodes(new Set());
    return true;
  };

  /** Wires a value output into a parameter, in whichever direction the user drew it. */
  const tryConnectValue = (from: string, name: string, to: string, pointer: string, at: Pt): boolean => {
    const { steps: cur, check: chk, catalog: cat, runParams: rp } = latest.current;
    const res = connectValue(cur, chk, cat, rp, from, name, to, pointer);
    if (!res.ok) {
      showRefusal(at, res.reason);
      return false;
    }
    commit(res.steps);
    setSelWire(`${from}|v:${name}|${to}|${pointer}`);
    setSelNodes(new Set());
    return true;
  };

  const tidy = () => {
    const { steps: st, check: ck, runParams: rp } = latest.current;
    const auto = autoLayout(topoSort(st), nodeHeights(latest.current.graph), valueDepsOf(st, ck, rp));
    commit(latest.current.steps, auto);
    window.setTimeout(() => {
      fitted.current = false;
      fit();
    }, 0);
  };

  const toggleMore = (id: string) => {
    const cur = latest.current.expanded;
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    pushLayout(latest.current.view, positions(), latest.current.graph.nodes.map((n) => n.id), false, next);
  };

  /** "Ask when the run starts": a run parameter on the Input node, wired to the option. */
  const askWhenRunStarts = (nodeId: string, pointer: string) => {
    const { pipeline: p, check: chk, graph: g } = latest.current;
    const def = g.nodes.find((n) => n.id === nodeId)?.params.find((r) => r.pointer === pointer)?.def;
    if (!def) return;
    const res = askAtStart(p, chk, nodeId, def);
    if (!res.ok) {
      showRefusal(nodeLocal(nodeId), res.reason);
      return;
    }
    const json = layoutJson(res.pipeline.steps ?? []);
    onEdit(() => ({ ...res.pipeline, layout: json }));
    setSelWire(`${INPUT_NODE}|v:${res.name}|${nodeId}|${pointer}`);
    setSelNodes(new Set());
  };

  // ── pointer interactions ────────────────────────────────────

  const track = (onMove: (e: PointerEvent) => void, onUp: (e: PointerEvent) => void) => {
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      cleanup.current = null;
    };
    const up = (e: PointerEvent) => {
      stop();
      onUp(e);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    cleanup.current = stop;
  };

  const onViewportDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.bg) return;
    vp?.focus();
    setQuick(null);
    setPortMenu(null);
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const start = latest.current.view;
    const boxing = e.button === 0 && e.shiftKey;
    const origin = toLocal(startX, startY);
    let moved = false;
    track(
      (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        moved = true;
        if (boxing) {
          const p = toLocal(ev.clientX, ev.clientY);
          setBox({ x0: origin.x, y0: origin.y, x1: p.x, y1: p.y });
        } else {
          setView({ ...start, x: start.x + dx, y: start.y + dy });
        }
      },
      (ev) => {
        if (boxing && moved) {
          const a = toWorld(startX, startY);
          const b = toWorld(ev.clientX, ev.clientY);
          const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
          const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
          const hit = latest.current.graph.nodes.filter((n) => n.x < x1 && n.x + n.w > x0 && n.y < y1 && n.y + n.h > y0).map((n) => n.id);
          setSelNodes(new Set(hit));
          setSelWire(null);
        } else if (!moved) {
          setSelNodes(new Set());
          setSelWire(null);
          if (latest.current.wiring) setWiring(null);
        }
        setBox(null);
      },
    );
  };

  /** Completes a sticky value wire on the parameter or value row under `target` (false when it isn't one). */
  const completeValueAt = (w: Wiring, target: Element | null, at: Pt): boolean => {
    if (w.end === "out") {
      const el = target?.closest<HTMLElement>("[data-param-row]");
      if (!el) return false;
      tryConnectValue(w.from, w.port, el.dataset.node ?? "", el.dataset.paramRow ?? "", at);
      return true;
    }
    const el = target?.closest<HTMLElement>("[data-value-row]");
    if (!el) return false;
    tryConnectValue(el.dataset.node ?? "", el.dataset.valueRow ?? "", w.from, w.port, at);
    return true;
  };

  const onNodeDown = (id: string) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    vp?.focus();
    setQuick(null);
    setPortMenu(null);
    swallowClick.current = false;
    const w = latest.current.wiring;
    if (w?.sticky) {
      if (w.kind === "value") {
        completeValueAt(w, e.target instanceof Element ? e.target : null, toLocal(e.clientX, e.clientY));
        swallowClick.current = true;
        setWiring(null);
      } else if (id !== INPUT_NODE && id !== w.from) {
        if (tryConnect(w.from, w.port, id, toLocal(e.clientX, e.clientY))) setWiring(null);
      } else setWiring(null);
      return;
    }
    let ids: ReadonlySet<string>;
    const sel = latest.current.selNodes;
    if (e.shiftKey) {
      const next = new Set(sel);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      ids = next;
      setSelNodes(next);
      setSelWire(null);
      return;
    }
    if (sel.has(id)) ids = sel;
    else {
      ids = new Set([id]);
      setSelNodes(ids);
    }
    setSelWire(null);
    const startX = e.clientX;
    const startY = e.clientY;
    const zoom = latest.current.view.zoom;
    let moved = false;
    let last = { dx: 0, dy: 0 };
    track(
      (ev) => {
        const dx = (ev.clientX - startX) / zoom;
        const dy = (ev.clientY - startY) / zoom;
        if (!moved && Math.hypot(dx, dy) * zoom < DRAG_THRESHOLD) return;
        moved = true;
        last = { dx, dy };
        setMove({ ids, dx, dy });
      },
      () => {
        if (moved) {
          swallowClick.current = true;
          const extra: Record<string, Pt> = {};
          for (const n of latest.current.graph.nodes) if (ids.has(n.id)) extra[n.id] = { x: n.x + last.dx, y: n.y + last.dy };
          const pos = positions(extra);
          pushLayout(latest.current.view, pos, latest.current.graph.nodes.map((n) => n.id), true);
        }
        setMove(null);
      },
    );
  };

  const onPortDown = (e: ReactPointerEvent<HTMLElement>, from: string, port: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    vp?.focus();
    setQuick(null);
    setPortMenu(null);
    setSelWire(null);
    const startX = e.clientX;
    const startY = e.clientY;
    const w0 = toWorld(startX, startY);
    let moved = false;
    setWiring({ kind: "files", end: "out", from, port, x: w0.x, y: w0.y, sticky: false });
    const probe = (ev: PointerEvent) => {
      const el = ev.target instanceof Element ? ev.target.closest<HTMLElement>("[data-node-id]") : null;
      const id = el?.dataset.nodeId ?? "";
      if (id && id !== INPUT_NODE && id !== from) {
        const { steps: cur, check: chk, catalog: cat } = latest.current;
        setHover({ id, reason: connectReason(cur, chk, cat, from, port, id) });
      } else setHover(null);
    };
    track(
      (ev) => {
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
        moved = true;
        const p = toWorld(ev.clientX, ev.clientY);
        setWiring({ kind: "files", end: "out", from, port, x: p.x, y: p.y, sticky: false });
        probe(ev);
      },
      (ev) => {
        setHover(null);
        if (!moved) {
          // A click: the wire stays attached to the cursor until a step is clicked.
          const p = toWorld(ev.clientX, ev.clientY);
          setWiring({ kind: "files", end: "out", from, port, x: p.x, y: p.y, sticky: true });
          return;
        }
        const el = ev.target instanceof Element ? ev.target.closest<HTMLElement>("[data-node-id]") : null;
        const id = el?.dataset.nodeId ?? "";
        setWiring(null);
        if (id && id !== INPUT_NODE && id !== from) tryConnect(from, port, id, toLocal(ev.clientX, ev.clientY));
      },
    );
  };

  /** The value wire (if any) into a parameter. */
  const wireIntoParam = (nodeId: string, pointer: string): GraphWire | undefined => latest.current.graph.wires.find((w) => w.channel === "value" && w.to === nodeId && w.param === pointer);

  /** Starts a value wire from a value output (`end: "out"`) or a parameter port (`end: "param"`). */
  const onValuePortDown = (e: ReactPointerEvent<HTMLElement>, end: "out" | "param", nodeId: string, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    vp?.focus();
    setQuick(null);
    setPortMenu(null);
    const cur = latest.current.wiring;
    if (cur?.sticky && cur.kind === "value" && cur.end !== end) {
      // The other end of a click-to-wire.
      const target = e.target instanceof Element ? e.target : null;
      completeValueAt(cur, target, toLocal(e.clientX, e.clientY));
      setWiring(null);
      return;
    }
    setSelWire(null);
    const startX = e.clientX;
    const startY = e.clientY;
    const w0 = toWorld(startX, startY);
    let moved = false;
    const mk = (x: number, y: number, sticky: boolean): Wiring => ({ kind: "value", end, from: nodeId, port: id, x, y, sticky });
    setWiring(mk(w0.x, w0.y, false));
    const probe = (ev: PointerEvent) => {
      const w = latest.current.wiring;
      if (!w) return;
      const t = ev.target instanceof Element ? ev.target : null;
      const el = end === "out" ? t?.closest<HTMLElement>("[data-param-row]") : t?.closest<HTMLElement>("[data-value-row]");
      const node = el?.dataset.node ?? "";
      if (!el || !node) {
        setHover(null);
        return;
      }
      const { steps: s, check: chk, catalog: cat, runParams: rp } = latest.current;
      const v = end === "out" ? valueConnectReason(s, chk, cat, rp, nodeId, id, node, el.dataset.paramRow ?? "") : valueConnectReason(s, chk, cat, rp, node, el.dataset.valueRow ?? "", nodeId, id);
      setHover({ id: node, reason: v.ok ? "" : v.reason });
    };
    track(
      (ev) => {
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
        moved = true;
        const p = toWorld(ev.clientX, ev.clientY);
        setWiring(mk(p.x, p.y, false));
        probe(ev);
      },
      (ev) => {
        setHover(null);
        if (!moved) {
          // A click on a wired parameter selects its wire; otherwise the wire sticks to the cursor until the other end is clicked.
          const w = end === "param" ? wireIntoParam(nodeId, id) : undefined;
          if (w) {
            setWiring(null);
            setSelWire(w.id);
            setSelNodes(new Set());
            return;
          }
          const p = toWorld(ev.clientX, ev.clientY);
          setWiring(mk(p.x, p.y, true));
          return;
        }
        const w = latest.current.wiring;
        setWiring(null);
        if (w) completeValueAt(w, ev.target instanceof Element ? ev.target : null, toLocal(ev.clientX, ev.clientY));
      },
    );
  };

  /** Enter on a port: start a wire there, or finish the one in progress. */
  const activatePort = (kind: PortKind, nodeId: string, id: string) => {
    const w = latest.current.wiring;
    const n = latest.current.nodeById.get(nodeId);
    if (w?.kind === "value" && ((w.end === "out" && kind === "param") || (w.end === "param" && kind === "value"))) {
      const at = nodeLocal(nodeId);
      if (w.end === "out") tryConnectValue(w.from, w.port, nodeId, id, at);
      else tryConnectValue(nodeId, id, w.from, w.port, at);
      setWiring(null);
      return;
    }
    if (!n) return;
    const p = kind === "value" ? valueOutPos(n, id) : paramPortPos(n, id);
    setSelWire(null);
    setWiring({ kind: "value", end: kind === "value" ? "out" : "param", from: nodeId, port: id, x: p.x, y: p.y, sticky: true });
  };

  const openPortMenu = (nodeId: string, pointer: string, at: { x: number; y: number }) => {
    const l = toLocal(at.x, at.y);
    setPortMenu({ nodeId, pointer, x: Math.max(4, Math.min(l.x, Math.max(4, size.width - 210))), y: Math.max(4, Math.min(l.y, Math.max(4, size.height - 90))) });
  };

  const onViewportMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const w = latest.current.wiring;
    if (!w?.sticky) return;
    const p = toWorld(e.clientX, e.clientY);
    setWiring({ ...w, x: p.x, y: p.y });
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select, [contenteditable]")) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (latest.current.selWire) removeWire(latest.current.selWire);
      else removeNodes(latest.current.selNodes);
    } else if (mod && e.key.toLowerCase() === "d") {
      e.preventDefault();
      duplicateNodes(latest.current.selNodes);
    } else if (e.key === "Escape") {
      if (portMenu) setPortMenu(null);
      else if (quick) setQuick(null);
      else if (latest.current.wiring) setWiring(null);
      else {
        setSelNodes(new Set());
        setSelWire(null);
      }
    }
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (Array.from(e.dataTransfer.types).includes(DRAG_TYPE) || hasTool(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    // A palette item, or a sidebar tool dragged in from anywhere in the app.
    const id = e.dataTransfer.getData(DRAG_TYPE) || readTool(e) || "";
    const type = catalog.find((t) => t.id === id);
    if (!type) return;
    e.preventDefault();
    addNode(type, toWorld(e.clientX, e.clientY));
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.bg) return;
    const l = toLocal(e.clientX, e.clientY);
    const w = toWorld(e.clientX, e.clientY);
    setQuick({ sx: Math.max(8, Math.min(l.x, size.width - 250)), sy: Math.max(8, Math.min(l.y, size.height - 280)), wx: w.x, wy: w.y });
  };

  // ── node ports ──────────────────────────────────────────────

  const portState = (kind: PortKind, nodeId: string, id: string): PortState | undefined => {
    const w = wiring;
    if (!w || w.kind !== "value") return undefined;
    const { steps: s, check: chk, catalog: cat, runParams: rp } = latest.current;
    if (w.end === "out") {
      if (kind !== "param") return "dim";
      return valueConnectReason(s, chk, cat, rp, w.from, w.port, nodeId, id).ok ? "ok" : "dim";
    }
    if (kind !== "value") return "dim";
    return valueConnectReason(s, chk, cat, rp, nodeId, id, w.from, w.port).ok ? "ok" : "dim";
  };

  const portApi = (nodeId: string): NodePortApi => ({
    state: (kind, id) => portState(kind, nodeId, id),
    onValueDown: (e, name) => onValuePortDown(e, "out", nodeId, name),
    onParamDown: (e, pointer) => onValuePortDown(e, "param", nodeId, pointer),
    onActivate: (kind, id) => activatePort(kind, nodeId, id),
    onMenu: (kind, id, at) => {
      if (kind === "param") openPortMenu(nodeId, id, at);
    },
    onRowClick: (pointer) => {
      if (swallowClick.current) {
        swallowClick.current = false;
        return;
      }
      if (latest.current.wiring) return;
      onOpenStep?.(nodeId, pointer);
    },
    onToggleMore: () => toggleMore(nodeId),
  });

  // ── render data ─────────────────────────────────────────────

  const countsByStep = useMemo(() => new Map(steps.map((s) => [s.id, stepRunCounts(runs, s.id)] as const)), [steps, runs]);
  const wireSpecs = useMemo<WireSpec[]>(() => {
    const out: WireSpec[] = [];
    for (const w of graph.wires) {
      const a = nodeById.get(w.from);
      const b = nodeById.get(w.to);
      if (!a || !b) continue;
      const value = w.channel === "value";
      const run = !value && runs.length > 0 ? wireRunState(countsByStep.get(w.to) ?? stepRunCounts([], w.to)) : "idle";
      const state: WireVisualState = selWire === w.id ? "selected" : run;
      out.push({
        id: w.id,
        a: value ? valueOutPos(a, w.port) : outPortPos(a, w.port),
        b: value ? paramPortPos(b, w.param ?? "") : inPortPos(b),
        type: value ? (w.valueType ?? "any") : "files",
        value,
        dashed: value && w.loose === true,
        state,
      });
    }
    if (wiring) {
      const a = nodeById.get(wiring.from);
      if (a) {
        if (wiring.kind === "files") out.push({ id: "__drag", a: outPortPos(a, wiring.port), b: { x: wiring.x, y: wiring.y }, type: "files", state: "drag" });
        else if (wiring.end === "out") {
          const t = a.values.find((v) => v.id === wiring.port)?.type ?? "any";
          out.push({ id: "__drag", a: valueOutPos(a, wiring.port), b: { x: wiring.x, y: wiring.y }, type: t, value: true, state: "drag" });
        } else {
          const t = a.params.find((p) => p.pointer === wiring.port)?.type ?? "any";
          out.push({ id: "__drag", a: { x: wiring.x, y: wiring.y }, b: paramPortPos(a, wiring.port), type: t, value: true, state: "drag" });
        }
      }
    }
    return out;
  }, [graph.wires, nodeById, selWire, wiring, runs, countsByStep]);

  const selected = selWire ? graph.wires.find((w) => w.id === selWire) : undefined;
  const selectedMid = useMemo(() => {
    if (!selected) return null;
    const a = nodeById.get(selected.from);
    const b = nodeById.get(selected.to);
    if (!a || !b) return null;
    const value = selected.channel === "value";
    return bezierAt(wireBezier(value ? valueOutPos(a, selected.port) : outPortPos(a, selected.port), value ? paramPortPos(b, selected.param ?? "") : inPortPos(b)), 0.5);
  }, [selected, nodeById]);

  const zoomPct = Math.round(view.zoom * 100);
  const centre = { x: size.width / 2, y: size.height / 2 };
  const menuRow = portMenu ? nodeById.get(portMenu.nodeId)?.params.find((p) => p.pointer === portMenu.pointer) : undefined;
  const menuAsk = menuRow ? askReason(menuRow.def, runParams) : "";
  const wireByIdMap = useMemo(() => new Map(graph.wires.map((w) => [w.id, w] as const)), [graph.wires]);

  return (
    <div ref={setRoot} className={styles.root} id={dropTargetId} data-file-drop-target={dropTargetId ? "" : undefined}>
      {storeOpen && <ToolStore catalog={catalog} modules={modules} onAdd={(t) => addNode(t)} />}
      <div className={styles.stage}>
        <div
          ref={setVp}
          className={styles.viewport}
          tabIndex={0}
          role="application"
          aria-label="Pipeline graph. Drag a tool in from the store, wire output ports to steps, Delete removes the selection."
          data-bg="1"
          onPointerDown={onViewportDown}
          onPointerMove={onViewportMove}
          onKeyDown={onKeyDown}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onDoubleClick={onDoubleClick}
        >
          <WireCanvas wires={wireSpecs} view={view} width={size.width} height={size.height} onGL={setGlActive} />
          <div className={styles.layer} data-bg="1" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
            <svg className={styles.wires} width="1" height="1" aria-hidden="true">
              {wireSpecs.map((w) => {
                const d = wirePath(w.a, w.b);
                const real = w.id !== "__drag";
                const info = wireByIdMap.get(w.id);
                return (
                  <g key={w.id}>
                    <path
                      d={d}
                      className={[styles.wire, glActive ? styles.wireHidden : "", w.state === "selected" || w.state === "drag" ? styles.wireOn : "", w.state === "failed" ? styles.wireFailed : ""].join(" ")}
                      style={svgWireStyle(w.type, w.value === true, w.dashed === true, w.state === "failed")}
                      data-wire-channel={w.value ? "value" : "files"}
                    />
                    {real && (
                      <path
                        d={d}
                        className={styles.wireHit}
                        data-wire-id={w.id}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          vp?.focus();
                          setSelWire(w.id);
                          setSelNodes(new Set());
                        }}
                      >
                        <title>{info?.loose ? "A value that may not fit: the run fails if it doesn't. Click to select this wire, then press Delete to remove it" : "Click to select this wire, then press Delete to remove it"}</title>
                      </path>
                    )}
                  </g>
                );
              })}
            </svg>
            {nodes.map((n) => {
              const step = steps.find((s) => s.id === n.id);
              const dropState = wiring?.kind === "files" && hover?.id === n.id ? (hover.reason ? "bad" : "ok") : undefined;
              return (
                <GraphNodeView
                  key={n.id}
                  node={n}
                  step={step}
                  type={step ? catalog.find((t) => t.id === step.type) : undefined}
                  check={stepCheckOf(check, n.id)}
                  counts={countsByStep.get(n.id) ?? stepRunCounts([], n.id)}
                  selected={selNodes.has(n.id)}
                  dropState={dropState}
                  inKind={graph.wires.find((w) => w.to === n.id && w.channel === "files")?.kind}
                  wired={wiredBy.get(n.id)}
                  api={portApi(n.id)}
                  onPointerDown={onNodeDown(n.id)}
                  onPortDown={(e, port) => onPortDown(e, n.id, port)}
                  onOptions={() => onOpenStep?.(n.id)}
                />
              );
            })}
            {selected && selectedMid && (
              <button type="button" className={styles.wireDelete} style={{ left: selectedMid.x, top: selectedMid.y }} aria-label="Remove this wire" data-tip="Remove this wire (Delete)" onPointerDown={(e) => e.stopPropagation()} onClick={() => removeWire(selected.id)}>
                ×
              </button>
            )}
          </div>
          {box && <div className={styles.box} style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }} />}
          {wiring && hover?.reason && (
            <div className={styles.refusal} role="status" style={{ left: hoverPoint(hover.id, nodeById, view).x, top: hoverPoint(hover.id, nodeById, view).y }}>
              {hover.reason}
            </div>
          )}
          {refusal && (
            <div className={styles.refusal} role="alert" style={{ left: Math.max(8, Math.min(refusal.x + 12, size.width - 260)), top: Math.max(8, refusal.y + 12) }}>
              {refusal.text}
            </div>
          )}
          {portMenu && menuRow && (
            <PortMenu
              x={portMenu.x}
              y={portMenu.y}
              label={menuRow.label}
              wired={!!menuRow.wired}
              askDisabled={menuAsk}
              onAsk={() => {
                setPortMenu(null);
                askWhenRunStarts(portMenu.nodeId, portMenu.pointer);
              }}
              onUnwire={() => {
                const { steps: cur } = latest.current;
                setPortMenu(null);
                commit(unbindValue(cur, portMenu.nodeId, portMenu.pointer));
              }}
              onClose={() => setPortMenu(null)}
            />
          )}
          {quick && <QuickAdd catalog={catalog} x={quick.sx} y={quick.sy} onClose={() => setQuick(null)} onPick={(t) => addNode(t, { x: quick.wx, y: quick.wy })} />}
        </div>

        <div className={styles.toolbar} data-no-wheel="1">
          <IconButton size="sm" icon="panel-left" label={storeOpen ? "Hide the tool store" : "Show the tool store"} pressed={storeOpen} onClick={() => setStoreOpen((o) => !o)} />
          <span className={styles.toolbarSep} />
          <IconButton size="sm" icon="zoom-out" label="Zoom out" onClick={() => zoomAt(1 / 1.2, centre)} />
          <span className={styles.zoom} aria-live="polite">{zoomPct}%</span>
          <IconButton size="sm" icon="zoom-in" label="Zoom in" onClick={() => zoomAt(1.2, centre)} />
          <IconButton size="sm" icon="maximize" label="Fit everything in view" onClick={fit} />
          <Button size="sm" variant="ghost" data-tip="Arrange the nodes in columns from left to right" onClick={tidy}>
            Tidy up
          </Button>
        </div>

        <Legend roomy={size.width >= LEGEND_OPEN_MIN.width && size.height >= LEGEND_OPEN_MIN.height} />
      </div>
    </div>
  );
}

interface PortMenuProps {
  x: number;
  y: number;
  label: string;
  wired: boolean;
  /** Why "Ask when the run starts" isn't available ("" = it is). */
  askDisabled: string;
  onAsk: () => void;
  onUnwire: () => void;
  onClose: () => void;
}

/** The menu of a parameter port: ask for it when the run starts, or unwire it. */
function PortMenu({ x, y, label, wired, askDisabled, onAsk, onUnwire, onClose }: PortMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close.current();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, []);
  return (
    <div
      ref={ref}
      className={styles.portMenu}
      role="menu"
      aria-label={`${label} options`}
      style={{ left: x, top: y }}
      data-no-wheel="1"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <button type="button" role="menuitem" className={styles.portMenuItem} aria-disabled={askDisabled ? true : undefined} data-tip={askDisabled || "Add a run parameter with this setting's label and value, and wire it here. Starting a run asks for it."} onClick={() => !askDisabled && onAsk()}>
        Ask when the run starts
      </button>
      {askDisabled && <span className={styles.portMenuNote}>{askDisabled}</span>}
      <button type="button" role="menuitem" className={styles.portMenuItem} aria-disabled={wired ? undefined : true} data-tip={wired ? "Take the wire off: the step uses its own setting again" : "Nothing is wired here"} onClick={() => wired && onUnwire()}>
        Unwire
      </button>
    </div>
  );
}

/** Screen position just under a node (where a refusal tooltip sits while hovering it). */
function hoverPoint(id: string, nodes: ReadonlyMap<string, GraphNode>, v: View): Pt {
  const n = nodes.get(id);
  if (!n) return { x: 0, y: 0 };
  return { x: n.x * v.zoom + v.x, y: (n.y + n.h) * v.zoom + v.y + 6 };
}
