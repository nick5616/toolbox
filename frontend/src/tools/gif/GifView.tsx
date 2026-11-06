import { useEffect, useMemo, useState } from "react";
import { Icon, Section, SegmentedControl, Stepper, Switch } from "@/components";
import { GifMode, GifService, JobStatus } from "@/lib/api";
import { releaseImageUrl, wholeImageUrl } from "@/lib/wholeImage";
import { useToolJobs } from "@/tools/_kit/session";
import { EmptyLine, FileToolLayout, ResultRow, runLabel, summarize, useFileInputs, useModuleOptions } from "@/tools/_kit";
import { submitJobs } from "@/tools/_kit/enqueue";
import { useThumb } from "@/tools/_kit/image/common";
import type { ToolViewProps } from "../index";
import { DEFAULT_GIF_OPTIONS, gifSummary, sanitizeGifOptions, toGifResult, type GifResultItem } from "./options";
import styles from "./gif.module.css";

const MAX_RESULTS = 12;

const MODE_OPTIONS = [
  { value: GifMode.ModeGIF, label: "GIF", tip: "A looping animated GIF, works everywhere" },
  { value: GifMode.ModeWebP, label: "WebP", tip: "An animated WebP: smaller and sharper than a GIF, but not every app opens it" },
  { value: GifMode.ModeSheet, label: "Contact sheet", tip: "One picture with a grid of evenly spaced frames from the video" },
] as const;

/** The whole of a local image as a blob URL (GIFs can be bigger than one media response). */
function useWholeUrl(path: string): string {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let live = true;
    let made = "";
    wholeImageUrl(path)
      .then((u) => {
        made = u;
        if (live) setUrl(u);
        else releaseImageUrl(u);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      if (made !== "") releaseImageUrl(made);
      setUrl("");
    };
  }, [path]);
  return url;
}

function Animated({ item }: { item: GifResultItem }) {
  const url = useWholeUrl(item.missing ? "" : item.path);
  if (url === "") return <div className={styles.placeholder}>{item.missing ? "The file was moved or deleted" : "Loading preview…"}</div>;
  return <img className={styles.preview} src={url} alt={`Preview of ${item.name}`} />;
}

function Sheet({ item }: { item: GifResultItem }) {
  const thumb = useThumb(item.path, 960);
  if (thumb.status === "ok") return <img className={styles.preview} src={thumb.src} alt={`Contact sheet of ${item.title}`} />;
  return (
    <div className={styles.placeholder}>
      <Icon name="image" size={22} />
    </div>
  );
}

function ResultCard({ item }: { item: GifResultItem }) {
  return (
    <article className={styles.card} aria-label={item.title}>
      <h4 className={styles.cardTitle}>{item.title}</h4>
      {item.mode === GifMode.ModeSheet ? <Sheet item={item} /> : <Animated item={item} />}
      <p className={styles.meta}>{item.meta}</p>
      <ResultRow path={item.path} outputId={item.outputId || undefined} missing={item.missing} name={item.name} icon="image" />
    </article>
  );
}

export default function GifView({ moduleId }: ToolViewProps) {
  const inputs = useFileInputs(moduleId);
  const [opts, setOpts] = useModuleOptions(moduleId, DEFAULT_GIF_OPTIONS, sanitizeGifOptions);
  const [running, setRunning] = useState(false);
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const jobs = useToolJobs(moduleId);
  const sheet = opts.mode === GifMode.ModeSheet;

  const items = useMemo(
    () =>
      jobs
        .filter((j) => j.status === JobStatus.JobDone)
        .map(toGifResult)
        .filter((i): i is GifResultItem => i !== null)
        .slice(0, MAX_RESULTS),
    [jobs],
  );

  const n = inputs.files.length;
  const onRun = async () => {
    const paths = inputs.files.map((f) => f.path);
    setRunning(true);
    const res = await submitJobs(() => GifService.Enqueue(paths, opts), paths, ["video", "videos"]);
    setRunning(false);
    // Keep the video so a tweak and another run needs no re-pick; Clear empties the list.
    setInputErrors(res.inputErrors);
  };

  const verb = sheet ? "Make a sheet from" : opts.mode === GifMode.ModeWebP ? "Make a WebP from" : "Make a GIF from";

  return (
    <FileToolLayout
      moduleId={moduleId}
      inputs={inputs}
      runLabel={runLabel(verb, n, "video", "videos")}
      onRun={onRun}
      running={running}
      inputErrors={inputErrors}
      primary={
        <div className={styles.options}>
          <SegmentedControl<GifMode> aria-label="Make" value={opts.mode} options={MODE_OPTIONS} onChange={(mode) => setOpts((o) => ({ ...o, mode }))} />
          {sheet ? (
            <div className={styles.times}>
              <span className={styles.optRow}>
                Columns
                <Stepper aria-label="Columns" value={opts.columns} min={1} max={10} step={1} onChange={(columns) => setOpts((o) => ({ ...o, columns, rows: Math.min(o.rows, Math.floor(100 / columns)) }))} />
              </span>
              <span className={styles.optRow}>
                Rows
                <Stepper aria-label="Rows" value={opts.rows} min={1} max={Math.min(10, Math.floor(100 / opts.columns))} step={1} onChange={(rows) => setOpts((o) => ({ ...o, rows }))} />
              </span>
            </div>
          ) : (
            <div className={styles.times}>
              <span className={styles.optRow} data-tip="Where in the video the loop starts">
                Start
                <Stepper aria-label="Start" value={opts.startSec} min={0} max={36000} step={1} unit="s" onChange={(startSec) => setOpts((o) => ({ ...o, startSec }))} />
              </span>
              <span className={styles.optRow} data-tip="How long the loop is; up to 30 seconds">
                Length
                <Stepper aria-label="Length" value={opts.lengthSec} min={0.5} max={30} step={0.5} unit="s" onChange={(lengthSec) => setOpts((o) => ({ ...o, lengthSec }))} />
              </span>
            </div>
          )}
        </div>
      }
      advancedSummary={summarize(gifSummary(opts))}
      advanced={
        <div className={styles.options}>
          {sheet ? (
            <>
              <div className={styles.optRow}>
                <span className={styles.optLabel} data-tip="How wide each frame is on the sheet">Frame width</span>
                <Stepper aria-label="Frame width" value={opts.cellWidth} min={120} max={1280} step={40} unit="px" onChange={(cellWidth) => setOpts((o) => ({ ...o, cellWidth }))} />
              </div>
              <Switch checked={opts.labels} onChange={(labels) => setOpts((o) => ({ ...o, labels }))} label="Timecode on each frame" tip="Write the time in the video at the corner of every frame" />
            </>
          ) : (
            <>
              <div className={styles.optRow}>
                <span className={styles.optLabel} data-tip="More frames per second look smoother but make a bigger file">Frames per second</span>
                <Stepper aria-label="Frames per second" value={opts.fps} min={1} max={30} step={1} onChange={(fps) => setOpts((o) => ({ ...o, fps }))} />
              </div>
              <div className={styles.optRow}>
                <span className={styles.optLabel} data-tip="Never larger than the video itself">Width</span>
                <Stepper aria-label="Width" value={opts.width} min={120} max={1280} step={40} unit="px" onChange={(width) => setOpts((o) => ({ ...o, width }))} />
              </div>
              <Switch checked={opts.loop} onChange={(loop) => setOpts((o) => ({ ...o, loop }))} label="Loop forever" tip="Off: it plays once and stops on the last frame" />
            </>
          )}
        </div>
      }
      results={
        <Section label="Results" tip="Finished GIFs, WebPs and contact sheets">
          {items.length === 0 ? (
            <EmptyLine title="No results yet." body="Make a GIF or a contact sheet and it appears here." />
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
