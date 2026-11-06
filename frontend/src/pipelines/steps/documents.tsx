import { DocumentFormat, type ArchiverOptions, type DocumentsOptions } from "@/lib/api";
import { Field } from "@/components/Field";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Select } from "@/components/Select";
import { Stepper } from "@/components/Stepper";
import { Switch } from "@/components/Switch";
import { parseObject, registerSteps, type StepEditorProps, type StepUI } from "./registry";
import { PARAMS } from "./paramDefs";
import styles from "./docs.module.css";

// Step editors for the Document Converter ("documents") and the Web Archiver ("archiver").

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((a) => a === v) ?? fallback;
}

function intIn(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

// ---------- Document Converter ----------

const FORMATS = [
  { value: DocumentFormat.FormatDOCX, label: "Word (docx)" },
  { value: DocumentFormat.FormatPDF, label: "PDF" },
  { value: DocumentFormat.FormatODT, label: "OpenDocument (odt)" },
  { value: DocumentFormat.FormatRTF, label: "Rich Text (rtf)" },
  { value: DocumentFormat.FormatEPUB, label: "EPUB" },
  { value: DocumentFormat.FormatHTML, label: "HTML" },
  { value: DocumentFormat.FormatMD, label: "Markdown" },
  { value: DocumentFormat.FormatGFM, label: "Markdown (GitHub)" },
  { value: DocumentFormat.FormatLaTeX, label: "LaTeX" },
  { value: DocumentFormat.FormatTypst, label: "Typst" },
  { value: DocumentFormat.FormatIPYNB, label: "Jupyter notebook" },
  { value: DocumentFormat.FormatPPTX, label: "PowerPoint (pptx)" },
  { value: DocumentFormat.FormatTXT, label: "Plain text" },
];
const FORMAT_IDS = FORMATS.map((f) => f.value);

/** Mirrors modules/documents DefaultOptions(). */
export const DEFAULT_DOCUMENTS_STEP: DocumentsOptions = {
  to: DocumentFormat.FormatDOCX,
  pageSize: "a4",
  marginMm: 25,
  mainFont: "",
  fontSizePt: 11,
  toc: false,
  numberSections: false,
  referenceDoc: "",
  embedResources: true,
  extractMedia: false,
};

export function parseDocumentsStep(json: string): DocumentsOptions {
  const r = parseObject(json);
  const d = DEFAULT_DOCUMENTS_STEP;
  return {
    to: pick(r.to, FORMAT_IDS, d.to),
    pageSize: pick(r.pageSize, ["a4", "letter"] as const, d.pageSize),
    marginMm: intIn(r.marginMm, 10, 50, d.marginMm),
    mainFont: typeof r.mainFont === "string" ? r.mainFont : d.mainFont,
    fontSizePt: intIn(r.fontSizePt, 9, 16, d.fontSizePt),
    toc: bool(r.toc, d.toc),
    numberSections: bool(r.numberSections, d.numberSections),
    referenceDoc: typeof r.referenceDoc === "string" ? r.referenceDoc : d.referenceDoc,
    embedResources: bool(r.embedResources, d.embedResources),
    extractMedia: bool(r.extractMedia, d.extractMedia),
  };
}

const PAGED = new Set<string>([DocumentFormat.FormatPDF, DocumentFormat.FormatTypst]);
const MEDIA = new Set<string>([DocumentFormat.FormatMD, DocumentFormat.FormatGFM, DocumentFormat.FormatHTML]);
const SECTIONED = new Set<string>([
  DocumentFormat.FormatDOCX,
  DocumentFormat.FormatODT,
  DocumentFormat.FormatPDF,
  DocumentFormat.FormatEPUB,
  DocumentFormat.FormatHTML,
  DocumentFormat.FormatLaTeX,
  DocumentFormat.FormatTypst,
]);

function DocumentsEditor({ value, onChange }: StepEditorProps<DocumentsOptions>) {
  const set = (patch: Partial<DocumentsOptions>) => onChange({ ...value, ...patch });
  const paged = PAGED.has(value.to);
  return (
    <div className={styles.stack}>
      <Field label="Convert to">
        {(c) => <Select {...c} value={value.to} options={FORMATS} onChange={(to) => set({ to })} />}
      </Field>
      {paged && (
        <>
          <Field label="Page size">
            <SegmentedControl
              aria-label="Page size"
              value={value.pageSize}
              options={[
                { value: "a4", label: "A4" },
                { value: "letter", label: "Letter" },
              ]}
              onChange={(pageSize) => set({ pageSize })}
            />
          </Field>
          <Field label="Margins">
            {(c) => <Stepper id={c.id} aria-label="Margins" value={value.marginMm} min={10} max={50} unit="mm" onChange={(marginMm) => set({ marginMm })} />}
          </Field>
          <Field label="Font size">
            {(c) => <Stepper id={c.id} aria-label="Font size" value={value.fontSizePt} min={9} max={16} unit="pt" onChange={(fontSizePt) => set({ fontSizePt })} />}
          </Field>
        </>
      )}
      {SECTIONED.has(value.to) && (
        <div className={styles.row}>
          <Switch label="Table of contents" checked={value.toc} onChange={(toc) => set({ toc })} />
          <Switch label="Number sections" checked={value.numberSections} onChange={(numberSections) => set({ numberSections })} />
        </div>
      )}
      {value.to === DocumentFormat.FormatHTML && (
        <Switch
          label="Embed images and styles"
          checked={value.embedResources}
          tip="Makes one self-contained HTML file"
          onChange={(embedResources) => set({ embedResources })}
        />
      )}
      {MEDIA.has(value.to) && (
        <Switch
          label="Save images beside the file"
          checked={value.extractMedia}
          tip="Puts pictures in a folder next to the result"
          onChange={(extractMedia) => set({ extractMedia })}
        />
      )}
    </div>
  );
}

// ---------- Web Archiver ----------

export const DEFAULT_ARCHIVER_STEP: ArchiverOptions = {
  urls: [],
  renderJs: false,
  noJs: false,
  noImages: false,
  alsoPdf: false,
  timeoutSec: 60,
  allowLocal: false,
};

export function parseArchiverStep(json: string): ArchiverOptions {
  const r = parseObject(json);
  const d = DEFAULT_ARCHIVER_STEP;
  return {
    urls: [],
    renderJs: bool(r.renderJs, d.renderJs),
    noJs: bool(r.noJs, d.noJs),
    noImages: bool(r.noImages, d.noImages),
    alsoPdf: bool(r.alsoPdf, d.alsoPdf),
    timeoutSec: intIn(r.timeoutSec, 10, 300, d.timeoutSec),
    allowLocal: bool(r.allowLocal, d.allowLocal),
  };
}

function ArchiverEditor({ value, onChange }: StepEditorProps<ArchiverOptions>) {
  const set = (patch: Partial<ArchiverOptions>) => onChange({ ...value, urls: [], ...patch });
  return (
    <div className={styles.stack}>
      <p className={styles.note}>Saves each link as one self-contained HTML file.</p>
      <Switch
        label="Render JavaScript"
        checked={value.renderJs}
        tip="Opens the page in your installed Edge or Chrome (temporary profile) so script-built content is saved"
        onChange={(renderJs) => set({ renderJs })}
      />
      <Switch label="Also PDF" checked={value.alsoPdf} tip="Also keeps a PDF copy (needs Edge or Chrome)" onChange={(alsoPdf) => set({ alsoPdf })} />
      <div className={styles.row}>
        <Switch label="No JavaScript" checked={value.noJs} onChange={(noJs) => set({ noJs })} />
        <Switch label="No images" checked={value.noImages} onChange={(noImages) => set({ noImages })} />
        <Switch label="Allow local addresses" checked={value.allowLocal} onChange={(allowLocal) => set({ allowLocal })} />
      </div>
      <Field label="Timeout">
        {(c) => <Stepper id={c.id} aria-label="Timeout" value={value.timeoutSec} min={10} max={300} step={10} unit="s" onChange={(timeoutSec) => set({ timeoutSec })} />}
      </Field>
    </div>
  );
}

const ui = <T,>(type: string, parse: (json: string) => T, Editor: StepUI<T>["Editor"]): StepUI<never> =>
  ({ type, parse, Editor, params: PARAMS[type] }) as unknown as StepUI<never>;

registerSteps([ui("documents", parseDocumentsStep, DocumentsEditor), ui("archiver", parseArchiverStep, ArchiverEditor)]);
