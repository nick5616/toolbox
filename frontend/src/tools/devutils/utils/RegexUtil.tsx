import { useMemo, useState } from "react";
import { TextArea, TextField } from "@/components";
import { runRegex, segments } from "./regex.logic";
import { CopyButton, OutputBox, useDebounced } from "./shared";
import styles from "../DevUtils.module.css";

export default function RegexUtil() {
  const [pattern, setPattern] = useState("");
  const [flags, setFlags] = useState("g");
  const [text, setText] = useState("");
  const [replacement, setReplacement] = useState("");
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
          placeholder="pattern"
          icon="regex"
          wrapperClassName={styles.col}
          spellCheck={false}
        />
        <TextField mono value={flags} invalid={!outcome.ok} onChange={(e) => setFlags(e.target.value)} aria-label="Flags" placeholder="flags" size="md" spellCheck={false} style={{ width: 96 }} />
      </div>
      {!outcome.ok && <p className={styles.error}>{outcome.message}</p>}
      <div className={styles.col}>
        <span className={styles.label}>Test text</span>
        <TextArea mono minRows={5} maxRows={14} value={text} onChange={(e) => setText(e.target.value)} aria-label="Test text" spellCheck={false} />
      </div>
      {outcome.ok && dText !== "" && (
        <div className={styles.col}>
          <div className={styles.outHead}>
            <span className={styles.label}>
              {outcome.matches.length === 0 ? "No matches" : `${outcome.matches.length}${outcome.truncated ? "+" : ""} ${outcome.matches.length === 1 ? "match" : "matches"}`}
            </span>
          </div>
          <pre className={styles.out} aria-label="Highlighted matches">
            {segs.map((s, i) => (s.match ? <mark key={i} className={(s.n ?? 0) % 2 === 0 ? styles.match : styles.matchAlt}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
          </pre>
        </div>
      )}
      {outcome.ok && outcome.matches.length > 0 && (
        <table className={styles.table} aria-label="Groups">
          <thead>
            <tr>
              <th>#</th>
              <th>Index</th>
              <th>Match</th>
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
        <TextField mono value={replacement} onChange={(e) => setReplacement(e.target.value)} aria-label="Replacement" placeholder="$1-$2, $<name>, $&" spellCheck={false} />
      </div>
      {outcome.ok && outcome.replaced !== null && <OutputBox label="Replace preview" value={outcome.replaced} />}
      {outcome.ok && outcome.matches.length > 0 && (
        <div>
          <CopyButton text={outcome.matches.map((m) => m.text).join("\n")} label="Copy matches" />
        </div>
      )}
    </div>
  );
}
