import { Field } from "@/components/Field";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Stepper } from "@/components/Stepper";
import { Switch } from "@/components/Switch";
import { GifMode, type GifStepOptions } from "@/lib/api";
import { bool, num, oneOf, ui } from "./phase14";
import { parseObject, registerSteps, type StepEditorProps, type StepUI } from "./registry";
import styles from "./phase14.module.css";

// Step editor of GIF & Contact Sheet ("gif"), Phase 15. parse() keeps unknown
// fields and fills anything missing or out of range with the default.

/** Mirrors modules/gif DefaultStepOptions(). */
export const DEFAULT_GIF_STEP: GifStepOptions = {
  mode: GifMode.ModeGIF,
  startSec: 0,
  lengthSec: 5,
  fps: 12,
  width: 480,
  loop: true,
  columns: 4,
  rows: 4,
  cellWidth: 320,
  labels: true,
};

const MODES = [GifMode.ModeGIF, GifMode.ModeWebP, GifMode.ModeSheet] as const;

const inRange = (v: unknown, lo: number, hi: number, d: number): number => {
  const n = num(v, d);
  return n >= lo && n <= hi ? n : d;
};

export function parseGifStep(json: string): GifStepOptions {
  const r = parseObject(json);
  const d = DEFAULT_GIF_STEP;
  const columns = Math.round(inRange(r.columns, 1, 10, d.columns));
  let rows = Math.round(inRange(r.rows, 1, 10, d.rows));
  while (columns * rows > 100) rows -= 1;
  return {
    ...r,
    mode: oneOf(r.mode, MODES, d.mode),
    startSec: inRange(r.startSec, 0, 36000, d.startSec),
    lengthSec: inRange(r.lengthSec, 0.5, 30, d.lengthSec),
    fps: Math.round(inRange(r.fps, 1, 30, d.fps)),
    width: Math.round(inRange(r.width, 120, 1280, d.width)),
    loop: bool(r.loop, d.loop),
    columns,
    rows,
    cellWidth: Math.round(inRange(r.cellWidth, 120, 1280, d.cellWidth)),
    labels: bool(r.labels, d.labels),
  };
}

function GifEditor({ value, onChange }: StepEditorProps<GifStepOptions>) {
  const set = (patch: Partial<GifStepOptions>) => onChange({ ...value, ...patch });
  const sheet = value.mode === GifMode.ModeSheet;
  return (
    <div className={styles.stack}>
      <Field label="Make">
        <SegmentedControl<GifMode>
          aria-label="Make"
          value={value.mode}
          options={[
            { value: GifMode.ModeGIF, label: "GIF" },
            { value: GifMode.ModeWebP, label: "WebP" },
            { value: GifMode.ModeSheet, label: "Contact sheet" },
          ]}
          onChange={(mode) => set({ mode })}
        />
      </Field>
      {sheet ? (
        <>
          <div className={styles.pair}>
            <Field label="Columns">
              {(c) => <Stepper id={c.id} aria-label="Columns" value={value.columns} min={1} max={10} step={1} onChange={(columns) => set({ columns, rows: Math.min(value.rows, Math.floor(100 / columns)) })} />}
            </Field>
            <Field label="Rows">
              {(c) => <Stepper id={c.id} aria-label="Rows" value={value.rows} min={1} max={Math.min(10, Math.floor(100 / value.columns))} step={1} onChange={(rows) => set({ rows })} />}
            </Field>
          </div>
          <Field label="Frame width">
            {(c) => <Stepper id={c.id} aria-label="Frame width" value={value.cellWidth} min={120} max={1280} step={40} unit="px" onChange={(cellWidth) => set({ cellWidth })} />}
          </Field>
          <Switch checked={value.labels} onChange={(labels) => set({ labels })} label="Timecode on each frame" />
        </>
      ) : (
        <>
          <div className={styles.pair}>
            <Field label="Start">
              {(c) => <Stepper id={c.id} aria-label="Start" value={value.startSec} min={0} max={36000} step={1} unit="s" onChange={(startSec) => set({ startSec })} />}
            </Field>
            <Field label="Length">
              {(c) => <Stepper id={c.id} aria-label="Length" value={value.lengthSec} min={0.5} max={30} step={0.5} unit="s" onChange={(lengthSec) => set({ lengthSec })} />}
            </Field>
          </div>
          <div className={styles.pair}>
            <Field label="Frames per second">
              {(c) => <Stepper id={c.id} aria-label="Frames per second" value={value.fps} min={1} max={30} step={1} onChange={(fps) => set({ fps })} />}
            </Field>
            <Field label="Width">
              {(c) => <Stepper id={c.id} aria-label="Width" value={value.width} min={120} max={1280} step={40} unit="px" onChange={(width) => set({ width })} />}
            </Field>
          </div>
          <Switch checked={value.loop} onChange={(loop) => set({ loop })} label="Loop forever" />
          <p className={styles.hint}>A shorter video is used up to its end. GIFs are limited to 30 seconds and 50 MB.</p>
        </>
      )}
    </div>
  );
}

export const gifSteps: ReadonlyArray<StepUI<never>> = [ui<GifStepOptions>("gif", parseGifStep, GifEditor)];

registerSteps(gifSteps);
