import { useEffect, useMemo, useState } from "react";
import { Button, ColorSwatchPicker, Section, SegmentedControl, Select, Slider, Spinner, Stepper, Switch, TextField } from "@/components";
import {
  BatchCorner,
  BatchFit,
  BatchFormat,
  BatchResize,
  BatchWatermarkKind,
  FilesService,
  ImageBatchService,
  JobStatus,
  type ImageBatchOptions,
  type ImageBatchWatermark,
} from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { FileToolLayout, ResultTable, runLabel, useFileInputs, useModuleOptions } from "@/tools/_kit";
import type { ResultColumn } from "@/tools/_kit";
import { FileActions } from "@/tools/_kit/FileActions";
import { submitJobs } from "@/tools/_kit/enqueue";
import { basename } from "@/tools/_kit/image/common";
import { useToolJobs } from "@/tools/_kit/session";
import type { ToolViewProps } from "../index";
import {
  ASPECTS,
  DEFAULT_BATCH_OPTIONS,
  FALLBACK_FONTS,
  SIDE_LIMITS,
  advancedSummary,
  optionsProblem,
  parseBatch,
  previewKey,
  sanitizeBatchOptions,
  type BatchFileOutcome,
} from "./options";
import styles from "./ImageBatchView.module.css";

const PREVIEW_DELAY_MS = 500;
const MAX_ROWS = 100;

const CORNERS: Array<{ value: BatchCorner; label: string }> = [
  { value: BatchCorner.CornerBottomRight, label: "Bottom right" },
  { value: BatchCorner.CornerBottomLeft, label: "Bottom left" },
  { value: BatchCorner.CornerTopRight, label: "Top right" },
  { value: BatchCorner.CornerTopLeft, label: "Top left" },
  { value: BatchCorner.CornerCenter, label: "Centre" },
];

type Shown = { key: string; url: string } | { key: string; error: string };

interface PreviewProps {
  path: string;
  opts: ImageBatchOptions;
  paths: string[];
  onPick: (p: string) => void;
  blocked: string;
}

function PreviewCard({ path, opts, paths, onPick, blocked }: PreviewProps) {
  const key = previewKey(path, opts);
  const [shown, setShown] = useState<Shown | null>(null);
  useEffect(() => {
    if (blocked) return;
    let cancelled = false;
    const t = setTimeout(() => {
      ImageBatchService.Preview(path, opts)
        .then((url) => !cancelled && setShown({ key, url }))
        .catch((e: unknown) => !cancelled && setShown({ key, error: toAppError(e).message }));
    }, PREVIEW_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // `key` covers the path and every option that changes the picture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, blocked]);

  const fresh = shown !== null && shown.key === key;
  const url = shown && "url" in shown ? shown.url : "";
  const error = fresh && shown && "error" in shown ? shown.error : "";
  return (
    <Section label="Preview" tip="The first picture with the current settings">
      <div className={styles.preview} data-testid="batch-preview">
        {paths.length > 1 ? (
          <Select aria-label="Preview file" size="sm" value={path} onChange={onPick} options={paths.map((p) => ({ value: p, label: basename(p) }))} />
        ) : (
          <span className={styles.fileName}>{basename(path)}</span>
        )}
        <div className={styles.frame}>
          {url && <img src={url} alt="Preview of the first picture" />}
          {!url && !error && <span className={styles.hint}>{blocked || "Making the preview…"}</span>}
          {!fresh && !blocked && url !== "" && <Spinner className={styles.busy} />}
        </div>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </Section>
  );
}

export default function ImageBatchView({ moduleId }: ToolViewProps) {
  const inputs = useFileInputs(moduleId);
  const [opts, setOpts] = useModuleOptions(moduleId, DEFAULT_BATCH_OPTIONS, sanitizeBatchOptions);
  const [running, setRunning] = useState(false);
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState("");
  const [fonts, setFonts] = useState<string[]>([...FALLBACK_FONTS]);
  const jobs = useToolJobs(moduleId);

  useEffect(() => {
    let cancelled = false;
    ImageBatchService.Fonts()
      .then((f) => !cancelled && f && f.length > 0 && setFonts(f))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const paths = useMemo(() => inputs.files.map((f) => f.path), [inputs.files]);
  const previewPath = paths.includes(selected) ? selected : (paths[0] ?? "");
  const problem = optionsProblem(opts);
  const set = (patch: Partial<ImageBatchOptions>) => setOpts((o) => ({ ...o, ...patch }));
  const setMark = (patch: Partial<ImageBatchWatermark>) => setOpts((o) => ({ ...o, watermark: { ...o.watermark, ...patch } }));
  const wm = opts.watermark;

  const onRun = async () => {
    setRunning(true);
    const res = await submitJobs(() => ImageBatchService.Enqueue(paths, opts), paths, ["picture", "pictures"]);
    setRunning(false);
    setInputErrors(res.inputErrors);
    if (res.ok) inputs.clear();
  };

  const pickLogo = async () => {
    const picked = (await FilesService.PickWith("Choose a logo", [".png", ".jpg", ".jpeg", ".webp"], false)) ?? [];
    const first = picked[0];
    if (first) setMark({ logo: first });
  };

  const { rows, failed } = useMemo(() => {
    const out: Array<BatchFileOutcome & { id: string; outputId?: string; missing?: boolean }> = [];
    const bad: string[] = [];
    for (const j of jobs) {
      if (j.status !== JobStatus.JobDone) continue;
      const r = parseBatch(j.resultJson);
      bad.push(...r.failed);
      for (const f of r.files) {
        const o = j.outputs.find((x) => x.path === f.output);
        out.push({ ...f, id: `${j.id}:${f.output}`, outputId: o?.id, missing: o?.missing });
      }
    }
    return { rows: out.slice(0, MAX_ROWS), failed: bad.slice(0, 5) };
  }, [jobs]);

  const columns: ResultColumn<(typeof rows)[number]>[] = [
    { key: "file", header: "File", render: (r) => <span data-tip={r.output}>{basename(r.output)}</span>, text: (r) => basename(r.output) },
    { key: "size", header: "Size", align: "right", mono: true, render: (r) => `${r.width} × ${r.height}`, text: (r) => `${r.width}x${r.height}` },
    { key: "bytes", header: "Weight", align: "right", mono: true, render: (r) => formatBytes(r.bytes), text: (r) => String(r.bytes) },
    {
      key: "actions",
      header: "",
      render: (r) => <FileActions outputId={r.outputId} path={r.output} disabled={r.missing} />,
      text: (r) => r.output,
    },
  ];

  const n = paths.length;
  return (
    <FileToolLayout
      moduleId={moduleId}
      inputs={inputs}
      runLabel={runLabel("Process", n, "picture", "pictures")}
      onRun={onRun}
      running={running}
      inputErrors={inputErrors}
      runDisabledReason={problem || undefined}
      primary={
        <>
          <div className={styles.options}>
            <div className={styles.row}>
              <span className={styles.label} data-tip="How big the finished pictures are">Size</span>
              <SegmentedControl
                aria-label="Size"
                value={opts.resize}
                onChange={(resize) => set({ resize })}
                options={[
                  { value: BatchResize.ResizeLongSide, label: "Long side", tip: "Set the longer side; the other follows the picture's shape" },
                  { value: BatchResize.ResizeExact, label: "Exact size", tip: "Make every picture exactly this width and height" },
                  { value: BatchResize.ResizeKeep, label: "Keep size", tip: "Leave the size as it is" },
                ]}
              />
              {opts.resize === BatchResize.ResizeLongSide && (
                <Stepper
                  aria-label="Long side"
                  data-tip="Pixels on the longer side"
                  value={opts.longSide}
                  min={SIDE_LIMITS.min}
                  max={SIDE_LIMITS.max}
                  step={128}
                  unit="px"
                  onChange={(longSide) => set({ longSide })}
                />
              )}
              {opts.resize === BatchResize.ResizeExact && (
                <>
                  <Stepper aria-label="Width" data-tip="Width in pixels" value={opts.width} min={1} max={SIDE_LIMITS.max} step={10} unit="w" onChange={(width) => set({ width })} />
                  <Stepper aria-label="Height" data-tip="Height in pixels" value={opts.height} min={1} max={SIDE_LIMITS.max} step={10} unit="h" onChange={(height) => set({ height })} />
                </>
              )}
            </div>
            {opts.resize === BatchResize.ResizeExact && (
              <div className={styles.row}>
                <span className={styles.label} data-tip="What happens when a picture has a different shape">Different shape</span>
                <SegmentedControl
                  aria-label="Different shape"
                  value={opts.fit}
                  onChange={(fit) => set({ fit })}
                  options={[
                    { value: BatchFit.FitCrop, label: "Crop", tip: "Cut the edges so the picture fills the size" },
                    { value: BatchFit.FitPad, label: "Pad", tip: "Keep the whole picture and fill the rest with a colour" },
                  ]}
                />
              </div>
            )}
          </div>
          {previewPath && <PreviewCard path={previewPath} opts={opts} paths={paths} onPick={setSelected} blocked={problem} />}
          {failed.length > 0 && (
            <p className={styles.failed} role="alert">
              Some pictures couldn't be processed: {failed.join("; ")}
            </p>
          )}
        </>
      }
      advancedSummary={advancedSummary(opts)}
      advanced={
        <div className={styles.options}>
          {opts.resize !== BatchResize.ResizeExact && (
            <>
              <div className={styles.row}>
                <span className={styles.label} data-tip="Crop or pad every picture to one shape">Shape</span>
                <Select
                  aria-label="Shape"
                  size="sm"
                  value={opts.aspect}
                  onChange={(aspect) => set({ aspect })}
                  options={[{ value: "", label: "Keep each picture's own" }, ...ASPECTS.map((a) => ({ value: a as string, label: a }))]}
                />
                {opts.aspect !== "" && (
                  <SegmentedControl
                    aria-label="Crop or pad"
                    value={opts.fit}
                    onChange={(fit) => set({ fit })}
                    options={[
                      { value: BatchFit.FitCrop, label: "Crop", tip: "Cut from the centre" },
                      { value: BatchFit.FitPad, label: "Pad", tip: "Add bars so nothing is cut" },
                    ]}
                  />
                )}
              </div>
              {opts.resize === BatchResize.ResizeLongSide && (
                <Switch
                  checked={opts.noEnlarge}
                  onChange={(noEnlarge) => set({ noEnlarge })}
                  label="Never make a picture bigger"
                  tip="Smaller pictures keep their size instead of being stretched"
                />
              )}
            </>
          )}
          {opts.fit === BatchFit.FitPad && (opts.aspect !== "" || opts.resize === BatchResize.ResizeExact) && (
            <div className={styles.row}>
              <span className={styles.label} data-tip="The colour used for padding (transparent needs PNG or WebP)">Pad colour</span>
              <ColorSwatchPicker aria-label="Pad colour" value={opts.background} allowTransparent onChange={(background) => set({ background })} />
            </div>
          )}

          <div className={styles.row}>
            <span className={styles.label} data-tip="The type of file that is saved">Format</span>
            <SegmentedControl
              aria-label="Format"
              value={opts.format}
              onChange={(format) => set({ format })}
              options={[
                { value: BatchFormat.FormatJPG, label: "JPEG", tip: "Small files for photos" },
                { value: BatchFormat.FormatPNG, label: "PNG", tip: "Lossless, keeps transparency" },
                { value: BatchFormat.FormatWebP, label: "WebP", tip: "Smaller than JPEG; needs FFmpeg" },
                { value: BatchFormat.FormatSame, label: "Same", tip: "Keep each picture's own type" },
              ]}
            />
          </div>
          {opts.format !== BatchFormat.FormatPNG && (
            <div className={styles.row}>
              <span className={styles.label} data-tip="Higher is sharper and larger">Quality</span>
              <Slider aria-label="Quality" value={opts.quality} min={1} max={100} step={1} onChange={(quality) => set({ quality })} format={(v) => String(Math.round(v))} />
            </div>
          )}

          <Section label="Watermark" tip="Draw a text or a logo on every picture">
            <div className={styles.options}>
              <SegmentedControl
                aria-label="Watermark"
                value={wm.kind}
                onChange={(kind) => setMark({ kind })}
                options={[
                  { value: BatchWatermarkKind.WatermarkNone, label: "None" },
                  { value: BatchWatermarkKind.WatermarkText, label: "Text" },
                  { value: BatchWatermarkKind.WatermarkLogo, label: "Logo" },
                ]}
              />
              {wm.kind === BatchWatermarkKind.WatermarkText && (
                <>
                  <TextField aria-label="Watermark text" placeholder="© Your name" value={wm.text} maxLength={200} onChange={(e) => setMark({ text: e.target.value })} />
                  <div className={styles.row}>
                    <Select aria-label="Font" size="sm" value={wm.font} onChange={(font) => setMark({ font })} options={fonts.map((f) => ({ value: f, label: f }))} />
                    <ColorSwatchPicker aria-label="Text colour" value={wm.color} onChange={(color) => setMark({ color })} />
                  </div>
                </>
              )}
              {wm.kind === BatchWatermarkKind.WatermarkLogo && (
                <div className={styles.row}>
                  <Button size="sm" variant="secondary" icon="image" onClick={() => void pickLogo()} data-tip="Choose a PNG with a transparent background for best results">
                    {wm.logo ? "Change logo…" : "Choose logo…"}
                  </Button>
                  {wm.logo && <span className={styles.fileName} data-tip={wm.logo}>{basename(wm.logo)}</span>}
                </div>
              )}
              {wm.kind !== BatchWatermarkKind.WatermarkNone && (
                <>
                  <div className={styles.row}>
                    <span className={styles.label}>Position</span>
                    <Select aria-label="Corner" size="sm" value={wm.corner} onChange={(corner) => setMark({ corner })} options={CORNERS} />
                  </div>
                  <div className={styles.row}>
                    <span className={styles.label} data-tip="How see-through the mark is">Opacity</span>
                    <Slider aria-label="Opacity" value={wm.opacity} min={0.05} max={1} step={0.05} onChange={(opacity) => setMark({ opacity })} format={(v) => `${Math.round(v * 100)}%`} />
                  </div>
                  <div className={styles.row}>
                    <span className={styles.label} data-tip={wm.kind === BatchWatermarkKind.WatermarkText ? "Text height as a percentage of the picture's short side" : "Logo width as a percentage of the picture's width"}>Size</span>
                    <Stepper aria-label="Watermark size" value={wm.size} min={2} max={60} step={1} unit="%" onChange={(size) => setMark({ size })} />
                  </div>
                </>
              )}
            </div>
          </Section>

          <div>
            <Switch
              checked={opts.strip}
              onChange={(strip) => set({ strip })}
              label="Strip metadata"
              tip="Remove camera details and location. Orientation is always applied to the pixels"
            />
            {!opts.strip && <p className={styles.hint}>Metadata is only kept when a JPEG is saved as a JPEG.</p>}
          </div>
          <div className={styles.row}>
            <span className={styles.label} data-tip="{name} is the original name, {n} a running number, {date} today's date">File name</span>
            <TextField aria-label="File name pattern" mono placeholder="{name}" value={opts.name} maxLength={200} onChange={(e) => set({ name: e.target.value })} />
          </div>
          <p className={styles.hint}>Use {"{name}"}, {"{n}"} and {"{date}"}. Originals are never changed.</p>
        </div>
      }
      results={
        <Section label="Results" tip="Finished pictures with their size and weight">
          <ResultTable
            rows={rows}
            columns={columns}
            rowKey={(r) => r.id}
            label="pictures"
            rowFile={(r) => ({ path: r.output, outputId: r.outputId, missing: r.missing })}
            empty="No pictures yet. Processed pictures appear here."
          />
        </Section>
      }
    />
  );
}
