/**
 * The transcription controls (Phase 11, SPEC §5.3), shared by Transcribe (its
 * file-tool layout places the pieces itself) and Subtitles (its Transcription
 * panel uses the composite `SpeechOptions`). A block: it never imports a tool.
 */
import { useRef, type KeyboardEvent } from "react";
import { Badge, SegmentedControl, Select, Switch, cx } from "@/components";
import { TranscribeTask, type Language, type PresetInfo } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { MODEL_CHOICES, languageOptions, type SpeechSettings } from "./options";
import styles from "./speech.module.css";

const SPEED_LABEL: Record<string, string> = { fast: "Fastest", balanced: "Balanced", best: "Best quality" };

export interface ModelCardsProps {
  presets: PresetInfo[];
  value: string;
  onChange: (id: string) => void;
}

/** The speech models as radio cards with their speed and first-use download. */
export function ModelCards({ presets, value, onChange }: ModelCardsProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = presets.findIndex((p) => p.id === value);
  const tabbable = selected >= 0 ? selected : 0;

  const move = (from: number, dir: 1 | -1) => {
    const i = (from + dir + presets.length) % presets.length;
    const p = presets[i];
    if (!p) return;
    onChange(p.id);
    refs.current[i]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      move(i, 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      move(i, -1);
    }
  };

  return (
    <div role="radiogroup" aria-label="Model" className={styles.cards}>
      {presets.map((p, i) => (
        <button
          key={p.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={p.id === value}
          tabIndex={i === tabbable ? 0 : -1}
          className={cx(styles.card, p.id === value && styles.selected)}
          onClick={() => onChange(p.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
          data-tip={`${p.label}: ${p.speed === "fast" ? "fastest, least accurate" : p.speed === "best" ? "most accurate, slowest" : "a good balance of speed and accuracy"}; ${formatBytes(p.downloadBytes)} model download on first use`}
        >
          <span className={styles.cardHead}>
            <span className={styles.label}>{p.label}</span>
            <Badge tone={p.speed === "best" ? "accent" : "neutral"} tip="How this model trades speed against accuracy">
              {SPEED_LABEL[p.speed] ?? p.speed}
            </Badge>
          </span>
          <span className={styles.note} data-tip="The model is downloaded once and then works offline">
            {formatBytes(p.downloadBytes)} first-use download
          </span>
          {p.id === "turbo" && (
            <span className={styles.note} data-tip="Fast on a GPU, but much slower when only a CPU is available">
              Slower on CPU
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/** A compact model picker (a drop-down with the three models). */
export function ModelSelect({ value, onChange }: { value: string; onChange: (model: string) => void }) {
  return (
    <Select
      aria-label="Model"
      data-tip="Base is quickest, Small is balanced, Turbo is the most accurate but slowest"
      value={value}
      options={MODEL_CHOICES}
      onChange={onChange}
    />
  );
}

export interface LanguageFieldProps {
  /** Input id so a `<label htmlFor>` can point at it. */
  id?: string;
  value: string;
  languages: readonly Pick<Language, "code" | "name">[];
  onChange: (code: string) => void;
  /** aria-label when there is no separate label element. */
  label?: string;
}

/** The spoken language (Auto-detect first). */
export function LanguageField({ id, value, languages, onChange, label }: LanguageFieldProps) {
  return (
    <Select
      id={id}
      aria-label={label}
      data-tip="The language spoken; auto-detect works well but a fixed choice is safer for short or noisy clips"
      value={value}
      options={languageOptions(languages)}
      onChange={onChange}
    />
  );
}

export interface TaskFieldProps {
  task: TranscribeTask;
  onChange: (task: TranscribeTask) => void;
}

/** Keep the spoken language, or write the speech out translated into English. */
export function TaskField({ task, onChange }: TaskFieldProps) {
  return (
    <SegmentedControl
      aria-label="Task"
      value={task}
      onChange={onChange}
      options={[
        { value: TranscribeTask.TaskTranscribe, label: "Transcribe", tip: "Write down what is said in the original language" },
        { value: TranscribeTask.TaskTranslate, label: "Translate to English", tip: "Write the speech out translated into English, whatever language it is in" },
      ]}
    />
  );
}

/** Cut long silent stretches before transcribing. */
export function SkipSilence({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <Switch
      checked={checked}
      onChange={onChange}
      label="Skip silence"
      tip="Cut long silent stretches before transcribing; faster and avoids made-up text in quiet parts"
    />
  );
}

export interface SpeechOptionsProps {
  value: SpeechSettings;
  languages: readonly Pick<Language, "code" | "name">[];
  onChange: (patch: Partial<SpeechSettings>) => void;
}

/** Model, spoken language and "translate to English" as one compact form (Subtitles' Transcription panel). */
export function SpeechOptions({ value, languages, onChange }: SpeechOptionsProps) {
  return (
    <div className={styles.stack}>
      <div className={styles.row}>
        <span className={styles.rowLabel}>Model</span>
        <ModelSelect value={value.model} onChange={(model) => onChange({ model })} />
      </div>
      <div className={styles.row}>
        <span className={styles.rowLabel}>Spoken language</span>
        <LanguageField label="Spoken language" value={value.language} languages={languages} onChange={(language) => onChange({ language })} />
      </div>
      <Switch
        tip="Write the subtitles in English whatever language is spoken"
        checked={value.translate}
        onChange={(translate) => onChange({ translate })}
        label="Translate to English"
      />
    </div>
  );
}
