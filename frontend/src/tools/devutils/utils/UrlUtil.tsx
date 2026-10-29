import { useMemo, useState } from "react";
import { Button, IconButton, TextArea, TextField } from "@/components";
import { OutputBox, useDebounced } from "./shared";
import { buildUrl, decodeComponent, encodeComponent, parseUrl, type QueryParam, type UrlParts } from "./url.logic";
import styles from "../DevUtils.module.css";

const PART_FIELDS: { key: keyof Omit<UrlParts, "params">; label: string }[] = [
  { key: "protocol", label: "Scheme" },
  { key: "username", label: "User" },
  { key: "password", label: "Password" },
  { key: "hostname", label: "Host" },
  { key: "port", label: "Port" },
  { key: "pathname", label: "Path" },
  { key: "hash", label: "Fragment" },
];

export default function UrlUtil() {
  const [text, setText] = useState("");
  const debouncedText = useDebounced(text);
  const encoded = useMemo(() => encodeComponent(debouncedText), [debouncedText]);
  const decoded = useMemo(() => decodeComponent(debouncedText), [debouncedText]);

  const [url, setUrl] = useState("");
  const debouncedUrl = useDebounced(url);
  const parsed = useMemo(() => parseUrl(debouncedUrl), [debouncedUrl]);
  // Edits to the parts table override the parsed URL until the URL text changes.
  const [edited, setEdited] = useState<{ source: string; parts: UrlParts } | null>(null);
  const parts: UrlParts | null = parsed.ok ? (edited && edited.source === debouncedUrl ? edited.parts : parsed.parts) : null;
  const rebuilt = parts ? buildUrl(parts) : "";

  const update = (next: UrlParts) => setEdited({ source: debouncedUrl, parts: next });
  const setParam = (i: number, patch: Partial<QueryParam>) => {
    if (!parts) return;
    update({ ...parts, params: parts.params.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  };

  return (
    <div className={styles.util}>
      <div className={styles.col}>
        <span className={styles.label}>Encode or decode a component</span>
        <TextArea mono minRows={3} maxRows={10} value={text} onChange={(e) => setText(e.target.value)} aria-label="Text" spellCheck={false} />
      </div>
      <div className={styles.cols}>
        <OutputBox label="Encoded" value={debouncedText === "" ? "" : encoded} />
        <div className={styles.col}>
          <OutputBox label="Decoded" value={debouncedText === "" || !decoded.ok ? "" : decoded.value} />
          {debouncedText !== "" && !decoded.ok && <p className={styles.error}>{decoded.message}</p>}
        </div>
      </div>

      <div className={styles.col}>
        <span className={styles.label}>Parse a URL</span>
        <TextField
          mono
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/path?key=value"
          aria-label="URL"
          invalid={url.trim() !== "" && !parsed.ok}
          spellCheck={false}
        />
        {url.trim() !== "" && !parsed.ok && <p className={styles.error}>{parsed.message}</p>}
      </div>

      {parts && (
        <>
          <table className={styles.table}>
            <tbody>
              {PART_FIELDS.map((f) => (
                <tr key={f.key}>
                  <th scope="row">{f.label}</th>
                  <td>
                    <TextField
                      mono
                      size="sm"
                      value={parts[f.key]}
                      onChange={(e) => update({ ...parts, [f.key]: e.target.value })}
                      aria-label={f.label}
                      spellCheck={false}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className={styles.col}>
            <span className={styles.label}>Query parameters</span>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Value</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {parts.params.map((p, i) => (
                  <tr key={i}>
                    <td>
                      <TextField mono size="sm" value={p.key} onChange={(e) => setParam(i, { key: e.target.value })} aria-label={`Key ${i + 1}`} spellCheck={false} />
                    </td>
                    <td>
                      <TextField mono size="sm" value={p.value} onChange={(e) => setParam(i, { value: e.target.value })} aria-label={`Value ${i + 1}`} spellCheck={false} />
                    </td>
                    <td>
                      <IconButton
                        label={`Remove parameter ${i + 1}`}
                        icon="x"
                        size="sm"
                        onClick={() => update({ ...parts, params: parts.params.filter((_, j) => j !== i) })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div>
              <Button size="sm" variant="secondary" icon="plus" onClick={() => update({ ...parts, params: [...parts.params, { key: "", value: "" }] })}>
                Add parameter
              </Button>
            </div>
          </div>
          <OutputBox label="Rebuilt URL" value={rebuilt} />
        </>
      )}
    </div>
  );
}
