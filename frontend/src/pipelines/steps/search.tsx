import { Field } from "@/components/Field";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Switch } from "@/components/Switch";
import { TemplateField } from "@/components/TemplateField";
import { bool, oneOf, str, ui } from "./phase14";
import { parseObject, registerSteps, type StepEditorProps } from "./registry";
import styles from "./phase14.module.css";

// "Keep files that show…" (search-filter), Phase 20 SPEC §3.9.

export interface SearchFilterOptions {
  query: string;
  match: "picture" | "text" | "both";
  strength: "strong" | "good" | "maybe";
  invert: boolean;
}

/** Mirrors modules/mediaindex DefaultFilterOptions(). */
export const DEFAULT_SEARCH_FILTER: SearchFilterOptions = { query: "", match: "both", strength: "good", invert: false };

/** Mirrors modules/mediaindex MaxQueryChars. */
export const MAX_FILTER_QUERY = 200;

export function parseSearchFilter(json: string): SearchFilterOptions {
  const r = parseObject(json);
  const d = DEFAULT_SEARCH_FILTER;
  return {
    ...r,
    query: str(r.query, d.query),
    match: oneOf(r.match, ["picture", "text", "both"] as const, d.match),
    strength: oneOf(r.strength, ["strong", "good", "maybe"] as const, d.strength),
    invert: bool(r.invert, d.invert),
  };
}

const MATCH_WORDS = { both: "picture or text", picture: "picture", text: "text" } as const;
const STRENGTH_WORDS = { strong: "strong matches only", good: "good matches", maybe: "including maybes" } as const;

/** The one-line summary under the controls (the same wording as the step's own). */
export function searchFilterSummary(v: SearchFilterOptions): string {
  if (v.query.trim() === "") return "Describe what to keep";
  const what = v.invert ? "Keeps files not showing" : "Keeps files showing";
  return `${what} “${v.query.trim()}” · by ${MATCH_WORDS[v.match]} · ${STRENGTH_WORDS[v.strength]}`;
}

function SearchFilterEditor({ value, onChange, vars }: StepEditorProps<SearchFilterOptions>) {
  const set = (patch: Partial<SearchFilterOptions>) => onChange({ ...value, ...patch });
  const empty = value.query.trim() === "";
  const tooLong = [...value.query].length > MAX_FILTER_QUERY;
  return (
    <div className={styles.stack}>
      <div data-tip="Describe what the picture shows or what the text says. You can use {variables} from earlier steps.">
        <TemplateField
          label="Keep files that show"
          value={value.query}
          vars={vars}
          placeholder="a receipt, a dog, a whiteboard…"
          onChange={(query) => set({ query })}
          error={empty ? "Describe what to keep" : tooLong ? `Keep it under ${MAX_FILTER_QUERY} characters` : undefined}
        />
      </div>
      <Field label="Match by">
        <div data-tip="What to look at: what's in the picture, the words in or spoken in the file, or either">
          <SegmentedControl<SearchFilterOptions["match"]>
            aria-label="Match by"
            value={value.match}
            options={[
              { value: "both", label: "Picture or text", tip: "A file matches when its picture or its text does" },
              { value: "picture", label: "Picture", tip: "Only what the picture or video frames show" },
              { value: "text", label: "Text", tip: "Only words read in the file, its document text or its speech" },
            ]}
            onChange={(match) => set({ match })}
          />
        </div>
      </Field>
      <Field label="How sure">
        <div data-tip="How close a match has to be to count">
          <SegmentedControl<SearchFilterOptions["strength"]>
            aria-label="How sure"
            value={value.strength}
            options={[
              { value: "strong", label: "Strong", tip: "Only files that clearly match" },
              { value: "good", label: "Good", tip: "Clear matches and good ones" },
              { value: "maybe", label: "Include maybes", tip: "Also files that might match" },
            ]}
            onChange={(strength) => set({ strength })}
          />
        </div>
      </Field>
      <Switch
        checked={value.invert}
        onChange={(invert) => set({ invert })}
        label="Keep the ones that don't match"
        tip="Sends the files that don't match on as the kept files instead"
      />
      <p className={styles.hint}>{searchFilterSummary(value)}</p>
    </div>
  );
}

export const searchSteps = [ui<SearchFilterOptions>("search-filter", parseSearchFilter, SearchFilterEditor)];

registerSteps(searchSteps);
