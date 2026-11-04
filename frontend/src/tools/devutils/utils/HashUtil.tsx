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
import { useDevUtilsNav } from "../registry";
import { useUtilState } from "../store";
import styles from "../DevUtils.module.css";

export const DEV_UTILS_ID = "dev-utils";

export default function HashUtil() {
  const [text, setText] = useUtilState("hash", "text", "");
  const debounced = useDebounced(text);
  const [textHashes, setTextHashes] = useState<Record<string, string>>({});
  const [compare, setCompare] = useUtilState("hash", "compare", "");

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
  // Files handed to the tool while another utility was showing.
  const pending = useDevUtilsNav((s) => s.pendingFiles);
  const { add: addFiles } = inputs;
  useEffect(() => {
    if (pending.length === 0) return;
    useDevUtilsNav.getState().setPendingFiles([]);
    void addFiles(pending);
  }, [pending, addFiles]);
  const [algos, setAlgos] = useUtilState<HashAlgo[]>("hash", "algos", ["md5", "sha1", "sha256", "sha512", "crc32"]);
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
        <TextArea mono minRows={4} maxRows={12} value={text} onChange={(e) => setText(e.target.value)} aria-label="Text to hash" data-tip="Text whose hashes are shown below as you type" spellCheck={false} />
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
                <td>{hit && <Badge tone="ok" tip="This hash equals the one you pasted to compare">Match</Badge>}</td>
                <td>
                  <CopyButton text={v} what={`the ${ALGO_LABEL[a]} hash`} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className={styles.col}>
        <span className={styles.label}>Compare</span>
        <TextField mono value={compare} onChange={(e) => setCompare(e.target.value)} placeholder="Paste an expected hash to highlight the matching value" aria-label="Compare" data-tip="Paste a hash you expect; matching values light up" spellCheck={false} />
      </div>

      <div className={styles.col}>
        <span className={styles.label}>Files</span>
        <DropZone id={`tool-drop:${DEV_UTILS_ID}`} className={styles.drop} label="Drop files to hash" hint="Up to 100 files. They are read once and never changed.">
          <Button size="sm" variant="secondary" data-tip="Choose up to 100 files to hash" onClick={() => void inputs.pick()}>
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
            <Switch key={a} checked={algos.includes(a)} onChange={(on) => toggle(a, on)} label={ALGO_LABEL[a]} tip={a === "crc32" ? "Fast checksum for spotting accidental changes; not secure" : a === "md5" || a === "sha1" ? "Common but no longer secure; fine for matching published checksums" : "Strong modern hash; good for verifying downloads"} />
          ))}
        </div>
        <div className={styles.row}>
          <Button
            variant="primary"
            icon="hash"
            loading={running || working}
            disabled={inputs.files.length === 0 || algos.length === 0}
            data-tip={inputs.files.length === 0 ? "Add files first" : algos.length === 0 ? "Switch on at least one algorithm" : "Compute the chosen hashes for these files; files are only read"}
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
                  <Badge tip="File size">{formatBytes(f.size)}</Badge>
                  {compareHit && <Badge tone={hit ? "ok" : "neutral"} tip={hit ? "One of this file's hashes equals the one you pasted" : "None of this file's hashes equal the one you pasted"}>{hit ? `Matches ${ALGO_LABEL[hit as HashAlgo] ?? hit}` : "No match"}</Badge>}
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
                            <CopyButton text={f.hashes[a] ?? ""} what={`the ${ALGO_LABEL[a]} hash`} />
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
