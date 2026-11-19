import { Field } from "@/components/Field";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Select } from "@/components/Select";
import { Stepper } from "@/components/Stepper";
import { Switch } from "@/components/Switch";
import { TemplateField } from "@/components/TemplateField";
import { CaptionField, CaptionLength, CaptionNamePattern, CaptionPreset, CaptionThen, CaptionTone, type CaptionOptions } from "@/lib/api";
import { bool, num, oneOf, str, ui } from "./phase14";
import { parseObject, registerSteps, type StepEditorProps } from "./registry";
import styles from "./phase14.module.css";

// Caption Writer's step ("captions"), Phase 20 SPEC §5.5.

/** Mirrors modules/captions DefaultOptions(). */
export const DEFAULT_CAPTION_STEP: CaptionOptions = {
  action: "caption" as CaptionOptions["action"],
  preset: CaptionPreset.PresetPosting,
  context: "",
  notes: {},
  tone: CaptionTone.ToneWarm,
  length: CaptionLength.LengthMedium,
  language: "",
  emoji: false,
  hashtags: 5,
  namePattern: CaptionNamePattern.NameOnly,
  kebab: false,
  useHints: true,
  readText: true,
  model: "",
  batch: "",
  index: -1,
  keepEdited: true,
  seed: 0,
  write: { alt: true, description: true, caption: true, captionFrom: CaptionField.FieldCaption, title: true, keywords: true, keepLocation: false },
  then: CaptionThen.ThenNothing,
};

const PRESETS = [CaptionPreset.PresetPosting, CaptionPreset.PresetAccessible, CaptionPreset.PresetCatalogue, CaptionPreset.PresetRename, CaptionPreset.PresetEverything] as const;
const TONES = [CaptionTone.TonePlain, CaptionTone.ToneWarm, CaptionTone.TonePlayful, CaptionTone.ToneProfessional, CaptionTone.TonePoetic] as const;
const LENGTHS = [CaptionLength.LengthShort, CaptionLength.LengthMedium, CaptionLength.LengthLong] as const;
const PATTERNS = [CaptionNamePattern.NameOnly, CaptionNamePattern.NameDate, CaptionNamePattern.NameNumber] as const;
const THENS = [CaptionThen.ThenNothing, CaptionThen.ThenWriteCopies, CaptionThen.ThenRenameCopies] as const;
const CAPTION_FROM = [CaptionField.FieldCaption, CaptionField.FieldDescription] as const;

/** Languages the tool offers ("" = Auto). */
export const CAPTION_LANGUAGES = [
  "Arabic", "Bengali", "Bulgarian", "Chinese", "Croatian", "Czech", "Danish", "Dutch", "English", "Finnish",
  "French", "German", "Greek", "Hebrew", "Hindi", "Hungarian", "Indonesian", "Italian", "Japanese", "Korean",
  "Norwegian", "Persian", "Polish", "Portuguese", "Romanian", "Russian", "Spanish", "Swedish", "Thai", "Turkish", "Ukrainian", "Vietnamese",
] as const;

export function parseCaptionStep(json: string): CaptionOptions {
  const r = parseObject(json);
  const d = DEFAULT_CAPTION_STEP;
  const w = typeof r.write === "object" && r.write !== null && !Array.isArray(r.write) ? (r.write as Record<string, unknown>) : {};
  const language = str(r.language, d.language);
  return {
    ...d,
    ...r,
    preset: oneOf(r.preset, PRESETS, d.preset),
    context: str(r.context, d.context),
    tone: oneOf(r.tone, TONES, d.tone),
    length: oneOf(r.length, LENGTHS, d.length),
    language: (CAPTION_LANGUAGES as readonly string[]).includes(language) ? language : "",
    emoji: bool(r.emoji, d.emoji),
    hashtags: Math.min(15, Math.max(0, Math.round(num(r.hashtags, d.hashtags)))),
    namePattern: oneOf(r.namePattern, PATTERNS, d.namePattern),
    kebab: bool(r.kebab, d.kebab),
    useHints: bool(r.useHints, d.useHints),
    readText: bool(r.readText, d.readText),
    then: oneOf(r.then, THENS, d.then),
    write: {
      alt: bool(w.alt, d.write.alt),
      description: bool(w.description, d.write.description),
      caption: bool(w.caption, d.write.caption),
      captionFrom: oneOf(w.captionFrom, CAPTION_FROM, d.write.captionFrom),
      title: bool(w.title, d.write.title),
      keywords: bool(w.keywords, d.write.keywords),
      keepLocation: bool(w.keepLocation, d.write.keepLocation),
    },
  } as CaptionOptions;
}

function CaptionStepEditor({ value, onChange, vars }: StepEditorProps<CaptionOptions>) {
  const set = (patch: Partial<CaptionOptions>) => onChange({ ...value, ...patch });
  const setWrite = (patch: Partial<CaptionOptions["write"]>) => onChange({ ...value, write: { ...value.write, ...patch } });
  return (
    <div className={styles.stack}>
      <Field label="Write">
        <SegmentedControl<CaptionPreset>
          aria-label="Write"
          value={value.preset}
          options={[
            { value: CaptionPreset.PresetPosting, label: "For posting" },
            { value: CaptionPreset.PresetAccessible, label: "Accessible" },
            { value: CaptionPreset.PresetCatalogue, label: "Catalogue" },
            { value: CaptionPreset.PresetRename, label: "Rename" },
            { value: CaptionPreset.PresetEverything, label: "Everything" },
          ]}
          onChange={(preset) => set({ preset })}
        />
      </Field>
      <TemplateField label="Context" multiline minRows={2} value={value.context} vars={vars} placeholder="Lisbon trip, May 2026. The dog is Max." onChange={(context) => set({ context })} />
      <Field label="Tone">
        <SegmentedControl<CaptionTone>
          aria-label="Tone"
          size="sm"
          value={value.tone}
          options={[
            { value: CaptionTone.TonePlain, label: "Plain" },
            { value: CaptionTone.ToneWarm, label: "Warm" },
            { value: CaptionTone.TonePlayful, label: "Playful" },
            { value: CaptionTone.ToneProfessional, label: "Professional" },
            { value: CaptionTone.TonePoetic, label: "Poetic" },
          ]}
          onChange={(tone) => set({ tone })}
        />
      </Field>
      <Field label="Length">
        <SegmentedControl<CaptionLength>
          aria-label="Length"
          size="sm"
          value={value.length}
          options={[
            { value: CaptionLength.LengthShort, label: "Short" },
            { value: CaptionLength.LengthMedium, label: "Medium" },
            { value: CaptionLength.LengthLong, label: "Long" },
          ]}
          onChange={(length) => set({ length })}
        />
      </Field>
      <Field label="Language">
        {(c) => (
          <Select
            {...c}
            value={value.language}
            options={[{ value: "", label: "Auto (the app's language)" }, ...CAPTION_LANGUAGES.map((l) => ({ value: l as string, label: l as string }))]}
            onChange={(language) => set({ language })}
          />
        )}
      </Field>
      <Field label="Hashtags">
        <Stepper aria-label="Hashtags" min={0} max={15} value={value.hashtags} onChange={(hashtags) => set({ hashtags })} />
      </Field>
      <Field label="File names">
        {(c) => (
          <Select
            {...c}
            value={value.namePattern}
            options={[
              { value: CaptionNamePattern.NameOnly, label: "Name" },
              { value: CaptionNamePattern.NameDate, label: "Date + name" },
              { value: CaptionNamePattern.NameNumber, label: "Number + name" },
            ]}
            onChange={(namePattern) => set({ namePattern })}
          />
        )}
      </Field>
      <Field label="Then">
        {(c) => (
          <Select
            {...c}
            value={value.then}
            options={[
              { value: CaptionThen.ThenNothing, label: "Just the table" },
              { value: CaptionThen.ThenWriteCopies, label: "Write into copies" },
              { value: CaptionThen.ThenRenameCopies, label: "Rename copies" },
            ]}
            onChange={(then) => set({ then })}
          />
        )}
      </Field>
      {value.then === CaptionThen.ThenWriteCopies && (
        <>
          <Switch checked={value.write.alt} onChange={(alt) => setWrite({ alt })} label="Write alt text" />
          <Switch checked={value.write.description} onChange={(description) => setWrite({ description })} label="Write description" />
          <Switch checked={value.write.caption} onChange={(caption) => setWrite({ caption })} label="Write caption" />
          {value.write.caption && (
            <Field label="Caption from">
              <SegmentedControl<CaptionField>
                aria-label="Caption from"
                size="sm"
                value={value.write.captionFrom}
                options={[
                  { value: CaptionField.FieldCaption, label: "Caption" },
                  { value: CaptionField.FieldDescription, label: "Description" },
                ]}
                onChange={(captionFrom) => setWrite({ captionFrom })}
              />
            </Field>
          )}
          <Switch checked={value.write.title} onChange={(title) => setWrite({ title })} label="Write title" />
          <Switch checked={value.write.keywords} onChange={(keywords) => setWrite({ keywords })} label="Write keywords" />
          <Switch checked={value.write.keepLocation} onChange={(keepLocation) => setWrite({ keepLocation })} label="Keep location data" />
        </>
      )}
    </div>
  );
}

registerSteps([ui<CaptionOptions>("captions", parseCaptionStep, CaptionStepEditor)]);
