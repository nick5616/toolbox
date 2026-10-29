import { useEffect, useMemo, useState } from "react";
import { Badge, Button, DropZone, FileList, Switch, TextArea, TextField, toast } from "@/components";
import { DevUtilsService, JobStatus } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { isActive, useOrderedJobs } from "@/state/jobs";
import { useFileInputs } from "@/tools/_kit";
import { mapInputErrors } from "@/tools/_kit/enqueue";
import { ALGO_LABEL, HASH_ALGOS, matchingAlgo, parseHashResult, type HashAlgo } from "./hash.logic";
import { CopyButton, useDebounced } from "./shared";
import styles from "../DevUtils.module.css";

export const DEV_UTILS_ID = "dev-utils";

export default function HashUtil() {
  const [text, setText] = useState("");
  const debounced = useDebounced(text);
  const [textHashes, setTextHashes] = useState<Record<string, string>>({});
  const [compare, setCompare] = useState("");

  useEffect(() => {
    let live = true;
    if (debounced === "") {
      setTextHashes({});
      return;
    }
    DevUtilsService.HashText(debounced)
      .then((rs) => {
        if (!live) return;
        const m: Record<string, string> = {};
        for (const r of rs ?? []) m[r.algorithm] = r.hex;
        setTextHashes(m);
      })
      .catch((e) => toast({ title: toAppError(e).message, tone: "danger" }));
    return () => {
      live = false;
    };
  }, [debounced]);

  const inputs = useFileInputs(DEV_UTILS_ID);
  const [algos, setAlgos] = useState<HashAlgo[]>(["md5", "sha1", "sha256", "sha512", "crc32"]);
  const [running, setRunning] = useState(false);
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const jobs = useOrderedJobs(DEV_UTILS_ID);
  const working = jobs.some(isActive);
  const latest = useMemo(() => {
    for (const j of jobs) {
      if (j.status !== JobStatus.JobDone) continue;
      const files = parseHashResult(j.resultJson);
      if (files) return files;
    }
    return null;
  }, [jobs]);

  const toggle = (a: HashAlgo, on: boolean) => setAlgos((cur) => HASH_ALGOS.filter((x) => (x === a ? on : cur.includes(x))));

  const run = async () => {
    const paths = inputs.files.map((f) => f.path);
    setRunning(true);
    try {
      await DevUtilsService.Enqueue(paths, { algorithms: algos });
      setInputErrors({});
      inputs.clear();
    } catch (e) {
      const err = toAppError(e);
      setInputErrors(mapInputErrors(err.fields, paths));
      toast({ title: err.message, description: err.hint, tone: "danger" });
    } finally {
      setRunning(false);
    }
  };

  const shownAlgos = HASH_ALGOS.filter((a) => (latest ?? []).some((f) => a in f.hashes));
  const compareHit = compare.trim() !== "";

  return (
    <div className={styles.util}>
      <div className={styles.col}>
        <span className={styles.label}>Text (UTF-8)</span>
        <TextArea mono minRows={4} maxRows={12} value={text} onChange={(e) => setText(e.target.value)} aria-label="Text to hash" spellCheck={false} />
      </div>
      <table className={styles.table} aria-label="Text hashes">
        <tbody>
          {HASH_ALGOS.map((a) => {
            const v = textHashes[a] ?? "";
            const hit = compareHit && matchingAlgo({ [a]: v }, compare) !== null;
            return (
              <tr key={a}>
                <th scope="row">{ALGO_LABEL[a]}</th>
                <td className={[styles.mono, hit ? styles.highlight : ""].join(" ")}>{v || "—"}</td>
                <td>{hit && <Badge tone="ok">Match</Badge>}</td>
                <td>
                  <CopyButton text={v} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className={styles.col}>
        <span className={styles.label}>Compare</span>
        <TextField mono value={compare} onChange={(e) => setCompare(e.target.value)} placeholder="Paste an expected hash to highlight the matching value" aria-label="Compare" spellCheck={false} />
      </div>

      <div className={styles.col}>
        <span className={styles.label}>Files</span>
        <DropZone id={`tool-drop:${DEV_UTILS_ID}`} className={styles.drop} label="Drop files to hash" hint="Up to 100 files. They are read once and never changed.">
          <Button size="sm" variant="secondary" onClick={() => void inputs.pick()}>
            Choose files
          </Button>
        </DropZone>
        <FileList
          aria-label="Files to hash"
          files={inputs.files.map((f) => ({
            path: f.path,
            size: f.sizeBytes,
            trailing: inputErrors[f.path] ? <Badge tone="danger">{inputErrors[f.path]}</Badge> : undefined,
          }))}
          onRemove={inputs.remove}
        />
        <div className={styles.row}>
          {HASH_ALGOS.map((a) => (
            <Switch key={a} checked={algos.includes(a)} onChange={(on) => toggle(a, on)} label={ALGO_LABEL[a]} />
          ))}
        </div>
        <div className={styles.row}>
          <Button
            variant="primary"
            icon="hash"
            loading={running || working}
            disabled={inputs.files.length === 0 || algos.length === 0}
            onClick={() => void run()}
          >
            {inputs.files.length === 0 ? "Hash files" : `Hash ${inputs.files.length} ${inputs.files.length === 1 ? "file" : "files"}`}
          </Button>
        </div>
      </div>

      {latest && (
        <div className={styles.col}>
          <span className={styles.label}>Latest file hashes</span>
          {latest.map((f) => {
            const hit = matchingAlgo(f.hashes, compare);
            return (
              <div key={f.path} className={styles.col}>
                <div className={styles.row}>
                  <span className={styles.mono}>{f.path}</span>
                  <Badge>{formatBytes(f.size)}</Badge>
                  {compareHit && <Badge tone={hit ? "ok" : "neutral"}>{hit ? `Matches ${ALGO_LABEL[hit as HashAlgo] ?? hit}` : "No match"}</Badge>}
                </div>
                <table className={styles.table} aria-label={`Hashes of ${f.path}`}>
                  <tbody>
                    {shownAlgos
                      .filter((a) => a in f.hashes)
                      .map((a) => (
                        <tr key={a}>
                          <th scope="row">{ALGO_LABEL[a]}</th>
                          <td className={[styles.mono, hit === a ? styles.highlight : ""].join(" ")}>{f.hashes[a]}</td>
                          <td>
                            <CopyButton text={f.hashes[a] ?? ""} />
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
