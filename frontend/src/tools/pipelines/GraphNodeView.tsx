import type { PointerEvent } from "react";
import { Badge, Icon, IconButton, cx } from "@/components";
import type { PipelineStep, StepCheck, StepType } from "@/lib/api";
import { ALL_PORT, countsText, HEAD_H, INPUT_NODE, PORT_H, SUMMARY_H, type GraphNode, type StepRunCounts, type WireKind } from "./graphModel";
import { stepName } from "./stepHelpers";
import styles from "./GraphEditor.module.css";

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
  onPortDown: (e: PointerEvent<HTMLElement>, port: string) => void;
  onOptions: () => void;
  /** Kind of the wire coming in (colours the input port). */
  inKind?: WireKind;
}

/** One node of the graph: icon, name, a one-line state, output ports and an options button. */
export function GraphNodeView({ node, step, type, check, counts, selected, dropState, inKind, onPointerDown, onPortDown, onOptions }: GraphNodeViewProps) {
  const isInput = node.id === INPUT_NODE;
  const name = isInput ? "Input" : step ? stepName(step, type) : node.id;
  const problems = check?.problems ?? [];
  const live = countsText(counts);
  const needsYou = counts.needsYou > 0;
  const summary = isInput ? "Starts every run" : problems[0] ? problems[0] : live ? live : step?.manual ? "You do this step" : (check?.info.summary ?? "");
  return (
    <div
      className={cx(styles.node, selected && styles.nodeSelected, problems.length > 0 && styles.nodeProblem, isInput && styles.nodeInput, dropState === "ok" && styles.dropOk, dropState === "bad" && styles.dropBad)}
      style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
      data-node-id={node.id}
      role="group"
      aria-label={`${name} node`}
      onPointerDown={onPointerDown}
    >
      {!isInput && <span className={cx(styles.inPort, inKind && styles[`k_${inKind}`])} style={{ top: HEAD_H / 2 - 6 }} data-in-port={node.id} data-tip="Drop a wire here to feed this step" />}
      <div className={styles.head} style={{ height: HEAD_H }}>
        <Icon name={isInput ? "arrow-down-to-line" : (type?.icon ?? "box")} size={16} className={styles.nodeIcon} />
        <span className={styles.nodeName}>{name}</span>
        {needsYou && <Badge tone="accent" tip="A run is waiting for you at this step">Needs you</Badge>}
        {step?.manual && !needsYou && <Badge tone="accent" tip="The pipeline pauses here for you to do this step in its tool">Manual</Badge>}
        {problems.length > 0 && (
          <Badge tone="danger" tip={problems.join("\n")}>
            <span aria-hidden="true">⚠ </span>
            {problems.length}
            <span className={styles.srOnly}> {problems.length === 1 ? "problem" : "problems"}</span>
          </Badge>
        )}
        {!isInput && <IconButton size="sm" icon="sliders-horizontal" label={`Options for ${name}`} onClick={onOptions} onPointerDown={(e) => e.stopPropagation()} />}
      </div>
      <div className={cx(styles.summary, problems.length > 0 && styles.summaryBad)} style={{ height: SUMMARY_H }} title={summary}>
        {summary}
      </div>
      {node.ports.map((p) => (
        <div key={p.id} className={styles.portRow} style={{ height: PORT_H }}>
          <span className={styles.portLabel}>{p.label}</span>
          <span
            className={cx(styles.outDot, styles[`k_${p.kind}`])}
            data-out-port={p.id}
            data-node={node.id}
            role="button"
            tabIndex={-1}
            aria-label={`Wire from ${name}: ${p.id === ALL_PORT ? "all files" : p.label}`}
            data-tip="Drag from here to a step to wire it up"
            onPointerDown={(e) => onPortDown(e, p.id)}
          />
        </div>
      ))}
    </div>
  );
}
