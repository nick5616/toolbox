import { useEffect, useMemo, useState } from "react";
import { Field } from "@/components/Field";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Select } from "@/components/Select";
import { Slider } from "@/components/Slider";
import { TtsFormat, TtsService, TtsSplit, type TtsStepOptions, type TtsVoiceInfo } from "@/lib/api";
import { MAX_SPEED, MIN_SPEED, formatSpeed, orderVoices, voiceLabel } from "@/tools/tts/options";
import { parseObject, type StepEditorProps, type StepUI } from "./registry";
import { PARAMS } from "./paramDefs";
import styles from "./tts.module.css";

// The Text to Speech step editor. Registered by the architect:
// `registerSteps(ttsSteps)` in pipelines/steps/index.ts (or a group file).

/** Mirrors modules/tts DefaultStepOptions(). */
export const DEFAULT_TTS_STEP: TtsStepOptions = {
  voice: "af_heart",
  speed: 1,
  split: TtsSplit.SplitNone,
  format: TtsFormat.FormatMP3,
};

const SPLITS: readonly string[] = Object.values(TtsSplit).filter((v) => v !== "");
const FORMATS: readonly string[] = Object.values(TtsFormat).filter((v) => v !== "");

/** Parses OptionsJSON over the defaults; keeps unknown fields and never throws. */
export function parseTtsStep(json: string): TtsStepOptions {
  const r = parseObject(json);
  const d = DEFAULT_TTS_STEP;
  const speed = typeof r.speed === "number" && Number.isFinite(r.speed) && r.speed >= MIN_SPEED && r.speed <= MAX_SPEED ? r.speed : d.speed;
  return {
    ...r,
    voice: typeof r.voice === "string" && /^[a-z]{2}_[a-z]+$/.test(r.voice) ? r.voice : d.voice,
    speed,
    split: (SPLITS.includes(r.split as string) ? r.split : d.split) as TtsStepOptions["split"],
    format: (FORMATS.includes(r.format as string) ? r.format : d.format) as TtsStepOptions["format"],
  };
}

function TtsEditor({ value, onChange }: StepEditorProps<TtsStepOptions>) {
  const [voices, setVoices] = useState<TtsVoiceInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    TtsService.Voices()
      .then((v) => !cancelled && setVoices(orderVoices(v ?? [])))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const options = useMemo(() => {
    const list = voices.map((v) => ({ value: v.id, label: voiceLabel(v) }));
    return list.some((o) => o.value === value.voice) || voices.length === 0 ? list : [{ value: value.voice, label: value.voice }, ...list];
  }, [voices, value.voice]);
  const set = (patch: Partial<TtsStepOptions>) => onChange({ ...value, ...patch });

  return (
    <div className={styles.stack}>
      <Field label="Voice">
        {(c) => <Select id={c.id} value={value.voice} options={options} onChange={(voice) => set({ voice })} />}
      </Field>
      <Field label="Speed">
        {(c) => (
          <Slider id={c.id} value={value.speed} min={MIN_SPEED} max={MAX_SPEED} step={0.05} format={formatSpeed} onChange={(speed) => set({ speed })} />
        )}
      </Field>
      <Field label="Split">
        <SegmentedControl
          aria-label="Split"
          value={value.split}
          options={[
            { value: TtsSplit.SplitNone, label: "One file" },
            { value: TtsSplit.SplitHeadings, label: "By heading" },
          ]}
          onChange={(split) => set({ split })}
        />
      </Field>
      <Field label="Format">
        {(c) => (
          <Select
            id={c.id}
            size="sm"
            value={value.format}
            options={[
              { value: TtsFormat.FormatMP3, label: "MP3" },
              { value: TtsFormat.FormatM4A, label: "M4A (AAC)" },
              { value: TtsFormat.FormatWAV, label: "WAV" },
            ]}
            onChange={(format) => set({ format })}
          />
        )}
      </Field>
      {value.split === TtsSplit.SplitHeadings && (
        <p className={styles.hint}>One audio file per top-level Markdown heading. Files made this way are the step&apos;s &quot;Chapter&quot; results.</p>
      )}
    </div>
  );
}

const ui = <T,>(type: string, parse: (json: string) => T, Editor: StepUI<T>["Editor"]): StepUI<never> =>
  ({ type, parse, Editor, params: PARAMS[type] }) as unknown as StepUI<never>;

/** The step editors of the Text to Speech tool (StepType.ID "tts"). */
export const ttsSteps: ReadonlyArray<StepUI<never>> = [ui("tts", parseTtsStep, TtsEditor)];
