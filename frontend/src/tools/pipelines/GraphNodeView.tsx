import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent, ReactNode } from "react";
import { Badge, Icon, IconButton, cx } from "@/components";
import type { PipelineStep, StepCheck, StepType } from "@/lib/api";
import { VALUE_TYPE_LABELS } from "@/pipelines/params";
import { typeStyle } from "./graph/wireStyle";
import { ALL_PORT, bodyRows, countsText, HEAD_H, INPUT_NODE, PORT_H, SUMMARY_H, type GraphNode, type StepRunCounts, type WireKind } from "./graphModel";
import { isTimeStep } from "./editorModel";
import { stepName } from "./stepHelpers";
import styles from "./GraphEditor.module.css";

/** How a port looks while a wire is being dragged: a legal target, or one that can't take it. */
export type PortState = "ok" | "dim";
export type PortKind = "param" | "value";

/** What the editor lends a node to make its ports live (absent in the read-only Runs graph). */
export interface NodePortApi {
  /** While dragging: how each port looks. */
  state: (kind: PortKind, id: string) => PortState | undefined;
  onValueDown: (e: PointerEvent<HTMLElement>, name: string) => void;
  onParamDown: (e: PointerEvent<HTMLElement>, pointer: string) => void;
  /** Enter / Space on a port (keyboard wiring). */
  onActivate: (kind: PortKind, id: string) => void;
  /** Right-click, the ⋯ button or the menu key. */
  onMenu: (kind: PortKind, id: string, at: { x: number; y: number }) => void;
  /** A click on a parameter row (not its port). */
  onRowClick: (pointer: string) => void;
  onToggleMore: () => void;
}

export interface GraphNodeViewProps {
  node: GraphNode;
  step?: PipelineStep;
  type?: StepType;
  check?: StepCheck;
  counts: StepRunCounts;
  selected: boolean;
  /** A wire is being dragged and this is a legal drop target / an illegal one. */
  dropState?: "ok" | "bad";
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onPortDown?: (e: PointerEvent<HTMLElement>, port: string) => void;
  onOptions?: () => void;
  /** Kind of the files coming in (named in the port's tooltip; the port itself is always orange). */
  inKind?: WireKind;
  /** Ports that have a wire: "in", "out:<port>", "val:<name>", "param:<pointer>". Wired ports are filled. */
  wired?: ReadonlySet<string>;
  /** Live ports (the editor). Without it the node is read-only. */
  api?: NodePortApi;
  /** Read-only (the Runs graph): no options button, no wiring from the ports. */
  readOnly?: boolean;
  /** Replaces the one-line state under the name. */
  summary?: string;
  /** Extra content under the ports (the Runs graph shows run progress there). */
  footer?: ReactNode;
  className?: string;
}

const KIND_NOUN: Record<WireKind, string> = { audio: "audio", video: "video", image: "images", document: "documents", text: "text files", other: "other files", any: "files" };

const typed = typeStyle;

const EMPTY: ReadonlySet<string> = new Set();

/** One node of the graph: icon, name, a one-line state, parameter rows on the left, file and value outputs on the right. */
export function GraphNodeView({ node, step, type, check, counts, selected, dropState, inKind, wired = EMPTY, api, readOnly: readOnlyProp, summary: summaryOverride, footer, className, onPointerDown, onPortDown, onOptions }: GraphNodeViewProps) {
  const isInput = node.id === INPUT_NODE;
  const readOnly = readOnlyProp === true || !api;
  const name = isInput ? "Input" : step ? stepName(step, type) : node.id;
  const problems = check?.problems ?? [];
  const live = countsText(counts);
  const needsYou = counts.needsYou > 0;
  const summary = summaryOverride ?? (isInput ? "Starts every run" : problems[0] ? problems[0] : live ? live : step?.manual ? "You do this step" : (check?.info.summary ?? ""));

  const keyOf = (kind: PortKind, id: string, act: () => void) => (e: ReactKeyboardEvent<HTMLElement>) => {
    if (!api) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      act();
    } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      api.onMenu(kind, id, { x: r.left, y: r.bottom });
    }
  };

  // The two columns, row by row.
  const left: ReactNode[] = [];
  const right: ReactNode[] = [];

  if (!isInput) {
    const on = wired.has("in");
    left.push(
      <div key="files" className={styles.cellL}>
        <span
          className={cx(styles.dotFiles, on && styles.dotOn)}
          style={typed("files")}
          data-in-port={node.id}
          data-tip={readOnly ? undefined : `Drop a wire here to feed this step${inKind ? ` (${KIND_NOUN[inKind]} arrive now)` : ""}`}
        />
        <span className={styles.pLabel}>Files</span>
        {inKind && inKind !== "any" && <span className={styles.pValue}>{KIND_NOUN[inKind]}</span>}
      </div>,
    );
  }
  for (const p of node.params) {
    const st = api?.state("param", p.pointer);
    const on = wired.has(`param:${p.pointer}`);
    const w = p.wired;
    const tip = w ? (w.resolved ? `${p.label}: wired to ${w.label}${w.loose ? `. ${w.reason}` : ""}. If it's empty, the step uses ${p.own}.` : w.reason) : `${p.label} (${VALUE_TYPE_LABELS[p.type].toLowerCase()}): ${p.own}`;
    left.push(
      <div
        key={`p:${p.pointer}`}
        className={cx(styles.cellL, styles.paramRow, st === "ok" && styles.portOk, st === "dim" && styles.portDim, w && !w.resolved && styles.rowBad)}
        data-param-row={p.pointer}
        data-node={node.id}
        data-tip={tip}
        onClick={readOnly ? undefined : () => api?.onRowClick(p.pointer)}
        onContextMenu={
          readOnly
            ? undefined
            : (e) => {
                e.preventDefault();
                api?.onMenu("param", p.pointer, { x: e.clientX, y: e.clientY });
              }
        }
      >
        <span
          className={cx(styles.dotValue, on && styles.dotOn)}
          style={typed(w?.resolved ? w.type : p.type)}
          data-param-port={p.pointer}
          data-node={node.id}
          role={readOnly ? undefined : "button"}
          tabIndex={readOnly ? undefined : 0}
          aria-label={readOnly ? undefined : `${p.label} of ${name}${w ? `, wired to ${w.label}` : ""}. Press Enter to wire it, the menu key for more.`}
          onPointerDown={readOnly ? undefined : (e) => api?.onParamDown(e, p.pointer)}
          onKeyDown={readOnly ? undefined : keyOf("param", p.pointer, () => api?.onActivate("param", p.pointer))}
        />
        <span className={styles.pLabel}>{p.label}</span>
        <span className={cx(styles.pValue, w && styles.pWired)}>{p.display}</span>
        {!readOnly && (
          <button
            type="button"
            className={styles.rowMenu}
            aria-label={`More for ${p.label}`}
            data-tip="More: ask for this when the run starts, or unwire it"
            tabIndex={-1}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              api?.onMenu("param", p.pointer, { x: r.left, y: r.bottom });
            }}
          >
            <Icon name="ellipsis" size={12} />
          </button>
        )}
      </div>,
    );
  }

  for (const p of node.ports) {
    const on = wired.has(`out:${p.id}`);
    right.push(
      <div key={`f:${p.id}`} className={styles.cellR}>
        <span className={styles.portLabel}>{p.label}</span>
        <span
          className={cx(styles.dotFiles, styles.dotOut, on && styles.dotOn)}
          style={typed("files")}
          data-out-port={p.id}
          data-node={node.id}
          role={readOnly ? undefined : "button"}
          tabIndex={readOnly ? undefined : -1}
          aria-label={readOnly ? undefined : `Wire from ${name}: ${p.id === ALL_PORT ? "all files" : p.label}`}
          data-tip={readOnly ? undefined : `${p.label}${p.kind !== "any" ? ` (${KIND_NOUN[p.kind]})` : ""}: drag from here to a step to wire it up`}
          onPointerDown={readOnly ? undefined : (e) => onPortDown?.(e, p.id)}
        />
      </div>,
    );
  }
  for (const v of node.values) {
    const st = api?.state("value", v.id);
    const on = wired.has(`val:${v.id}`);
    right.push(
      <div key={`v:${v.id}`} className={cx(styles.cellR, styles.valueRow, st === "ok" && styles.portOk, st === "dim" && styles.portDim)} data-value-row={v.id} data-node={node.id}>
        <span className={styles.portLabel} data-tip={`${v.label} (${VALUE_TYPE_LABELS[v.type].toLowerCase()})`}>
          {v.label}
        </span>
        <span
          className={cx(styles.dotValue, styles.dotOut, on && styles.dotOn)}
          style={typed(v.type)}
          data-value-out={v.id}
          data-node={node.id}
          role={readOnly ? undefined : "button"}
          tabIndex={readOnly ? undefined : 0}
          aria-label={readOnly ? undefined : `${v.label} from ${name}. Press Enter to wire it to a setting.`}
          data-tip={readOnly ? undefined : `${v.label} (${VALUE_TYPE_LABELS[v.type].toLowerCase()}): drag to a setting on a later step`}
          onPointerDown={readOnly ? undefined : (e) => api?.onValueDown(e, v.id)}
          onKeyDown={readOnly ? undefined : keyOf("value", v.id, () => api?.onActivate("value", v.id))}
        />
      </div>,
    );
  }

  if (node.more && !readOnly) {
    const btn = (
      <button
        key="more"
        type="button"
        className={styles.moreBtn}
        aria-expanded={node.more.expanded}
        data-tip={node.more.expanded ? "Show only the main settings" : "Show every setting of this tool"}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => api?.onToggleMore()}
      >
        {node.more.expanded ? "Fewer" : `+ ${node.more.count} more`}
      </button>
    );
    (node.more.side === "left" ? left : right).push(<div key="moreRow" className={node.more.side === "left" ? styles.cellL : styles.cellR}>{btn}</div>);
  }

  const rows = bodyRows(left.length, right.length);

  return (
    <div
      className={cx(styles.node, selected && styles.nodeSelected, problems.length > 0 && styles.nodeProblem, isInput && styles.nodeInput, dropState === "ok" && styles.dropOk, dropState === "bad" && styles.dropBad, className)}
      style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
      data-node-id={node.id}
      role="group"
      aria-label={`${name} node`}
      onPointerDown={onPointerDown}
    >
      <div className={styles.head} style={{ height: HEAD_H }}>
        <Icon name={isInput ? "arrow-down-to-line" : (type?.icon ?? "box")} size={16} className={styles.nodeIcon} />
        <span className={styles.nodeName}>{name}</span>
        {isTimeStep(step) && (
          <span className={styles.clock} data-clock-badge="" data-tip="This step waits for a time or for a focus session to end">
            <Icon name="timer" size={13} />
          </span>
        )}
        {needsYou && <Badge tone="accent" tip="A run is waiting for you at this step">Needs you</Badge>}
        {step?.manual && !needsYou && <Badge tone="accent" tip="The pipeline pauses here for you to do this step in its tool">Manual</Badge>}
        {problems.length > 0 && (
          <Badge tone="danger" tip={problems.join("\n")}>
            <span aria-hidden="true">⚠ </span>
            {problems.length}
            <span className={styles.srOnly}> {problems.length === 1 ? "problem" : "problems"}</span>
          </Badge>
        )}
        {!readOnly && onOptions && <IconButton size="sm" icon="sliders-horizontal" label={`Options for ${name}`} onClick={onOptions} onPointerDown={(e) => e.stopPropagation()} />}
      </div>
      <div className={cx(styles.summary, problems.length > 0 && styles.summaryBad)} style={{ height: SUMMARY_H }} title={summary}>
        {summary}
      </div>
      <div className={styles.body} style={{ height: rows * PORT_H }}>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className={styles.portRow} style={{ height: PORT_H }}>
            {left[i] ?? <div className={styles.cellEmpty} />}
            {right[i]}
          </div>
        ))}
      </div>
      {footer}
    </div>
  );
}
