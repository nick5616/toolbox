import { Field } from "@/components/Field";
import { SegmentedControl } from "@/components/SegmentedControl";
import { TextArea } from "@/components/TextArea";
import { CaptionPreset, CaptionThen, type CaptionOptions } from "@/lib/api";
import { oneOf, str, ui } from "./phase14";
import { parseObject, registerSteps, type StepEditorProps } from "./registry";
import styles from "./phase14.module.css";

// Caption Writer's step ("captions"), Phase 20 SPEC §5.5.
// CONTRACT STUB (Wave 0): C3 finishes the editor (tone, length, language,
// hashtags, names, write options) and keeps DEFAULT_CAPTION_STEP in step with
// modules/captions DefaultOptions().

/** Mirrors modules/captions DefaultOptions(). */
export const DEFAULT_CAPTION_STEP: CaptionOptions = {
  action: "caption" as CaptionOptions["action"],
  preset: CaptionPreset.PresetPosting,
  context: "",
  notes: {},
  tone: "warm" as CaptionOptions["tone"],
  length: "medium" as CaptionOptions["length"],
  language: "",
  emoji: false,
  hashtags: 5,
  namePattern: "name" as CaptionOptions["namePattern"],
  kebab: false,
  useHints: true,
  readText: true,
  model: "",
  batch: "",
  index: -1,
  keepEdited: true,
  seed: 0,
  write: { alt: true, description: true, caption: true, captionFrom: "caption" as CaptionOptions["write"]["captionFrom"], title: true, keywords: true, keepLocation: false },
  then: CaptionThen.ThenNothing,
};

const PRESETS = [CaptionPreset.PresetPosting, CaptionPreset.PresetAccessible, CaptionPreset.PresetCatalogue, CaptionPreset.PresetRename, CaptionPreset.PresetEverything] as const;
const THENS = [CaptionThen.ThenNothing, CaptionThen.ThenWriteCopies, CaptionThen.ThenRenameCopies] as const;

export function parseCaptionStep(json: string): CaptionOptions {
  const r = parseObject(json);
  const d = DEFAULT_CAPTION_STEP;
  return {
    ...d,
    ...r,
    preset: oneOf(r.preset, PRESETS, d.preset),
    context: str(r.context, d.context),
    then: oneOf(r.then, THENS, d.then),
  } as CaptionOptions;
}

function CaptionStepEditor({ value, onChange }: StepEditorProps<CaptionOptions>) {
  const set = (patch: Partial<CaptionOptions>) => onChange({ ...value, ...patch });
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
          ]}
          onChange={(preset) => set({ preset })}
        />
      </Field>
      <Field label="Context">
        {(c) => <TextArea id={c.id} value={value.context} placeholder="Lisbon trip, May 2026. The dog is Max." onChange={(e) => set({ context: e.target.value })} />}
      </Field>
    </div>
  );
}

registerSteps([ui<CaptionOptions>("captions", parseCaptionStep, CaptionStepEditor)]);
