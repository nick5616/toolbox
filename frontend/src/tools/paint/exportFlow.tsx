/**
 * Export (SPEC §1.1 item 14, §2.6): the dialog, the follow-up job and the
 * LastExport row; Export as…; Copy image. Blend modes the Go compositor
 * doesn't know are flattened here and sent as `flattened`.
 */
import { useState } from "react";
import { toast } from "@/components/toast";
import { JobStatus, PaintExportFormat, PaintService, type PaintDoc, type PaintExportOptions } from "@/lib/api";
import { LastExport } from "@/editor/export/LastExport";
import { toAppError } from "@/lib/errors";
import { useJob, useJobs } from "@/state/jobs";
import type { PaintEngine } from "@/paint/engine/types";
import { useEditor } from "./context";
import { Dialog, FieldRow, Segmented, Stepper, TextButton } from "./ui";
import styles from "./editor.module.css";

/** Blend modes the Go compositor flattens itself (modules/paint GoBlends). */
export const GO_BLENDS = ["normal", "multiply", "screen", "overlay", "add", "darken", "lighten"];

/** True when a visible layer uses a mode Go can't flatten. */
export function needsFrontendFlatten(doc: Pick<PaintDoc, "layers">): boolean {
  return (doc.layers ?? []).some((l) => !l.hidden && !GO_BLENDS.includes(l.blend));
}

export async function bitmapToDataURL(bmp: ImageBitmap): Promise<string> {
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext("2d")?.drawImage(bmp, 0, 0);
  bmp.close();
  return c.toDataURL("image/png");
}

/** The flattened canvas as a PNG data URL (scale 1). */
export async function flattenedDataURL(engine: PaintEngine): Promise<string> {
  return bitmapToDataURL(await engine.flattenToBitmap(1));
}

const FORMATS: Array<{ value: PaintExportFormat; label: string; tip: string }> = [
  { value: PaintExportFormat.FormatPNG, label: "PNG", tip: "Lossless, keeps transparency" },
  { value: PaintExportFormat.FormatJPG, label: "JPG", tip: "Smaller files, no transparency" },
  { value: PaintExportFormat.FormatWebP, label: "WebP", tip: "Small and sharp" },
  { value: PaintExportFormat.FormatORA, label: "ORA", tip: "OpenRaster: keeps your layers (opens in Krita and GIMP)" },
];

export interface ExportRequest {
  format: PaintExportFormat;
  quality: number;
  scale: number;
  name: string;
}

async function build(engine: PaintEngine, projectId: string, r: ExportRequest): Promise<PaintExportOptions> {
  const base = await PaintService.DefaultExport();
  const flattened = r.format !== PaintExportFormat.FormatORA && needsFrontendFlatten(engine.doc) ? await flattenedDataURL(engine) : "";
  return { ...base, projectId, format: r.format, quality: r.quality, scale: r.scale, name: r.name, flattened };
}

export function ExportDialog({ name, onClose, onJob }: { name: string; onClose(): void; onJob(jobId: string): void }) {
  const { engine, projectId, saver } = useEditor();
  const [format, setFormat] = useState<PaintExportFormat>(PaintExportFormat.FormatPNG);
  const [quality, setQuality] = useState(92);
  const [pct, setPct] = useState(100);
  const [fileName, setFileName] = useState(name);
  const [busy, setBusy] = useState(false);
  const lossy = format === PaintExportFormat.FormatJPG || format === PaintExportFormat.FormatWebP;
  const req: ExportRequest = { format, quality, scale: pct / 100, name: fileName.trim() };

  const run = async (as: boolean) => {
    setBusy(true);
    try {
      await saver.flush();
      const opts = await build(engine, projectId, req);
      if (as) {
        const path = await PaintService.ExportAs(opts);
        if (path) toast({ title: "Saved a copy", description: path, tone: "success" });
        else return;
      } else {
        const job = await PaintService.Export(opts);
        useJobs.getState().upsert(job);
        onJob(job.id);
      }
      onClose();
    } catch (e) {
      toast({ title: "Couldn't export", description: toAppError(e).message, tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Export"
      onClose={onClose}
      actions={
        <>
          <TextButton tip="Close without exporting" onClick={onClose}>
            Cancel
          </TextButton>
          <TextButton tip="Choose where to save a copy; it isn't added to your library" disabled={busy} reason="Exporting…" onClick={() => void run(true)}>
            Export as…
          </TextButton>
          <TextButton primary tip="Export into your library's Paintings folder" disabled={busy} reason="Exporting…" onClick={() => void run(false)}>
            Export
          </TextButton>
        </>
      }
    >
      <Segmented<PaintExportFormat> label="Format" value={format} options={FORMATS} onChange={setFormat} />
      {lossy ? (
        <FieldRow label="Quality">
          <Stepper label="Quality" value={quality} min={60} max={100} onChange={setQuality} unit="%" />
        </FieldRow>
      ) : null}
      <FieldRow label="Scale">
        <Stepper label="Scale" value={pct} min={25} max={400} step={25} onChange={setPct} unit="%" />
      </FieldRow>
      <FieldRow label="File name">
        <input className={styles.nameInput} aria-label="File name" data-tip="Name of the exported file, without the extension" value={fileName} onChange={(e) => setFileName(e.target.value)} />
      </FieldRow>
      <p style={{ margin: 0 }}>
        {pct !== 100 ? `${Math.round((engine.doc.width * pct) / 100)} × ${Math.round((engine.doc.height * pct) / 100)} px. ` : `${engine.doc.width} × ${engine.doc.height} px. `}
        {format === PaintExportFormat.FormatORA ? "Layers are kept." : needsFrontendFlatten(engine.doc) ? "Some layers use blend modes that Paint+ flattens itself first." : ""}
      </p>
    </Dialog>
  );
}

/** Follows an export job and shows its LastExport row (Reveal, Open, Save a copy, Send to). */
export function ExportResult({ jobId, onDismiss }: { jobId: string; onDismiss(): void }) {
  const job = useJob(jobId);
  if (!job) return null;
  const out = job.outputs[0];
  if (job.status === JobStatus.JobFailed)
    return (
      <div className={styles.exportChip} role="alert" data-testid="export-failed">
        Export failed{job.error ? `: ${job.error}` : ""}
        <TextButton tip="Hide this message" onClick={onDismiss}>
          Dismiss
        </TextButton>
      </div>
    );
  if (job.status !== JobStatus.JobDone || !out)
    return (
      <div className={styles.exportChip} role="status" data-testid="export-running">
        Exporting…
      </div>
    );
  return (
    <div className={styles.lastExport} data-testid="export-result">
      <LastExport path={out.path} outputId={out.id} moduleId="paint" onDismiss={onDismiss} />
    </div>
  );
}

/** Puts the flattened canvas on the clipboard (the app has no Go API for images; the webview's own clipboard is used). */
export async function copyImage(engine: PaintEngine): Promise<void> {
  const bmp = await engine.flattenToBitmap(1);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext("2d")?.drawImage(bmp, 0, 0);
  bmp.close();
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
  if (!blob) throw new Error("Couldn't make an image to copy");
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) throw new Error("This window can't put images on the clipboard");
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}
