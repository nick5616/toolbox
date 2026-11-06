import { useMemo } from "react";
import { Button, TextArea } from "@/components";
import { CASE_LABEL, LINE_OP_LABEL, convertCase, countText, lineOp, slugify, type CaseKind, type LineOp } from "./text.logic";
import { OutputBox, useDebounced } from "./shared";
import { useUtilState } from "../store";
import styles from "../DevUtils.module.css";

const CASES = Object.keys(CASE_LABEL) as CaseKind[];
const LINE_OP_TIP: Record<LineOp, string> = {
  "sort-asc": "Sort the lines alphabetically; numbers count by value",
  "sort-desc": "Sort the lines in reverse alphabetical order",
  dedupe: "Keep only the first copy of each repeated line",
  trim: "Remove spaces at the start and end of every line",
  reverse: "Flip the order of the lines",
  "remove-empty": "Delete lines that are blank",
};
const LINE_OPS = Object.keys(LINE_OP_LABEL) as LineOp[];

export default function TextUtil() {
  const [text, setText] = useUtilState("text", "text", "");
  const d = useDebounced(text);
  const counts = useMemo(() => countText(d), [d]);

  return (
    <div className={styles.util}>
      <div className={styles.col}>
        <span className={styles.label}>Text</span>
        <TextArea mono minRows={6} maxRows={16} value={text} onChange={(e) => setText(e.target.value)} aria-label="Text" data-tip="Paste or type text; the counts and case conversions update as you type" spellCheck={false} />
        <div className={styles.row}>
          {LINE_OPS.map((op) => (
            <Button key={op} size="sm" variant="secondary" data-tip={LINE_OP_TIP[op]} onClick={() => setText(lineOp(text, op))}>
              {LINE_OP_LABEL[op]}
            </Button>
          ))}
        </div>
      </div>
      <table className={styles.table} aria-label="Counts">
        <tbody>
          <tr>
            <th scope="row" data-tip="Number of characters, counting each emoji or accent as one">Characters</th>
            <td>{counts.chars}</td>
            <th scope="row" data-tip="Groups of letters separated by spaces or line breaks">Words</th>
            <td>{counts.words}</td>
            <th scope="row" data-tip="Number of lines, split at line breaks">Lines</th>
            <td>{counts.lines}</td>
            <th scope="row" data-tip="Size of the text when saved as UTF-8, the usual file encoding">UTF-8 bytes</th>
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
