import { useMemo, useState } from "react";
import { Button, SegmentedControl, Switch, TextArea, toast } from "@/components";
import { DevUtilsService, FilesService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { decodeText, encodeText, mimeForPath, reshapeBase64, toDataUrl } from "./base64.logic";
import { OutputBox, useDebounced } from "./shared";
import styles from "../DevUtils.module.css";

export default function Base64Util() {
  const [dir, setDir] = useState<"encode" | "decode">("encode");
  const [input, setInput] = useState("");
  const [urlSafe, setUrlSafe] = useState(false);
  const [padding, setPadding] = useState(true);
  const [fileB64, setFileB64] = useState<{ path: string; b64: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const debounced = useDebounced(input);

  const result = useMemo(() => {
    if (debounced === "") return { out: "", error: "" };
    if (dir === "encode") return { out: encodeText(debounced, { urlSafe, padding }), error: "" };
    try {
      return { out: decodeText(debounced), error: "" };
    } catch (e) {
      return { out: "", error: e instanceof Error ? e.message : "Couldn't decode" };
    }
  }, [debounced, dir, urlSafe, padding]);

  const pickFile = async () => {
    setBusy(true);
    try {
      const paths = (await FilesService.Pick("dev-utils")) ?? [];
      const path = paths[0];
      if (!path) return;
      setFileB64({ path, b64: await DevUtilsService.FileBase64(path) });
    } catch (e) {
      toast({ title: toAppError(e).message, description: toAppError(e).hint, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const fileOut = fileB64 ? reshapeBase64(fileB64.b64, { urlSafe, padding }) : "";
  const dataUrl = fileB64 ? toDataUrl(fileB64.b64, mimeForPath(fileB64.path)) : "";

  return (
    <div className={styles.util}>
      <div className={styles.row}>
        <SegmentedControl
          aria-label="Direction"
          value={dir}
          onChange={setDir}
          options={[
            { value: "encode", label: "Encode text" },
            { value: "decode", label: "Decode text" },
          ]}
        />
        <Switch checked={urlSafe} onChange={setUrlSafe} label="URL-safe" />
        <Switch checked={padding} onChange={setPadding} label="Padding" />
      </div>
      <div className={styles.col}>
        <span className={styles.label}>{dir === "encode" ? "Text" : "Base64"}</span>
        <TextArea
          mono
          minRows={5}
          maxRows={14}
          value={input}
          invalid={result.error !== ""}
          onChange={(e) => setInput(e.target.value)}
          aria-label={dir === "encode" ? "Text to encode" : "Base64 to decode"}
          spellCheck={false}
        />
        {result.error && <p className={styles.error}>{result.error}</p>}
      </div>
      <OutputBox label={dir === "encode" ? "Base64" : "Text"} value={result.out} />

      <div className={styles.col}>
        <span className={styles.label}>File (up to 10 MiB)</span>
        <div className={styles.row}>
          <Button variant="secondary" icon="file" loading={busy} onClick={() => void pickFile()}>
            Choose a file
          </Button>
          {fileB64 && <span className={styles.mono}>{fileB64.path}</span>}
        </div>
      </div>
      {fileB64 && (
        <>
          <OutputBox label="File as Base64" value={fileOut} />
          <OutputBox label="File as data URL" value={dataUrl} />
        </>
      )}
    </div>
  );
}
