import { useMemo } from "react";
import { Badge, SegmentedControl, Switch, TextArea } from "@/components";
import { diffLines, diffStats, sideBySide, unifiedText, type DiffOp } from "./diff.logic";
import { CopyButton, useDebounced } from "./shared";
import { useUtilState } from "../store";
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
  const [left, setLeft] = useUtilState("diff", "left", "");
  const [right, setRight] = useUtilState("diff", "right", "");
  const [view, setView] = useUtilState<"unified" | "side">("diff", "view", "unified");
  const [ignoreWhitespace, setIgnoreWhitespace] = useUtilState("diff", "ignoreWhitespace", false);
  const [ignoreCase, setIgnoreCase] = useUtilState("diff", "ignoreCase", false);
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
          <TextArea mono minRows={8} maxRows={18} value={left} onChange={(e) => setLeft(e.target.value)} aria-label="Original text" data-tip="The older or reference version" spellCheck={false} />
        </div>
        <div className={styles.col}>
          <span className={styles.label}>Changed</span>
          <TextArea mono minRows={8} maxRows={18} value={right} onChange={(e) => setRight(e.target.value)} aria-label="Changed text" data-tip="The newer version to compare against the original" spellCheck={false} />
        </div>
      </div>
      <div className={styles.row}>
        <SegmentedControl
          aria-label="Diff view"
          value={view}
          onChange={setView}
          options={[
            { value: "unified", label: "Unified", tip: "One list: removed lines marked - and added lines marked +" },
            { value: "side", label: "Side by side", tip: "Original on the left, changed on the right" },
          ]}
        />
        <Switch checked={ignoreWhitespace} onChange={setIgnoreWhitespace} label="Ignore whitespace" tip="Treat lines that differ only in spaces or tabs as equal" />
        <Switch checked={ignoreCase} onChange={setIgnoreCase} label="Ignore case" tip="Treat upper and lower case letters as the same" />
        {any && (
          <>
            <Badge tone="ok" tip="Lines added in the changed text">+{stats.added}</Badge>
            <Badge tone="danger" tip="Lines removed from the original">-{stats.removed}</Badge>
            <CopyButton text={unifiedText(ops)} label="Copy diff" what="the diff" />
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
