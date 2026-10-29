import { useMemo, useState } from "react";
import { Button, TextArea } from "@/components";
import { CASE_LABEL, LINE_OP_LABEL, convertCase, countText, lineOp, slugify, type CaseKind, type LineOp } from "./text.logic";
import { OutputBox, useDebounced } from "./shared";
import styles from "../DevUtils.module.css";

const CASES = Object.keys(CASE_LABEL) as CaseKind[];
const LINE_OPS = Object.keys(LINE_OP_LABEL) as LineOp[];

export default function TextUtil() {
  const [text, setText] = useState("");
  const d = useDebounced(text);
  const counts = useMemo(() => countText(d), [d]);

  return (
    <div className={styles.util}>
      <div className={styles.col}>
        <span className={styles.label}>Text</span>
        <TextArea mono minRows={6} maxRows={16} value={text} onChange={(e) => setText(e.target.value)} aria-label="Text" spellCheck={false} />
        <div className={styles.row}>
          {LINE_OPS.map((op) => (
            <Button key={op} size="sm" variant="secondary" onClick={() => setText(lineOp(text, op))}>
              {LINE_OP_LABEL[op]}
            </Button>
          ))}
        </div>
      </div>
      <table className={styles.table} aria-label="Counts">
        <tbody>
          <tr>
            <th scope="row">Characters</th>
            <td>{counts.chars}</td>
            <th scope="row">Words</th>
            <td>{counts.words}</td>
            <th scope="row">Lines</th>
            <td>{counts.lines}</td>
            <th scope="row">UTF-8 bytes</th>
            <td>{counts.bytes}</td>
          </tr>
        </tbody>
      </table>
      <div className={styles.cols}>
        {CASES.map((k) => (
          <OutputBox key={k} label={CASE_LABEL[k]} value={convertCase(d, k)} />
        ))}
        <OutputBox label="Slug" value={slugify(d)} />
      </div>
    </div>
  );
}
