import { useEffect, useMemo, useRef, useState } from "react";
import { Button, ClickIn, Field, Icon, IconButton, Section, Select, Stepper, Switch, ToolClickIn, toast, useClickIn } from "@/components";
import { DocumentsService, FilesService, LyricVideoService, PdfService, type DocumentsOptions } from "@/lib/api";
import { useCommands } from "@/lib/commands";
import { useToolHandoff } from "@/lib/embed";
import { toAppError } from "@/lib/errors";
import { useCompositionInputs } from "@/state/composition";
import { useRecentOutputs, type OutputView } from "@/state/library";
import type { ToolViewProps } from "@/tools";
import { EmptyLine, FileToolLayout, runLabel, summarize, useFileInputs, useModuleOptions } from "@/tools/_kit";
import { ResultRow } from "@/tools/_kit/ResultRow";
import { submitJobs } from "@/tools/_kit/enqueue";
import shared from "@/tools/_kit/results.module.css";
import {
  DEFAULT_DOCUMENT_OPTIONS,
  FORMATS,
  advancedSummaryParts,
  applicable,
  baseName,
  disabledTargets,
  extOf,
  formatMeta,
  inputProblems,
  isPdfPath,
  sanitizeDocumentOptions,
} from "./options";
import styles from "./DocumentsView.module.css";

const PREVIEW_BYTES = 200 * 1024;
const PREVIEW_ID = "documents-preview";
const TEXT_PREVIEW = new Set([".md", ".html", ".htm", ".txt"]);
const PAGE_SIZES = [
  { value: "a4", label: "A4" },
  { value: "letter", label: "Letter" },
];

let fontsCache: Promise<string[]> | null = null;
/** Font families the backend accepts (it validates MainFont against media.Fonts()). */
function loadFonts(): Promise<string[]> {
  fontsCache ??= LyricVideoService.Fonts().then(
    (f) => f ?? [],
    () => {
      fontsCache = null;
      return [];
    },
  );
  return fontsCache;
}

function useFonts(enabled: boolean): string[] {
  const [fonts, setFonts] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void loadFonts().then((f) => live && setFonts(f));
    return () => {
      live = false;
    };
  }, [enabled]);
  return fonts;
}

function AdvancedOptions({ opts, setOpts }: { opts: DocumentsOptions; setOpts: (f: (o: DocumentsOptions) => DocumentsOptions) => void }) {
  const a = applicable(opts.to);
  const fonts = useFonts(a.layout);
  const fontOptions = useMemo(() => {
    const list = fonts.includes(opts.mainFont) || opts.mainFont === "" ? fonts : [opts.mainFont, ...fonts];
    return [{ value: "", label: "Default" }, ...list.map((f) => ({ value: f, label: f }))];
  }, [fonts, opts.mainFont]);

  const pickReference = async () => {
    try {
      const got = (await FilesService.PickWith("Choose a styles document", [".docx", ".odt"], false)) ?? [];
      const first = got[0];
      if (first) setOpts((o) => ({ ...o, referenceDoc: first }));
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };

  if (!a.layout && !a.toc && !a.referenceDoc && !a.embed && !a.extractMedia) {
    return <p className={styles.none}>Nothing to adjust for {formatMeta(opts.to)?.label ?? "this format"}.</p>;
  }
  return (
    <div className={styles.stack}>
      {a.layout && (
        <>
          <Field label="Page size">
            {(c) => <Select id={c.id} value={opts.pageSize} options={PAGE_SIZES} data-tip="Paper size of the PDF" onChange={(pageSize) => setOpts((o) => ({ ...o, pageSize }))} />}
          </Field>
          <Field label="Margins (mm)">
            {(c) => <Stepper id={c.id} value={opts.marginMm} min={10} max={50} unit="mm" data-tip="White space around the text, 10 to 50 mm" onChange={(marginMm) => setOpts((o) => ({ ...o, marginMm }))} />}
          </Field>
          <Field label="Main font">
            {(c) => <Select id={c.id} value={opts.mainFont} options={fontOptions} data-tip="The font for the body text; Default lets Typst choose" onChange={(mainFont) => setOpts((o) => ({ ...o, mainFont }))} />}
          </Field>
          <Field label="Font size (pt)">
            {(c) => <Stepper id={c.id} value={opts.fontSizePt} min={9} max={16} unit="pt" data-tip="Body text size, 9 to 16 pt" onChange={(fontSizePt) => setOpts((o) => ({ ...o, fontSizePt }))} />}
          </Field>
        </>
      )}
      {a.toc && (
        <>
          <Switch label="Table of contents" tip="Add a list of the headings at the start" checked={opts.toc} onChange={(toc) => setOpts((o) => ({ ...o, toc }))} />
          <Switch label="Numbered sections" tip="Number the headings 1, 1.1, 1.2 …" checked={opts.numberSections} onChange={(numberSections) => setOpts((o) => ({ ...o, numberSections }))} />
        </>
      )}
      {a.referenceDoc && (
        <Field label="Styles from" hint="A document whose fonts and styles the result copies. Optional.">
          {() => (
            <span className={styles.refRow}>
              <span className={styles.refName} data-tip={opts.referenceDoc || "No file chosen"}>
                {opts.referenceDoc ? baseName(opts.referenceDoc) : "Default styles"}
              </span>
              <Button size="sm" variant="secondary" data-tip="Choose a .docx or .odt to copy styles from" onClick={() => void pickReference()}>
                Choose…
              </Button>
              {opts.referenceDoc !== "" && (
                <Button size="sm" variant="ghost" data-tip="Go back to the default styles" onClick={() => setOpts((o) => ({ ...o, referenceDoc: "" }))}>
                  Clear
                </Button>
              )}
            </span>
          )}
        </Field>
      )}
      {a.embed && (
        <Switch label="Embed images and styles" tip="Put everything in one HTML file instead of linking to separate files" checked={opts.embedResources} onChange={(embedResources) => setOpts((o) => ({ ...o, embedResources }))} />
      )}
      {a.extractMedia && (
        <Switch label="Extract media" tip="Save pictures into a folder next to the result" checked={opts.extractMedia} onChange={(extractMedia) => setOpts((o) => ({ ...o, extractMedia }))} />
      )}
    </div>
  );
}

/** First page of a PDF, or the first 200 KB of a text result. */
function PreviewBody({ path }: { path: string }) {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "image"; src: string } | { kind: "text"; text: string } | { kind: "error"; message: string }>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    const ext = extOf(path);
    const done = (s: typeof state) => live && setState(s);
    if (ext === ".pdf") {
      PdfService.Thumbnail(path, 1, 480, "").then(
        (src) => done({ kind: "image", src }),
        (e: unknown) => done({ kind: "error", message: toAppError(e).message }),
      );
    } else {
      FilesService.ReadText(path, PREVIEW_BYTES).then(
        (text) => done({ kind: "text", text }),
        (e: unknown) => done({ kind: "error", message: toAppError(e).message }),
      );
    }
    return () => {
      live = false;
    };
  }, [path]);
  if (state.kind === "loading") return <p className={styles.none}>Loading…</p>;
  if (state.kind === "error") return <p className={styles.none}>{state.message}</p>;
  if (state.kind === "image") return <img className={styles.page} src={state.src} alt="First page" />;
  return (
    <pre className={styles.text} aria-label="Text preview">
      {state.text}
    </pre>
  );
}

function canPreview(path: string): boolean {
  const e = extOf(path);
  return e === ".pdf" || TEXT_PREVIEW.has(e);
}

function Results({ recent, moduleId }: { recent: OutputView[]; moduleId: string }) {
  const clickIn = useClickIn();
  const [previewPath, setPreviewPath] = useState("");
  return (
    <Section label="Results" tip="Documents this tool made lately">
      {recent.length === 0 ? (
        <EmptyLine title="Nothing converted yet." body="Converted documents appear here." />
      ) : (
        <ul className={shared.list}>
          {recent.map((o) => {
            const meta = FORMATS.find((m) => m.exts.includes(extOf(o.path)) || (m.value === "pdf" && isPdfPath(o.path)));
            return (
              <li key={o.id}>
                <ResultRow
                  path={o.path}
                  outputId={o.id}
                  missing={o.missing}
                  name={o.name}
                  sizeBytes={o.sizeBytes}
                  at={o.createdAt}
                  icon={meta?.icon ?? "file-text"}
                  moduleId={moduleId}
                  extra={
                    <>
                {canPreview(o.path) && (
                  <IconButton
                    icon="eye"
                    label={`Preview ${o.name}`}
                    disabled={o.missing}
                    onClick={() => {
                      setPreviewPath(o.path);
                      clickIn.open(PREVIEW_ID);
                    }}
                  />
                )}
                {isPdfPath(o.path) && (
                  <>
                    <ToolClickIn
                      host={moduleId}
                      module="pdf"
                      variant="icon"
                      icon="file-type"
                      id={`tool:pdf:${o.id}`}
                      title="PDF Toolkit"
                      inputs={[o.path]}
                      action="compress"
                      tip="Compress, merge, split or edit this PDF (opens PDF Toolkit here)"
                      disabledReason={o.missing ? "The file is gone" : undefined}
                    />
                    <ToolClickIn
                      host={moduleId}
                      module="ocr"
                      variant="icon"
                      icon="scan-text"
                      id={`tool:ocr:${o.id}`}
                      title="Make searchable"
                      inputs={[o.path]}
                      tip="Add a text layer so the PDF can be searched (opens OCR here)"
                      disabledReason={o.missing ? "The file is gone" : undefined}
                    />
                  </>
                )}
                    </>
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
      <ClickIn headless id={PREVIEW_ID} icon="eye" title={previewPath ? baseName(previewPath) : "Preview"} width={480}>
        {previewPath !== "" && <PreviewBody path={previewPath} />}
      </ClickIn>
    </Section>
  );
}

export default function DocumentsView({ moduleId }: ToolViewProps) {
  // Registered before useFileInputs so PDFs (which the file list can't hold) are seen first.
  const addRef = useRef<(paths: string[]) => Promise<void>>(async () => undefined);
  const [pdfInputs, setPdfInputs] = useState<string[]>([]);
  useToolHandoff(moduleId, (h) => {
    const pdfs = h.inputs.filter(isPdfPath);
    if (pdfs.length > 0) setPdfInputs((cur) => [...new Set([...cur, ...pdfs])]);
    const rest = h.inputs.filter((p) => !isPdfPath(p));
    if (rest.length > 0) void addRef.current(rest);
  });
  const inputs = useFileInputs(moduleId);
  addRef.current = inputs.add;

  const [opts, setOpts] = useModuleOptions(moduleId, DEFAULT_DOCUMENT_OPTIONS, sanitizeDocumentOptions);
  const [running, setRunning] = useState(false);
  const [submitErrors, setSubmitErrors] = useState<Record<string, string>>({});
  const recent = useRecentOutputs(moduleId, 20);

  const paths = useMemo(() => inputs.files.map((f) => f.path), [inputs.files]);
  const problems = useMemo(() => inputProblems(paths, opts.to), [paths, opts.to]);
  const inputErrors = useMemo(() => ({ ...submitErrors, ...problems }), [submitErrors, problems]);
  const convertible = paths.filter((p) => !problems[p]);
  const blocked = useMemo(() => disabledTargets(paths), [paths]);
  const target = formatMeta(opts.to);

  const formatOptions = useMemo(
    () => FORMATS.map((m) => ({ value: m.value, label: m.label, disabled: blocked.has(m.value) && m.value !== opts.to })),
    [blocked, opts.to],
  );

  const onRun = async () => {
    setRunning(true);
    const res = await submitJobs(() => DocumentsService.Enqueue(convertible, opts), convertible, ["document", "documents"]);
    setRunning(false);
    setSubmitErrors(res.inputErrors);
    if (res.ok) inputs.clear();
  };

  useCommands([{ id: "documents.convert", title: "Convert document…", section: "Documents", icon: "file-text", keywords: ["docx", "pdf", "markdown", "epub", "pandoc"], run: () => inputs.pick() }]);

  const resultPdfs = useMemo(() => recent.filter((o) => isPdfPath(o.path) && !o.missing).map((o) => o.path), [recent]);
  useCompositionInputs(moduleId, { pdf: resultPdfs, ocr: pdfInputs });

  const pdfNote = pdfInputs.length > 0 && (
    <div className={styles.note} role="note">
      <span data-tip="Documents can't be made from a PDF directly; read its text with OCR first">
        {pdfInputs.length === 1 ? `${baseName(pdfInputs[0] ?? "")} is a PDF.` : `${pdfInputs.length} files are PDFs.`} Get the text with OCR, then convert that.
      </span>
      <ToolClickIn
        host={moduleId}
        module="ocr"
        variant="icon"
        icon="scan-text"
        title="Get the text with OCR"
        inputs={pdfInputs}
        tip="Read the text of the PDF with OCR (opens OCR here)"
        useLabel="Convert the text"
        onUse={(out) => {
          setPdfInputs([]);
          const texts = out.filter((p) => [".txt", ".md"].includes(extOf(p)));
          if (texts.length > 0) void inputs.add(texts);
        }}
      />
      <Button size="sm" variant="ghost" data-tip="Hide this note" onClick={() => setPdfInputs([])}>
        Dismiss
      </Button>
    </div>
  );

  return (
    <FileToolLayout
      moduleId={moduleId}
      inputs={inputs}
      runLabel={runLabel("Convert", convertible.length, "document", "documents")}
      onRun={onRun}
      running={running}
      inputErrors={inputErrors}
      runDisabledReason={paths.length > 0 && convertible.length === 0 ? `No selected file can become ${target?.label ?? "this format"}` : undefined}
      primary={
        <>
          {pdfNote}
          <Field label="Convert to">
            {(c) => (
              <span className={styles.toRow}>
                <Icon name={target?.icon ?? "file-text"} size={16} className={shared.icon} />
                <Select
                  id={c.id}
                  aria-describedby={c["aria-describedby"]}
                  data-tip="The kind of document to make; a format is greyed out when every file is already in it"
                  value={opts.to}
                  options={formatOptions}
                  onChange={(to) => setOpts((o) => ({ ...o, to }))}
                />
              </span>
            )}
          </Field>
        </>
      }
      advancedSummary={summarize(...advancedSummaryParts(opts))}
      advanced={<AdvancedOptions opts={opts} setOpts={setOpts} />}
      results={<Results recent={recent} moduleId={moduleId} />}
    />
  );
}
