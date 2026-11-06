import { OrganizeDupMode, OrganizeGroupBy, type OrganizeOptions } from "@/lib/api";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Select } from "@/components/Select";
import { Slider } from "@/components/Slider";
import { TextField } from "@/components/TextField";
import { FilesService } from "@/lib/api";
import {
  ACTION_OPTIONS,
  DEFAULT_ORGANIZE_OPTIONS,
  DUPLICATE_OPTIONS,
  GROUP_OPTIONS,
  MAX_SIMILARITY,
  MIN_SIMILARITY,
  PATTERN_TOKENS,
  baseName,
  patternProblem,
  sanitizeOrganizeOptions,
} from "@/tools/organize/options";
import { registerSteps, parseObject, type StepEditorProps, type StepUI } from "./registry";
import { PARAMS } from "./paramDefs";
import styles from "./docs.module.css";

// Step editor for the Organizer ("organize"). The step takes every file of the
// run together and makes one result folder.

export const DEFAULT_ORGANIZE_STEP: OrganizeOptions = DEFAULT_ORGANIZE_OPTIONS;

export function parseOrganizeStep(json: string): OrganizeOptions {
  return sanitizeOrganizeOptions(parseObject(json), DEFAULT_ORGANIZE_STEP);
}

function OrganizeEditor({ value, onChange }: StepEditorProps<OrganizeOptions>) {
  const set = (patch: Partial<OrganizeOptions>) => onChange({ ...value, ...patch });
  const isPattern = value.groupBy === OrganizeGroupBy.GroupPattern;
  const problem = isPattern ? patternProblem(value.pattern) : "";
  const choose = async () => {
    try {
      const dir = await FilesService.PickFolder("Put the organized copies in");
      if (dir) set({ destination: dir });
    } catch {
      // The dialog failed or was dismissed; keep the current folder.
    }
  };
  return (
    <div className={styles.stack}>
      <Field label="Group by">
        <SegmentedControl
          aria-label="Group by"
          value={value.groupBy}
          options={GROUP_OPTIONS.map((g) => ({ value: g.value, label: g.label, tip: g.tip }))}
          onChange={(groupBy) => set({ groupBy })}
        />
      </Field>
      {isPattern && (
        <Field label="Folder pattern" hint={`Use ${PATTERN_TOKENS.join(" ")}, separated by /.`} error={problem || undefined}>
          {(c) => (
            <TextField
              id={c.id}
              aria-describedby={c["aria-describedby"]}
              mono
              value={value.pattern}
              invalid={problem !== ""}
              onChange={(e) => set({ pattern: e.target.value })}
            />
          )}
        </Field>
      )}
      <Field label="Duplicates">
        <SegmentedControl
          aria-label="Duplicates"
          value={value.duplicates}
          options={DUPLICATE_OPTIONS.map((d) => ({ value: d.value, label: d.label, tip: d.tip }))}
          onChange={(duplicates) => set({ duplicates })}
        />
      </Field>
      {value.duplicates === OrganizeDupMode.DupSimilar && (
        <Field label="Similarity">
          {(c) => (
            <Slider
              id={c.id}
              aria-label="Similarity"
              min={MIN_SIMILARITY}
              max={MAX_SIMILARITY}
              step={1}
              value={value.similarity}
              format={(v) => `${v}%`}
              onChange={(similarity) => set({ similarity })}
            />
          )}
        </Field>
      )}
      {value.duplicates !== OrganizeDupMode.DupOff && (
        <Field label="Duplicates go">
          {(c) => <Select id={c.id} value={value.dupAction} options={ACTION_OPTIONS} onChange={(dupAction) => set({ dupAction })} />}
        </Field>
      )}
      <Field label="Put the result in" hint="A new folder is made inside it. Default: Organized in your library.">
        {() => (
          <div className={styles.row}>
            <span data-tip={value.destination || "Your library's Organized folder"}>{value.destination ? baseName(value.destination) : "Library · Organized"}</span>
            <Button size="sm" variant="secondary" onClick={() => void choose()}>
              Choose…
            </Button>
            {value.destination !== "" && (
              <Button size="sm" variant="ghost" onClick={() => set({ destination: "" })}>
                Clear
              </Button>
            )}
          </div>
        )}
      </Field>
    </div>
  );
}

const ui = <T,>(type: string, parse: (json: string) => T, Editor: StepUI<T>["Editor"]): StepUI<never> =>
  ({ type, parse, Editor, params: PARAMS[type] }) as unknown as StepUI<never>;

export const organizeSteps: ReadonlyArray<StepUI<never>> = [ui("organize", parseOrganizeStep, OrganizeEditor)];

registerSteps(organizeSteps);
