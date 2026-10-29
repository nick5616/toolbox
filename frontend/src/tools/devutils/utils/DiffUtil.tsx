import { useMemo, useState } from "react";
import { Badge, SegmentedControl, Switch, TextArea } from "@/components";
import { diffLines, diffStats, sideBySide, unifiedText, type DiffOp } from "./diff.logic";
import { CopyButton, useDebounced } from "./shared";
import styles from "../DevUtils.module.css";

function Line({ op, num }: { op: DiffOp | undefined; num?: number }) {
  if (!op) return <div className={styles.diffLine} />;
  const cls = op.kind === "add" ? styles.diffAdd : op.kind === "del" ? styles.diffDel : "";
  const mark = op.kind === "add" ? "+" : op.kind === "del" ? "-" : " ";
  return (
    <div className={`${styles.diffLine} ${cls}`}>
      <span className={styles.diffNum}>{num ?? ""}</span>
      <span>
        {mark} {op.text}
      </span>
    </div>
  );
}

export default function DiffUtil() {
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [view, setView] = useState<"unified" | "side">("unified");
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [ignoreCase, setIgnoreCase] = useState(false);
  const dl = useDebounced(left);
  const dr = useDebounced(right);

  const ops = useMemo(() => diffLines(dl, dr, { ignoreWhitespace, ignoreCase }), [dl, dr, ignoreWhitespace, ignoreCase]);
  const stats = diffStats(ops);
  const rows = useMemo(() => (view === "side" ? sideBySide(ops) : []), [ops, view]);
  const any = dl !== "" || dr !== "";

  return (
    <div className={styles.util}>
      <div className={styles.cols}>
        <div className={styles.col}>
          <span className={styles.label}>Original</span>
          <TextArea mono minRows={8} maxRows={18} value={left} onChange={(e) => setLeft(e.target.value)} aria-label="Original text" spellCheck={false} />
        </div>
        <div className={styles.col}>
          <span className={styles.label}>Changed</span>
          <TextArea mono minRows={8} maxRows={18} value={right} onChange={(e) => setRight(e.target.value)} aria-label="Changed text" spellCheck={false} />
        </div>
      </div>
      <div className={styles.row}>
        <SegmentedControl
          aria-label="Diff view"
          value={view}
          onChange={setView}
          options={[
            { value: "unified", label: "Unified" },
            { value: "side", label: "Side by side" },
          ]}
        />
        <Switch checked={ignoreWhitespace} onChange={setIgnoreWhitespace} label="Ignore whitespace" />
        <Switch checked={ignoreCase} onChange={setIgnoreCase} label="Ignore case" />
        {any && (
          <>
            <Badge tone="ok">+{stats.added}</Badge>
            <Badge tone="danger">-{stats.removed}</Badge>
            <CopyButton text={unifiedText(ops)} label="Copy diff" />
          </>
        )}
      </div>
      {any && (
        <div className={styles.diffBox} aria-label="Diff">
          {stats.added === 0 && stats.removed === 0 ? (
            <p className={styles.note} style={{ padding: "var(--space-3)", margin: 0 }}>
              The texts are identical{ignoreWhitespace || ignoreCase ? " with the current ignore settings" : ""}.
            </p>
          ) : view === "unified" ? (
            ops.map((op, i) => <Line key={i} op={op} num={op.kind === "add" ? op.b : op.a} />)
          ) : (
            <div className={styles.diffSide}>
              <div>
                {rows.map((r, i) => (
                  <Line key={i} op={r.left} num={r.left?.a} />
                ))}
              </div>
              <div>
                {rows.map((r, i) => (
                  <Line key={i} op={r.right} num={r.right?.b} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
