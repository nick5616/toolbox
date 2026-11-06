import { useMemo, useState } from "react";
import { Button, Icon, Section, SegmentedControl, Select, Slider, Stepper } from "@/components";
import { formatMs } from "@/components/media";
import { JobStatus, SceneKeep, SceneOutput, ScenesService } from "@/lib/api";
import { useToolJobs } from "@/tools/_kit/session";
import { EmptyLine, FileToolLayout, ResultRow, runLabel, summarize, useFileInputs, useModuleOptions } from "@/tools/_kit";
import { submitJobs } from "@/tools/_kit/enqueue";
import { basename, useThumb } from "@/tools/_kit/image/common";
import { useResultBehaviour } from "@/tools/_kit/ResultRow";
import type { ToolViewProps } from "../index";
import {
  DEFAULT_SCENES_OPTIONS,
  sanitizeScenesOptions,
  sceneCountText,
  scenesSummary,
  toScenesResult,
  type SceneItem,
  type ScenesResultItem,
} from "./options";
import styles from "./scenes.module.css";

const MAX_RESULTS = 12;
const MAX_ROWS = 8;

const OUTPUT_OPTIONS = [
  { value: SceneOutput.OutputBoth, label: "Clips + stills", tip: "Save each scene as a video clip and a picture from its middle" },
  { value: SceneOutput.OutputClips, label: "Clips", tip: "Save each scene as its own video file" },
  { value: SceneOutput.OutputStills, label: "Stills", tip: "Save one picture per scene" },
] as const;

const KEEP_OPTIONS = [
  { value: SceneKeep.KeepAll, label: "All scenes" },
  { value: SceneKeep.KeepLongest, label: "The longest" },
  { value: SceneKeep.KeepActive, label: "The most active" },
];

function range(s: SceneItem): string {
  const t = (ms: number) => formatMs(ms).replace(/\.\d+$/, "");
  return `${t(s.startMs)}–${t(s.endMs)}`;
}

/** One scene in the strip: its still (or a tile when only the clip was saved). */
function SceneCell({ scene, item }: { scene: SceneItem; item: ScenesResultItem }) {
  const path = scene.still !== "" ? scene.still : scene.clip;
  const file = item.files.get(path);
  const behaviour = useResultBehaviour({ path, outputId: file?.id || undefined, missing: file?.missing });
  const thumb = useThumb(scene.still, 288);
  const label = `Scene ${scene.n}, ${range(scene)}`;
  return (
    <div {...behaviour} className={styles.cell} aria-label={label} data-tip="Double-click to open; drag it into another app">
      {scene.still !== "" && thumb.status === "ok" ? (
        <img className={styles.thumb} src={thumb.src} alt="" draggable={false} />
      ) : (
        <div className={styles.tile}>
          <Icon name={scene.still !== "" ? "image" : "film"} size={22} />
        </div>
      )}
      <span className={styles.cellLabel}>
        #{scene.n} · {range(scene)}
      </span>
    </div>
  );
}

function ResultCard({ item }: { item: ScenesResultItem }) {
  const [all, setAll] = useState(false);
  const clips = item.scenes.filter((s) => s.clip !== "");
  const shown = all ? clips : clips.slice(0, MAX_ROWS);
  return (
    <article className={styles.card} aria-label={item.title}>
      <h4 className={styles.cardTitle}>{item.title}</h4>
      <p className={styles.meta}>
        {sceneCountText(item)}
        {item.reencoded > 0 && ` · ${item.reencoded} re-encoded to cut exactly`}
      </p>
      {item.scenes.length === 0 ? (
        <p className={styles.meta}>No scenes were found.</p>
      ) : (
        <div className={styles.strip} aria-label="Scenes">
          {item.scenes.map((s) => (
            <SceneCell key={s.n} scene={s} item={item} />
          ))}
        </div>
      )}
      {clips.length > 0 && (
        <div className={styles.rows}>
          {shown.map((s) => {
            const f = item.files.get(s.clip);
            return <ResultRow key={s.clip} path={s.clip} outputId={f?.id || undefined} missing={f?.missing} name={basename(s.clip)} icon="film" meta={range(s)} />;
          })}
          {clips.length > MAX_ROWS && (
            <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>
              {all ? "Show fewer" : `Show all ${clips.length} clips`}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

export default function ScenesView({ moduleId }: ToolViewProps) {
  const inputs = useFileInputs(moduleId);
  const [opts, setOpts] = useModuleOptions(moduleId, DEFAULT_SCENES_OPTIONS, sanitizeScenesOptions);
  const [running, setRunning] = useState(false);
  const [inputErrors, setInputErrors] = useState<Record<string, string>>({});
  const jobs = useToolJobs(moduleId);

  const items = useMemo(
    () =>
      jobs
        .filter((j) => j.status === JobStatus.JobDone)
        .map(toScenesResult)
        .filter((i): i is ScenesResultItem => i !== null)
        .slice(0, MAX_RESULTS),
    [jobs],
  );

  const n = inputs.files.length;
  const onRun = async () => {
    const paths = inputs.files.map((f) => f.path);
    setRunning(true);
    const res = await submitJobs(() => ScenesService.Enqueue(paths, opts), paths, ["video", "videos"]);
    setRunning(false);
    setInputErrors(res.inputErrors);
    if (res.ok) inputs.clear();
  };

  return (
    <FileToolLayout
      moduleId={moduleId}
      inputs={inputs}
      runLabel={runLabel("Split", n, "video", "videos")}
      onRun={onRun}
      running={running}
      inputErrors={inputErrors}
      primary={
        <div className={styles.options}>
          <div className={styles.optRow}>
            <span id="scenes-output-label" className={styles.optLabel}>
              Save
            </span>
            <SegmentedControl<SceneOutput>
              aria-labelledby="scenes-output-label"
              value={opts.output}
              options={OUTPUT_OPTIONS}
              onChange={(output) => setOpts((o) => ({ ...o, output }))}
            />
          </div>
          <div className={styles.optRow}>
            <span id="scenes-keep-label" className={styles.optLabel}>
              Keep
            </span>
            <Select<SceneKeep>
              aria-labelledby="scenes-keep-label"
              data-tip="Save every scene, or only the longest ones or the ones with the most movement"
              value={opts.keep}
              options={KEEP_OPTIONS}
              onChange={(keep) => setOpts((o) => ({ ...o, keep }))}
            />
            {opts.keep !== SceneKeep.KeepAll && (
              <Stepper aria-label="Number of scenes to keep" value={opts.keepN} min={1} max={200} step={1} onChange={(keepN) => setOpts((o) => ({ ...o, keepN }))} />
            )}
          </div>
        </div>
      }
      advancedSummary={summarize(scenesSummary(opts))}
      advanced={
        <div className={styles.options}>
          <div className={styles.optRow}>
            <span id="scenes-threshold-label" className={styles.optLabel} data-tip="How big a change in the picture counts as a new scene. Lower finds more cuts.">
              Sensitivity
            </span>
            <Slider
              aria-label="Sensitivity"
              min={0.05}
              max={0.9}
              step={0.05}
              value={opts.threshold}
              format={(v) => v.toFixed(2)}
              onChange={(threshold) => setOpts((o) => ({ ...o, threshold }))}
            />
          </div>
          <div className={styles.optRow}>
            <span className={styles.optLabel} data-tip="Scenes shorter than this join the scene before them">
              Shortest scene
            </span>
            <Stepper aria-label="Shortest scene" value={opts.minSceneSecs} min={0.2} max={60} step={0.5} unit="s" onChange={(minSceneSecs) => setOpts((o) => ({ ...o, minSceneSecs }))} />
          </div>
        </div>
      }
      results={
        <Section label="Results" tip="Scenes found in each video, with the files saved">
          {items.length === 0 ? (
            <EmptyLine title="No results yet." body="Split a video and its scenes appear here." />
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
