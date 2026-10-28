import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState, Section, SegmentedControl, Select, Switch, toast } from "@/components";
import {
  JobStatus,
  LibraryService,
  OcrImageOutput,
  OcrLanguage,
  OcrPdfOutput,
  OcrService,
  type OcrLanguageInfo,
} from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { revealLabel } from "@/lib/platform";
import { useOrderedJobs } from "@/state/jobs";
import { FileActions, FileToolLayout, runLabel, useFileInputs, useModuleOptions } from "@/tools/_kit";
import { submitJobs } from "@/tools/_kit/enqueue";
import type { ToolViewProps } from "../index";
import { DEFAULT_OCR_OPTIONS, FALLBACK_LANGUAGES, downloadNote, sanitizeOcrOptions, toOcrResult, type OcrResultItem } from "./options";
import styles from "./ocr.module.css";

const MAX_RESULTS = 24;

function ResultCard({ item }: { item: OcrResultItem }) {
  const textFile = item.files.find((f) => f.path.toLowerCase().endsWith(".txt")) ?? item.files[0];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.preview);
      toast({ title: "Text copied", tone: "success" });
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };
  const saveAs = () => {
    if (!textFile) return;
    const p = textFile.id ? LibraryService.Reveal(textFile.id) : LibraryService.RevealPath(textFile.path);
    p.catch((e: unknown) => toast({ title: toAppError(e).message, tone: "danger" }));
  };

  return (
    <article className={styles.card} aria-label={item.title}>
      <h4 className={styles.cardTitle}>{item.title}</h4>
      <p className={styles.meta}>{item.meta}</p>
      {item.files.map((f) => (
        <div key={f.path} className={styles.file}>
          <span className={f.missing ? `${styles.fileName} ${styles.missing}` : styles.fileName} title={f.path}>
            {f.name}
          </span>
          <FileActions outputId={f.id || undefined} path={f.path} disabled={f.missing} />
        </div>
      ))}
      {item.preview !== "" && (
        <>
          <pre className={styles.preview} aria-label="Text preview">
            {item.preview}
          </pre>
          <div className={styles.previewActions}>
            <Button size="sm" variant="secondary" icon="copy" onClick={() => void copy()}>
              Copy text
            </Button>
            <Button size="sm" variant="ghost" icon="folder-open" onClick={saveAs} title={revealLabel}>
              Save as…
            </Button>
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
  const jobs = useOrderedJobs(moduleId);

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
      options={
        <Section label="Options">
          <div className={styles.options}>
            <div className={styles.optRow}>
              <span id="ocr-language-label" className={styles.optLabel}>
                Language
              </span>
              <Select<OcrLanguage>
                aria-labelledby="ocr-language-label"
                value={opts.language}
                options={langOptions}
                onChange={(language) => setOpts((o) => ({ ...o, language }))}
              />
              {selected && selected.downloadBytes > 0 && (
                <span className={styles.help}>{downloadNote(selected.downloadBytes)}</span>
              )}
            </div>
            <div className={styles.optRow}>
              <span className={styles.optLabel}>PDF output</span>
              <SegmentedControl
                aria-label="PDF output"
                value={opts.pdfOutput}
                onChange={(pdfOutput) => setOpts((o) => ({ ...o, pdfOutput }))}
                options={[
                  { value: OcrPdfOutput.PDFSearchable, label: "Searchable PDF" },
                  { value: OcrPdfOutput.PDFText, label: "Text" },
                  { value: OcrPdfOutput.PDFBoth, label: "Both" },
                ]}
              />
            </div>
            <div className={styles.optRow}>
              <span className={styles.optLabel}>Image output</span>
              <SegmentedControl
                aria-label="Image output"
                value={opts.imageOutput}
                onChange={(imageOutput) => setOpts((o) => ({ ...o, imageOutput }))}
                options={[
                  { value: OcrImageOutput.ImageText, label: "Text" },
                  { value: OcrImageOutput.ImageJSON, label: "Text + positions (JSON)" },
                ]}
              />
            </div>
            <Switch
              checked={opts.skipText}
              onChange={(skipText) => setOpts((o) => ({ ...o, skipText }))}
              label="Skip pages that already have text"
            />
          </div>
        </Section>
      }
      results={
        <Section label="Results">
          {items.length === 0 ? (
            <EmptyState icon="file-text" title="No results yet." body="Read some scans or photos and the text appears here." />
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
