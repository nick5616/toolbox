import { useEffect, useMemo, useState } from "react";
import { Section, SegmentedControl, Select, Switch, ToolClickIn, toast } from "@/components";
import {
  FilesService,
  JobStatus,
  OcrImageOutput,
  OcrLanguage,
  OcrPdfOutput,
  OcrService,
  type OcrLanguageInfo,
} from "@/lib/api";
import { useCompositionInputs } from "@/state/composition";
import { useToolJobs } from "@/tools/_kit/session";
import { EmptyLine, FileToolLayout, ResultRow, TextActions, runLabel, summarize, useFileInputs, useModuleOptions } from "@/tools/_kit";
import { submitJobs } from "@/tools/_kit/enqueue";
import type { ToolViewProps } from "../index";
import { DEFAULT_OCR_OPTIONS, FALLBACK_LANGUAGES, downloadNote, sanitizeOcrOptions, toOcrResult, type OcrResultItem } from "./options";
import styles from "./ocr.module.css";

const MAX_RESULTS = 24;

const PDF_LABEL: Record<string, string> = {
  [OcrPdfOutput.PDFSearchable]: "searchable PDF",
  [OcrPdfOutput.PDFText]: "PDFs as text",
  [OcrPdfOutput.PDFBoth]: "PDF + text",
};

const CHAT_PROMPTS = ["Summarise", "Extract a table", "Fix typos"];
/** FilesService.ReadText never returns more than 256 KB. */
const MAX_FULL_TEXT = 256 * 1024;

/** The whole recognised text, read from the saved .txt (the job's preview is cut at 2000 characters and empty for PDFs). */
function useFullText(textPath: string, fallback: string): string {
  const [body, setBody] = useState(fallback);
  useEffect(() => {
    if (textPath === "") return;
    let live = true;
    FilesService.ReadText(textPath, MAX_FULL_TEXT)
      .then((t) => live && setBody(t))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [textPath]);
  return body;
}

/** "Ask Local Chat" on a result: the recognised text goes to the chat as context. */
function AskChat({ item, body }: { item: OcrResultItem; body: string }) {
  const fileName = item.title;
  return (
    <ToolClickIn
      host="ocr"
      module="llm-chat"
      title="Ask Local Chat"
      extra={{ text: { title: `Text of ${fileName}`, body, prompts: CHAT_PROMPTS } }}
      disabledReason={body.trim() === "" ? "No text was found to ask about" : undefined}
    />
  );
}

/** "Save as document…": the recognised text file goes to the Document Converter (the backend reads .txt as Markdown). */
function SaveAsDocument({ textPath }: { textPath: string }) {
  return (
    <ToolClickIn
      host="ocr"
      module="documents"
      title="Save as document…"
      icon="file-text"
      inputs={textPath === "" ? [] : [textPath]}
      useLabel="Done"
      tip="Turn the recognised text into a Word, PDF, EPUB or other document (opens Document Converter here)"
      disabledReason={textPath === "" ? "No saved text file to convert" : undefined}
      onUse={(paths) => {
        const first = paths[0]?.split(/[\\/]/).pop() ?? "document";
        toast({ title: paths.length > 1 ? `Saved ${paths.length} documents` : `Saved ${first}`, tone: "success" });
      }}
    />
  );
}

function ResultCard({ item }: { item: OcrResultItem }) {
  const textFile = item.files.find((f) => f.path.toLowerCase().endsWith(".txt")) ?? item.files[0];
  const textPath = textFile && textFile.path.toLowerCase().endsWith(".txt") && !textFile.missing ? textFile.path : "";

  const fullText = useFullText(textPath, item.preview);
  const hasText = textPath !== "" || item.preview !== "";
  const textName = textFile && textPath !== "" ? textFile.name || textPath.split(/[\\/]/).pop() || "text.txt" : "text.txt";

  return (
    <article className={styles.card} aria-label={item.title}>
      <h4 className={styles.cardTitle}>{item.title}</h4>
      <p className={styles.meta} data-tip="What was read and how much">
        {item.meta}
      </p>
      {item.files.map((f) => (
        <ResultRow key={f.path} path={f.path} outputId={f.id || undefined} missing={f.missing} name={f.name} />
      ))}
      {hasText && (
        <>
          <AskChat item={item} body={fullText} />
          <SaveAsDocument textPath={textPath} />
          {item.preview !== "" && (
            <pre className={styles.preview} aria-label="Text preview" data-tip="The start of the text that was read; Copy and Save as… take all of it">
              {item.preview}
            </pre>
          )}
          <div className={styles.previewActions}>
            <TextActions text={fullText} filename={textName} what="text" disabled={fullText === ""} />
          </div>
        </>
      )}
    </article>
  );
}

export default function OcrView({ moduleId }: ToolViewProps) {
  const inputs = useFileInputs(moduleId);
  const [opts, setOpts] = useModuleOptions(moduleId, DEFAULT_OCR_OPTIONS, sanitizeOcrOptions);
  const [languages, setLanguages] = useState<OcrLanguageInfo[]>([]);
  const [running, setRunning] = useState(false);
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const jobs = useToolJobs(moduleId);
  useCompositionInputs(moduleId, { "llm-chat": [], documents: [] });

  useEffect(() => {
    let cancelled = false;
    OcrService.Languages()
      .then((l) => !cancelled && setLanguages(l ?? []))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const langs = languages.length > 0 ? languages : FALLBACK_LANGUAGES;
  const langOptions = useMemo(
    () =>
      langs.map((l) => ({
        value: l.id,
        label: l.downloadBytes > 0 ? `${l.label} (${downloadNote(l.downloadBytes)})` : l.label,
      })),
    [langs],
  );
  const selected = langs.find((l) => l.id === opts.language);

  const items = useMemo(
    () =>
      jobs
        .filter((j) => j.status === JobStatus.JobDone)
        .map(toOcrResult)
        .filter((i): i is OcrResultItem => i !== null)
        .slice(0, MAX_RESULTS),
    [jobs],
  );

  const n = inputs.files.length;
  const onRun = async () => {
    const paths = inputs.files.map((f) => f.path);
    setRunning(true);
    const res = await submitJobs(() => OcrService.Enqueue(paths, opts), paths, ["file", "files"]);
    setRunning(false);
    setInputErrors(res.inputErrors);
    if (res.ok) inputs.clear();
  };

  return (
    <FileToolLayout
      moduleId={moduleId}
      inputs={inputs}
      runLabel={runLabel("Read text from", n, "file", "files")}
      onRun={onRun}
      running={running}
      inputErrors={inputErrors}
      primary={
        <div className={styles.optRow}>
          <span id="ocr-language-label" className={styles.optLabel} data-tip="The language of the text in your scans; a wrong choice gives poor results">
            Language
          </span>
          <Select<OcrLanguage>
            aria-labelledby="ocr-language-label"
            data-tip="Language of the text in your files; some languages need a one-time model download shown in brackets"
            value={opts.language}
            options={langOptions}
            onChange={(language) => setOpts((o) => ({ ...o, language }))}
          />
          {selected && selected.downloadBytes > 0 && (
            <span className={styles.help} data-tip="Size of the language model downloaded the first time you use it">{downloadNote(selected.downloadBytes)}</span>
          )}
        </div>
      }
      advancedSummary={summarize(
        PDF_LABEL[opts.pdfOutput] ?? opts.pdfOutput,
        opts.imageOutput === OcrImageOutput.ImageJSON ? "images as JSON" : "images as text",
        opts.skipText && "skips pages with text",
      )}
      advanced={
        <div className={styles.options}>
          <div className={styles.optRow}>
            <span className={styles.optLabel} data-tip="What to produce when the input is a PDF">PDF output</span>
            <SegmentedControl
              aria-label="PDF output"
              value={opts.pdfOutput}
              onChange={(pdfOutput) => setOpts((o) => ({ ...o, pdfOutput }))}
              options={[
                { value: OcrPdfOutput.PDFSearchable, label: "Searchable PDF", tip: "A copy of the PDF with an invisible text layer so you can search and select text" },
                { value: OcrPdfOutput.PDFText, label: "Text", tip: "Only a plain text file with the recognised text" },
                { value: OcrPdfOutput.PDFBoth, label: "Both", tip: "Write the searchable PDF and a text file" },
              ]}
            />
          </div>
          <div className={styles.optRow}>
            <span className={styles.optLabel} data-tip="What to produce when the input is a photo or scan">Image output</span>
            <SegmentedControl
              aria-label="Image output"
              value={opts.imageOutput}
              onChange={(imageOutput) => setOpts((o) => ({ ...o, imageOutput }))}
              options={[
                { value: OcrImageOutput.ImageText, label: "Text", tip: "A plain text file with the recognised text" },
                { value: OcrImageOutput.ImageJSON, label: "Text + positions (JSON)", tip: "Also save where every word sits on the image, for scripts and other programs" },
              ]}
            />
          </div>
          <Switch
            checked={opts.skipText}
            onChange={(skipText) => setOpts((o) => ({ ...o, skipText }))}
            label="Skip pages that already have text"
            tip="Leave pages with real text alone, which is faster and keeps their original text"
          />
        </div>
      }
      results={
        <Section label="Results" tip="Recognised text with its files; copy it or open the saved file">
          {items.length === 0 ? (
            <EmptyLine title="No results yet." body="Read some scans or photos and the text appears here." />
          ) : (
            <div className={styles.cards}>
              {items.map((item) => (
                <ResultCard key={item.id} item={item} />
              ))}
            </div>
          )}
        </Section>
      }
    />
  );
}
