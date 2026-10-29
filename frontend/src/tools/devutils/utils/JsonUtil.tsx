import { useMemo, useState } from "react";
import { Badge, SegmentedControl, TextArea } from "@/components";
import { caretExcerpt, formatJson, jsonToYaml, minifyJson, parseJson, parseYaml, sortKeys, type IndentChoice } from "./json.logic";
import { OutputBox, useDebounced } from "./shared";
import styles from "../DevUtils.module.css";

type Mode = "format" | "minify" | "sort" | "to-yaml" | "from-yaml";

interface Computed {
  output: string;
  error: string;
  caret: string;
  valid: boolean | null;
}

function compute(input: string, mode: Mode, indent: IndentChoice): Computed {
  if (input.trim() === "") return { output: "", error: "", caret: "", valid: null };
  if (mode === "from-yaml") {
    const y = parseYaml(input);
    if (!y.ok) return { output: "", error: y.message, caret: "", valid: false };
    return { output: formatJson(y.value ?? null, indent), error: "", caret: "", valid: true };
  }
  const p = parseJson(input);
  if (!p.ok) {
    const e = p.error;
    return { output: "", error: `${e.message} at line ${e.line}, column ${e.col}`, caret: caretExcerpt(input, e), valid: false };
  }
  switch (mode) {
    case "format":
      return { output: formatJson(p.value, indent), error: "", caret: "", valid: true };
    case "minify":
      return { output: minifyJson(p.value), error: "", caret: "", valid: true };
    case "sort":
      return { output: formatJson(sortKeys(p.value), indent), error: "", caret: "", valid: true };
    case "to-yaml":
      return { output: jsonToYaml(p.value), error: "", caret: "", valid: true };
    default:
      return { output: "", error: "", caret: "", valid: true };
  }
}

export default function JsonUtil() {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("format");
  const [indent, setIndent] = useState<IndentChoice>("2");
  const debounced = useDebounced(input);
  const r = useMemo(() => compute(debounced, mode, indent), [debounced, mode, indent]);

  return (
    <div className={styles.util}>
      <div className={styles.row}>
        <SegmentedControl
          aria-label="JSON action"
          value={mode}
          onChange={setMode}
          options={[
            { value: "format", label: "Format" },
            { value: "minify", label: "Minify" },
            { value: "sort", label: "Sort keys" },
            { value: "to-yaml", label: "JSON to YAML" },
            { value: "from-yaml", label: "YAML to JSON" },
          ]}
        />
        {(mode === "format" || mode === "sort" || mode === "from-yaml") && (
          <SegmentedControl
            aria-label="Indent"
            value={indent}
            onChange={setIndent}
            options={[
              { value: "2", label: "2 spaces" },
              { value: "4", label: "4 spaces" },
              { value: "tab", label: "Tab" },
            ]}
          />
        )}
        {r.valid !== null && <Badge tone={r.valid ? "ok" : "danger"}>{r.valid ? "Valid" : "Invalid"}</Badge>}
      </div>
      <div className={styles.col}>
        <span className={styles.label}>{mode === "from-yaml" ? "YAML input" : "JSON input"}</span>
        <TextArea
          mono
          minRows={8}
          maxRows={20}
          value={input}
          invalid={r.valid === false}
          onChange={(e) => setInput(e.target.value)}
          placeholder={mode === "from-yaml" ? "name: value" : '{"name": "value"}'}
          aria-label={mode === "from-yaml" ? "YAML input" : "JSON input"}
          spellCheck={false}
        />
        {r.error && <p className={styles.error}>{r.error}</p>}
        {r.caret && <pre className={styles.caret}>{r.caret}</pre>}
      </div>
      <OutputBox label={mode === "to-yaml" ? "YAML" : "JSON"} value={r.output} />
    </div>
  );
}
