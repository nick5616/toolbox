import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, PathText, toast } from "@/components";
import { DownloaderService, DownloadMode, LibraryService, type DownloaderOptions } from "@/lib/api";
import { useCommands } from "@/lib/commands";
import { toAppError } from "@/lib/errors";
import { useShortcut } from "@/lib/shortcuts";
import { useSettings } from "@/state/settings";
import { useUI } from "@/state/ui";
import type { ToolViewProps } from "@/tools";
import { DepsBanner, useDepsBlockReason } from "./DepsBanner";
import { OptionsPanel } from "./OptionsPanel";
import { RecentDownloads } from "./RecentDownloads";
import { UrlInput } from "./UrlInput";
import { useModuleOptions } from "../_kit/useModuleOptions";
import { DEFAULT_OPTIONS, MODULE_ID, sanitizeOptions } from "./options";
import { validateTrim, type TrimErrors } from "./timecode";
import { parseUrls, urlsError, validUrls } from "./urls";
import styles from "./DownloaderView.module.css";

export default function DownloaderView(_props: ToolViewProps) {
  const [text, setText] = useState("");
  const [opts, setOpts, loaded] = useModuleOptions(MODULE_ID, DEFAULT_OPTIONS, sanitizeOptions);
  const options: DownloaderOptions | null = loaded ? opts : null;
  const [serverUrlErrors, setServerUrlErrors] = useState<Record<string, string>>({});
  const [serverTrim, setServerTrim] = useState<TrimErrors>({});
  const [submitting, setSubmitting] = useState(false);

  const libraryDir = useSettings((s) => s.settings.libraryDir);
  const handoff = useUI((s) => s.handoff);
  const blockReason = useDepsBlockReason();

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);


  // Handoff from drop/paste.
  useEffect(() => {
    if (handoff?.moduleId !== MODULE_ID) return;
    const h = useUI.getState().takeHandoff(MODULE_ID);
    if (!h) return;
    setText(h.inputs.join("\n"));
    setServerUrlErrors({});
    requestAnimationFrame(() => submitRef.current?.focus());
  }, [handoff]);

  const parsed = useMemo(() => parseUrls(text), [text]);
  const urls = useMemo(() => validUrls(parsed), [parsed]);
  const listError = useMemo(() => urlsError(parsed), [parsed]);

  const trimErrors: TrimErrors = useMemo(() => {
    const client = options ? validateTrim(options.trimEnabled, options.trimStart, options.trimEnd) : {};
    return { ...serverTrim, ...client };
  }, [options, serverTrim]);

  const patchOptions = useCallback((patch: Partial<DownloaderOptions>) => {

    setServerTrim({});
    setOpts((o) => ({ ...o, ...patch }));
  }, []);

  const onText = useCallback((v: string) => {
    setText(v);
    setServerUrlErrors({});
  }, []);

  const submit = useCallback(
    async (override?: Partial<DownloaderOptions>) => {
      if (!options || submitting || blockReason) return;
      const opts = { ...options, ...override };
      const list = validUrls(parseUrls(text));
      if (list.length === 0 || list.length > 50) return;
      if (Object.keys(validateTrim(opts.trimEnabled, opts.trimStart, opts.trimEnd)).length > 0) return;
      setSubmitting(true);
      try {
        await DownloaderService.Enqueue(list, opts);
        setText("");
        setServerUrlErrors({});
        setServerTrim({});
        toast({ title: list.length === 1 ? "1 download queued" : `${list.length} downloads queued`, tone: "success" });
      } catch (e) {
        const err = toAppError(e);
        const fields = err.fields ?? {};
        const urlErrs: Record<string, string> = {};
        const trim: TrimErrors = {};
        let mapped = false;
        for (const [k, msg] of Object.entries(fields)) {
          const m = /^inputs\.(\d+)$/.exec(k);
          const url = m ? list[Number(m[1])] : undefined;
          if (url) {
            urlErrs[url] = msg;
            mapped = true;
          } else if (k === "trimStart" || k === "trimEnd") {
            trim[k] = msg;
            mapped = true;
          }
        }
        if (mapped) {
          setServerUrlErrors(urlErrs);
          setServerTrim(trim);
        }
        toast({ title: err.message, description: err.hint, tone: "danger" });
      } finally {
        setSubmitting(false);
      }
    },
    [options, submitting, blockReason, text],
  );

  const focusInput = useCallback(() => inputRef.current?.focus(), []);

  useShortcut("Mod+Enter", () => void submit(), { allowInInputs: true });
  useShortcut("Mod+L", focusInput, { allowInInputs: true });

  useCommands([
    { id: "downloader.audio", title: "Download as audio", section: "Downloader", icon: "music", run: () => submit({ mode: DownloadMode.ModeAudio }) },
    { id: "downloader.video", title: "Download as video", section: "Downloader", icon: "film", run: () => submit({ mode: DownloadMode.ModeVideo }) },
    { id: "downloader.focus-input", title: "Focus link input", section: "Downloader", icon: "link", shortcut: "Mod+L", run: focusInput },
  ]);

  const destination = libraryDir ? `${libraryDir}${libraryDir.includes("\\") ? "\\" : "/"}Downloads` : "";
  const canSubmit = !!options && urls.length > 0 && !listError && !blockReason && Object.keys(trimErrors).length === 0;

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Downloader</h1>
          <p className={styles.tagline}>Save audio or video from links.</p>
        </div>
        {destination && (
          <button
            type="button"
            className={styles.destination}
            title="Open downloads folder"
            onClick={() => void LibraryService.OpenLibraryFolder("Downloads").catch((e: unknown) => toast({ title: toAppError(e).message, tone: "danger" }))}
          >
            <PathText path={destination} />
          </button>
        )}
      </header>

      <DepsBanner />

      <UrlInput ref={inputRef} value={text} onChange={onText} parsed={parsed} serverErrors={serverUrlErrors} listError={listError} />

      {options && <OptionsPanel options={options} onChange={patchOptions} trimErrors={trimErrors} />}

      <div className={styles.submit}>
        <Button
          ref={submitRef}
          variant="primary"
          icon="download"
          kbd="Mod+Enter"
          loading={submitting}
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {urls.length > 0 ? `Download ${urls.length}` : "Download"}
        </Button>
        {blockReason && <p className={styles.reason}>{blockReason}</p>}
      </div>

      <RecentDownloads />
    </div>
  );
}
