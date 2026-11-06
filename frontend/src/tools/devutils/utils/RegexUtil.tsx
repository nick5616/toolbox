import { useMemo } from "react";
import { TextArea, TextField } from "@/components";
import { runRegex, segments } from "./regex.logic";
import { CopyButton, OutputBox, SaveButton, useDebounced } from "./shared";
import { useUtilState } from "../store";
import styles from "../DevUtils.module.css";

export default function RegexUtil() {
  const [pattern, setPattern] = useUtilState("regex", "pattern", "");
  const [flags, setFlags] = useUtilState("regex", "flags", "g");
  const [text, setText] = useUtilState("regex", "text", "");
  const [replacement, setReplacement] = useUtilState("regex", "replacement", "");
  const dPattern = useDebounced(pattern);
  const dFlags = useDebounced(flags);
  const dText = useDebounced(text);
  const dRepl = useDebounced(replacement);

  const outcome = useMemo(() => runRegex(dPattern, dFlags, dText, dRepl === "" ? null : dRepl), [dPattern, dFlags, dText, dRepl]);
  const segs = useMemo(() => (outcome.ok ? segments(dText, outcome.matches) : []), [outcome, dText]);
  const groupCount = outcome.ok ? Math.max(0, ...outcome.matches.map((m) => m.groups.length)) : 0;
  const namedKeys = outcome.ok ? [...new Set(outcome.matches.flatMap((m) => Object.keys(m.named)))] : [];

  return (
    <div className={styles.util}>
      <p className={styles.note}>JavaScript regular expressions (the engine this app runs on), including named groups and lookbehind.</p>
      <div className={styles.row}>
        <TextField
          mono
          value={pattern}
          invalid={!outcome.ok}
          onChange={(e) => setPattern(e.target.value)}
          aria-label="Pattern"
          data-tip="The regular expression, without the surrounding slashes"
          placeholder="pattern"
          icon="regex"
          wrapperClassName={styles.col}
          spellCheck={false}
        />
        <TextField mono value={flags} invalid={!outcome.ok} onChange={(e) => setFlags(e.target.value)} aria-label="Flags" data-tip="Letters that change matching: g all matches, i ignore case, m multiline, s dot matches newline, u unicode" placeholder="flags" size="md" spellCheck={false} style={{ width: 96 }} />
      </div>
      {!outcome.ok && <p className={styles.error}>{outcome.message}</p>}
      <div className={styles.col}>
        <span className={styles.label}>Test text</span>
        <TextArea mono minRows={5} maxRows={14} value={text} onChange={(e) => setText(e.target.value)} aria-label="Test text" data-tip="Sample text to run the pattern against" spellCheck={false} />
      </div>
      {outcome.ok && dText !== "" && (
        <div className={styles.col}>
          <div className={styles.outHead}>
            <span className={styles.label}>
              {outcome.matches.length === 0 ? "No matches" : `${outcome.matches.length}${outcome.truncated ? "+" : ""} ${outcome.matches.length === 1 ? "match" : "matches"}`}
            </span>
          </div>
          <pre className={styles.out} aria-label="Highlighted matches" data-tip="Matches are highlighted; alternating colours separate neighbours">
            {segs.map((s, i) => (s.match ? <mark key={i} className={(s.n ?? 0) % 2 === 0 ? styles.match : styles.matchAlt}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
          </pre>
        </div>
      )}
      {outcome.ok && outcome.matches.length > 0 && (
        <table className={styles.table} aria-label="Groups">
          <thead>
            <tr>
              <th>#</th>
              <th data-tip="Where the match starts in the text, counting from 0">Index</th>
              <th data-tip="The text that matched">Match</th>
              {Array.from({ length: groupCount }, (_, i) => (
                <th key={i}>${i + 1}</th>
              ))}
              {namedKeys.map((k) => (
                <th key={k}>{k}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {outcome.matches.slice(0, 200).map((m, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td className={styles.mono}>{m.index}</td>
                <td className={styles.mono}>{m.text}</td>
                {Array.from({ length: groupCount }, (_, g) => (
                  <td key={g} className={styles.mono}>
                    {m.groups[g] ?? "—"}
                  </td>
                ))}
                {namedKeys.map((k) => (
                  <td key={k} className={styles.mono}>
                    {m.named[k] ?? "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className={styles.col}>
        <span className={styles.label}>Replace with</span>
        <TextField mono value={replacement} onChange={(e) => setReplacement(e.target.value)} aria-label="Replacement" data-tip="Text to replace each match with. Use $1 for a group and $& for the whole match" placeholder="$1-$2, $<name>, $&" spellCheck={false} />
      </div>
      {outcome.ok && outcome.replaced !== null && <OutputBox label="Replace preview" value={outcome.replaced} filename="replaced.txt" />}
      {outcome.ok && outcome.matches.length > 0 && (
        <div>
          <CopyButton text={outcome.matches.map((m) => m.text).join("\n")} label="Copy matches" />
          <SaveButton text={outcome.matches.map((m) => m.text).join("\n")} filename="matches.txt" what="the matches" />
        </div>
      )}
    </div>
  );
}
