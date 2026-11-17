import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { Button, IconButton, cx } from "@/components";
import { useElementSize } from "@/lib/useElementSize";
import { useJobs } from "@/state/jobs";
import { usePipelines, type RunView } from "@/state/pipelines";
import { inPortPos, INPUT_NODE, MAX_ZOOM, MIN_ZOOM, outPortPos, paramPortPos, valueOutPos, wiredPortsByNode, wirePath, type Pt, type View } from "./graphModel";
import { WireCanvas, type WireSpec } from "./graph/WireCanvas";
import { svgWireStyle } from "./graph/wireStyle";
import { GraphNodeView } from "./GraphNodeView";
import { cellProgress } from "./RunGrid";
import { focusBands, focusSpans } from "./editorModel";
import { FocusBands } from "./FocusBands";
import { RunGraphPanel } from "./RunGraphPanel";
import { emptyStats, filesText, needsYouSteps, runGraph, runWireState, statsText, stepProgress, stepStats, wrapRunGraph, type StepRunStats } from "./RunGraphModel";
import graphStyles from "./GraphEditor.module.css";
import styles from "./RunGraph.module.css";

const DRAG_THRESHOLD = 3;
/** A run graph may fit smaller than the editor's 75 %: it is read, not edited. */
const FIT_MIN_ZOOM = 0.5;
const clampZoom = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));

/** The run block under a node: a progress bar while running, the first error, the file count. */
function RunFoot({ stats, progress }: { stats: StepRunStats; progress: number }) {
  const running = stats.running > 0;
  const files = filesText(stats.files);
  return (
    <div className={styles.foot} data-testid="run-foot">
      <div className={styles.bar} aria-hidden={!running}>
        {running && (
          <div
            className={cx(styles.barFill, progress < 0 && styles.barIndeterminate)}
            role="progressbar"
            aria-label="Step progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress < 0 ? undefined : Math.round(progress * 100)}
            style={progress < 0 ? undefined : { width: `${Math.round(progress * 100)}%` }}
          />
        )}
      </div>
      <div className={cx(styles.line, styles.err)} title={stats.error || undefined}>
        {stats.error}
      </div>
      <div className={styles.line}>{files}</div>
    </div>
  );
}

/** A run as a read-only graph (the editor's nodes and glowing wires); a click on a step shows its cells. */
export function RunGraph({ run }: { run: RunView }) {
  const catalog = usePipelines((s) => s.catalog);
  // Per-step progress numbers, shallow-stable: unrelated job ticks (or unchanged values) don't re-render the graph.
  const stepPcts = useJobs(useShallow((s) => run.steps.map((st) => stepProgress(run, st.id, (c) => cellProgress(c, s.byId)))));
  const [vp, setVp] = useState<HTMLDivElement | null>(null);
  const size = useElementSize(vp);
  const [view, setViewState] = useState<View>({ x: 24, y: 24, zoom: 1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [glActive, setGlActive] = useState(false);
  const latest = useRef({ view });
  latest.current = { view };
  const fitted = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanup.current?.(), []);

  // Wrapped into rows when the chain is wider than the panel at a readable zoom.
  const entries = usePipelines((s) => s.entries);
  const runParams = useMemo(() => entries.find((e) => e.pipeline.id === run.pipelineId)?.pipeline.params ?? [], [entries, run.pipelineId]);
  const graph = useMemo(() => wrapRunGraph(runGraph(run.steps, { catalog, params: runParams }), size.width), [run.steps, catalog, runParams, size.width]);
  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n] as const)), [graph.nodes]);
  const wiredBy = useMemo(() => wiredPortsByNode(graph), [graph]);
  const bands = useMemo(() => focusBands(focusSpans(run.steps ?? []), graph.nodes), [run.steps, graph.nodes]);
  const stats = useMemo(() => new Map(run.steps.map((s) => [s.id, stepStats(run, s.id)] as const)), [run]);
  const progress = useMemo(() => new Map(run.steps.map((s, i) => [s.id, stepPcts[i] ?? -1] as const)), [run.steps, stepPcts]);
  const needs = useMemo(() => needsYouSteps(run), [run]);
  const files = useMemo(() => (run.inputs.length === 0 ? 0 : run.items.filter((i) => i.merged.length === 0).length), [run.inputs, run.items]);

  const setView = (next: View | ((v: View) => View)) => {
    const v = typeof next === "function" ? next(latest.current.view) : next;
    latest.current.view = v;
    setViewState(v);
  };

  const zoomAt = (factor: number, at: Pt) =>
    setView((v) => {
      const zoom = clampZoom(v.zoom * factor);
      const k = zoom / v.zoom;
      return { zoom, x: at.x - (at.x - v.x) * k, y: at.y - (at.y - v.y) * k };
    });

  const fit = useCallback(() => {
    const ns = graph.nodes;
    if (ns.length === 0 || size.width === 0 || size.height === 0) return;
    const x0 = Math.min(...ns.map((n) => n.x));
    const y0 = Math.min(...ns.map((n) => n.y));
    const x1 = Math.max(...ns.map((n) => n.x + n.w));
    const y1 = Math.max(...ns.map((n) => n.y + n.h));
    const pad = 24;
    const zx = (size.width - pad * 2) / (x1 - x0);
    const zy = (size.height - pad * 2) / (y1 - y0);
    const zoom = Math.max(FIT_MIN_ZOOM, Math.min(1, zx, zy));
    const x = zx >= FIT_MIN_ZOOM ? (size.width - (x1 - x0) * zoom) / 2 - x0 * zoom : pad - x0 * zoom;
    const y = zy >= FIT_MIN_ZOOM ? (size.height - (y1 - y0) * zoom) / 2 - y0 * zoom : pad - y0 * zoom;
    setView({ zoom, x, y });
  }, [graph.nodes, size.width, size.height]);

  // Fit when the run opens (the panel keys this component by run).
  useEffect(() => {
    if (fitted.current || size.width === 0 || size.height === 0) return;
    fitted.current = true;
    fit();
  }, [size.width, size.height, fit]);

  // The wheel pans; Ctrl/Cmd+wheel zooms at the cursor.
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

  const onViewportDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.bg) return;
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    vp?.focus();
    const startX = e.clientX;
    const startY = e.clientY;
    const start = latest.current.view;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      moved = true;
      setView({ ...start, x: start.x + dx, y: start.y + dy });
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      cleanup.current = null;
    };
    const up = () => {
      stop();
      if (!moved) setSelected(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    cleanup.current = stop;
  };

  const wireSpecs = useMemo<WireSpec[]>(() => {
    const out: WireSpec[] = [];
    for (const w of graph.wires) {
      const a = nodeById.get(w.from);
      const b = nodeById.get(w.to);
      if (!a || !b) continue;
      const to = stats.get(w.to) ?? emptyStats();
      const from = w.from === INPUT_NODE ? undefined : (stats.get(w.from) ?? emptyStats());
      const value = w.channel === "value";
      out.push({
        id: w.id,
        a: value ? valueOutPos(a, w.port) : outPortPos(a, w.port),
        b: value ? paramPortPos(b, w.param ?? "") : inPortPos(b),
        type: value ? (w.valueType ?? "any") : "files",
        value,
        dashed: value && w.loose === true,
        state: runWireState(from, to),
      });
    }
    return out;
  }, [graph.wires, nodeById, stats]);

  const centre = { x: size.width / 2, y: size.height / 2 };
  const selectedStep = selected ? run.steps.find((s) => s.id === selected) : undefined;
  const firstNeed = needs[0];

  return (
    <div className={styles.root}>
      <div className={styles.stage}>
        <div
          ref={setVp}
          className={graphStyles.viewport}
          tabIndex={0}
          role="application"
          aria-label="Run graph. Click a step to see its files and progress for every file."
          data-bg="1"
          onPointerDown={onViewportDown}
        >
          <WireCanvas wires={wireSpecs} view={view} width={size.width} height={size.height} onGL={setGlActive} />
          <div className={graphStyles.layer} data-bg="1" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
            <svg className={graphStyles.wires} width="1" height="1" aria-hidden="true">
              {wireSpecs.map((w) => (
                <path
                  key={w.id}
                  d={wirePath(w.a, w.b)}
                  className={cx(graphStyles.wire, glActive && graphStyles.wireHidden, w.state === "failed" && graphStyles.wireFailed, w.state === "dim" && styles.wireDim)}
                  style={svgWireStyle(w.type, w.value === true, w.dashed === true, w.state === "failed")}
                />
              ))}
            </svg>
            <FocusBands bands={bands} />
            {graph.nodes.map((n) => {
              const step = run.steps.find((s) => s.id === n.id);
              const st = stats.get(n.id) ?? emptyStats();
              const isInput = n.id === INPUT_NODE;
              return (
                <GraphNodeView
                  key={n.id}
                  node={n}
                  step={step}
                  type={step ? catalog.find((t) => t.id === step.type) : undefined}
                  counts={st}
                  selected={selected === n.id}
                  readOnly
                  className={cx(st.needsYou > 0 && styles.attention, st.failed > 0 && styles.failed)}
                  summary={isInput ? (filesText(files) || (run.inputs.length === 0 ? "No files" : "Starts every run")) : statsText(st)}
                  footer={isInput ? undefined : <RunFoot stats={st} progress={progress.get(n.id) ?? -1} />}
                  inKind={graph.wires.find((w) => w.to === n.id && w.channel === "files")?.kind}
                  wired={wiredBy.get(n.id)}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    if (!isInput) setSelected((cur) => (cur === n.id ? null : n.id));
                  }}
                />
              );
            })}
          </div>
        </div>

        <div className={graphStyles.toolbar} data-no-wheel="1">
          <IconButton size="sm" icon="zoom-out" label="Zoom out" onClick={() => zoomAt(1 / 1.2, centre)} />
          <span className={graphStyles.zoom} aria-live="polite">{Math.round(view.zoom * 100)}%</span>
          <IconButton size="sm" icon="zoom-in" label="Zoom in" onClick={() => zoomAt(1.2, centre)} />
          <IconButton size="sm" icon="maximize" label="Fit everything in view" onClick={fit} />
          {firstNeed && (
            <Button size="sm" variant="primary" data-tip="A step is waiting for you: open it to continue or skip" onClick={() => setSelected(firstNeed)}>
              {needs.length === 1 ? "1 step needs you" : `${needs.length} steps need you`}
            </Button>
          )}
        </div>

        {selectedStep && <RunGraphPanel run={run} step={selectedStep} onClose={() => setSelected(null)} />}
      </div>
    </div>
  );
}
