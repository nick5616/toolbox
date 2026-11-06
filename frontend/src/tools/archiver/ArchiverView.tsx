import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  ClickIn,
  ClickInHost,
  EmptyState,
  Field,
  Section,
  Stepper,
  Switch,
  TextArea,
  ToolClickIn,
  toast,
} from "@/components";
import { ArchiverService, type ArchiverBrowserInfo, type ArchiverOptions } from "@/lib/api";
import { useCommands } from "@/lib/commands";
import { useToolHandoff } from "@/lib/embed";
import { toAppError } from "@/lib/errors";
import { useShortcut } from "@/lib/shortcuts";
import { JobRow } from "@/shell/JobRow";
import { useCompositionInputs } from "@/state/composition";
import { isActive, useOrderedJobs } from "@/state/jobs";
import { useRecentOutputs, type OutputView } from "@/state/library";
import type { ToolViewProps } from "@/lib/toolActions";
import { DepsGate, useDepsGate } from "../_kit/DepsGate";
import { FailedJobs } from "../_kit/FailedJobs";
import { ResultRow } from "../_kit/ResultRow";
import { useModuleOptions } from "../_kit/useModuleOptions";
import { DEFAULT_OPTIONS, MAX_TIMEOUT, MIN_TIMEOUT, MODULE_ID, advancedSummary, sanitizeOptions } from "./options";
import { listError, parseLinks, savableLinks } from "./urls";
import styles from "./ArchiverView.module.css";

const NO_BROWSER_TIP = "Needs Microsoft Edge or Google Chrome installed";

/** The site folder a saved page lives in ("<library>/Web Archive/<host>/page.html"). */
export function siteOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.length >= 2 ? (parts[parts.length - 2] ?? "") : "";
}

function PageRow({ o }: { o: OutputView }) {
  const isPage = /.html?$/i.test(o.name);
  const site = siteOf(o.path);
  return (
    <li>
      <ResultRow
        path={o.path}
        outputId={o.id}
        missing={o.missing}
        name={o.name}
        sizeBytes={o.sizeBytes}
        at={o.createdAt}
        icon="file-text"
        moduleId={MODULE_ID}
        meta={site ? <span data-tip="The site this page came from">{site}</span> : undefined}
        extra={
          isPage && !o.missing ? (
            <ToolClickIn
              host={MODULE_ID}
              module="documents"
              inputs={[o.path]}
              title="Convert…"
              icon="repeat"
              variant="icon"
              tip="Convert this page to Word, Markdown, EPUB and more"
              id={`convert:${o.id}`}
              width={560}
            />
          ) : undefined
        }
      />
    </li>
  );
}

export default function ArchiverView(_props: ToolViewProps) {
  const [text, setText] = useState("");
  const [opts, setOpts, loaded] = useModuleOptions(MODULE_ID, DEFAULT_OPTIONS, sanitizeOptions);
  const [browser, setBrowser] = useState<ArchiverBrowserInfo | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const gate = useDepsGate(MODULE_ID);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let off = false;
    ArchiverService.Browser()
      .then((b) => {
        if (!off) setBrowser(b ?? { found: false, name: "" });
      })
      .catch(() => {
        if (!off) setBrowser({ found: false, name: "" });
      });
    return () => {
      off = true;
    };
  }, []);

  useToolHandoff(MODULE_ID, (h) => {
    const parts = [...h.inputs];
    if (h.text?.body) parts.push(h.text.body);
    setText(parts.join("\n"));
    setServerErrors({});
    requestAnimationFrame(() => inputRef.current?.focus());
  });

  const browserFound = browser?.found ?? false;
  const parsed = useMemo(() => parseLinks(text, opts.allowLocal), [text, opts.allowLocal]);
  const links = useMemo(() => savableLinks(parsed), [parsed]);
  const problems = useMemo(
    () => parsed.map((p) => ({ raw: p.raw, error: p.error ?? serverErrors[p.raw] })).filter((p) => p.error),
    [parsed, serverErrors],
  );
  const tooMany = listError(parsed);
  const canSubmit = loaded && links.length > 0 && !tooMany && !gate.blocked && problems.length === 0;

  const patch = useCallback(
    (p: Partial<ArchiverOptions>) => {
      setServerErrors({});
      setOpts((o) => ({ ...o, ...p }));
    },
    [setOpts],
  );

  const submit = useCallback(async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      const o: ArchiverOptions = {
        ...opts,
        urls: [],
        renderJs: opts.renderJs && browserFound,
        alsoPdf: opts.alsoPdf && browserFound,
      };
      await ArchiverService.Enqueue(links, o);
      setText("");
      setServerErrors({});
      toast({ title: links.length === 1 ? "Saving 1 page" : `Saving ${links.length} pages`, tone: "success" });
    } catch (e) {
      const err = toAppError(e);
      const next: Record<string, string> = {};
      for (const [k, msg] of Object.entries(err.fields ?? {})) {
        const m = /^inputs\.(\d+)$/.exec(k);
        const url = m ? links[Number(m[1])] : undefined;
        if (url) next[url] = msg;
      }
      setServerErrors(next);
      toast({ title: err.message, description: err.hint, tone: "danger" });
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, submitting, opts, browserFound, links]);

  const focusInput = useCallback(() => inputRef.current?.focus(), []);
  useShortcut("Mod+Enter", () => void submit(), { allowInInputs: true });
  useCommands([{ id: "archiver.save", title: "Save web page…", section: "Web Archiver", icon: "archive", run: focusInput }]);

  const jobs = useOrderedJobs(MODULE_ID);
  const active = useMemo(() => jobs.filter(isActive), [jobs]);
  const recent = useRecentOutputs(MODULE_ID, 12);
  const latestPage = useMemo(() => recent.find((o) => !o.missing && /\.html?$/i.test(o.name))?.path, [recent]);
  useCompositionInputs(MODULE_ID, { documents: latestPage ? [latestPage] : [] });

  const jsTip = browserFound
    ? `Opens each page in ${browser?.name ?? "your browser"} (installed, with a temporary profile) so content built by scripts is saved too`
    : NO_BROWSER_TIP;
  const pdfTip = browserFound ? "Also keep a PDF copy of each page" : NO_BROWSER_TIP;
  const summary = `${links.length} ${links.length === 1 ? "link" : "links"}${problems.length ? ` · ${problems.length} can't be saved` : ""}`;

  return (
    <ClickInHost className={styles.hostWrap}>
      <div className={styles.root}>
        <DepsGate moduleId={MODULE_ID} />

        <TextArea
          ref={inputRef}
          mono
          minRows={2}
          maxRows={8}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setServerErrors({});
          }}
          placeholder="Paste one or more links, one per line…"
          aria-label="Links"
          data-tip="One link per line, up to 50"
          invalid={problems.length > 0 || !!tooMany}
          spellCheck={false}
        />
        {problems.length > 0 && (
          <ul className={styles.problems} aria-label="Links with problems">
            {problems.map((p) => (
              <li key={p.raw} className={styles.problem}>
                <span className={styles.problemUrl}>{p.raw}</span>
                <span className={styles.problemWhy}>{p.error}</span>
              </li>
            ))}
          </ul>
        )}
        {parsed.length > 0 && <p className={styles.note}>{tooMany ? `${summary} · ${tooMany}` : summary}</p>}

        <div className={styles.toggles}>
          <Switch
            label="Render JavaScript"
            checked={opts.renderJs && browserFound}
            disabled={!browserFound}
            tip={jsTip}
            onChange={(renderJs) => patch({ renderJs })}
          />
          <Switch
            label="Also PDF"
            checked={opts.alsoPdf && browserFound}
            disabled={!browserFound}
            tip={pdfTip}
            onChange={(alsoPdf) => patch({ alsoPdf })}
          />
        </div>

        <div className={styles.submit}>
          <Button
            variant="primary"
            icon="archive"
            kbd="Mod+Enter"
            loading={submitting}
            disabled={!canSubmit}
            data-tip={
              canSubmit
                ? "Save every link as one self-contained HTML file"
                : gate.blocked
                  ? gate.reason
                  : links.length === 0
                    ? "Paste at least one valid link first"
                    : (tooMany ?? "Fix the highlighted links first")
            }
            onClick={() => void submit()}
          >
            Save page
          </Button>
          {gate.blocked && <p className={styles.note}>{gate.reason}</p>}
        </div>

        <ClickIn icon="sliders-horizontal" title="Advanced" summary={advancedSummary(opts)} tip="What to leave out, the timeout and local addresses" width={340}>
          <Switch label="No JavaScript" checked={opts.noJs} tip="Remove scripts from the saved page" onChange={(noJs) => patch({ noJs })} />
          <Switch label="No images" checked={opts.noImages} tip="Leave pictures out for a smaller file" onChange={(noImages) => patch({ noImages })} />
          <Field label="Timeout" hint="How long to wait for each request, in seconds.">
            {(c) => (
              <Stepper id={c.id} aria-label="Timeout" value={opts.timeoutSec} min={MIN_TIMEOUT} max={MAX_TIMEOUT} step={10} unit="s" onChange={(timeoutSec) => patch({ timeoutSec })} />
            )}
          </Field>
          <Switch
            label="Allow local addresses"
            checked={opts.allowLocal}
            tip="Let pages on this computer or your own network be saved"
            onChange={(allowLocal) => patch({ allowLocal })}
          />
        </ClickIn>

        {active.length > 0 && (
          <Section label="Active" tip="Pages that are queued or being saved">
            <div className={styles.jobs}>
              {active.map((j) => (
                <JobRow key={j.id} job={j} compact />
              ))}
            </div>
          </Section>
        )}
        <FailedJobs moduleId={MODULE_ID} />
        <Section label="Results" tip="The latest pages this tool saved to your library">
          {recent.length === 0 ? (
            <EmptyState icon="archive" title="No saved pages yet." body="Paste a link above, or anywhere in the app." />
          ) : (
            <ul className={styles.list}>
              {recent.map((o) => (
                <PageRow key={o.id} o={o} />
              ))}
            </ul>
          )}
        </Section>
      </div>
    </ClickInHost>
  );
}
