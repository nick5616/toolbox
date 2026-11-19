import { Field } from "@/components/Field";
import { TextField } from "@/components/TextField";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Switch } from "@/components/Switch";
import { bool, oneOf, str, ui } from "./phase14";
import { parseObject, registerSteps, type StepEditorProps } from "./registry";
import styles from "./phase14.module.css";

// "Keep files that show…" (search-filter), Phase 20 SPEC §3.9.
// CONTRACT STUB (Wave 0): S6 finishes the editor.

export interface SearchFilterOptions {
  query: string;
  match: "picture" | "text" | "both";
  strength: "strong" | "good" | "maybe";
  invert: boolean;
}

/** Mirrors modules/mediaindex DefaultFilterOptions(). */
export const DEFAULT_SEARCH_FILTER: SearchFilterOptions = { query: "", match: "both", strength: "good", invert: false };

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

function SearchFilterEditor({ value, onChange }: StepEditorProps<SearchFilterOptions>) {
  const set = (patch: Partial<SearchFilterOptions>) => onChange({ ...value, ...patch });
  return (
    <div className={styles.stack}>
      <Field label="Keep files that show">
        {(c) => <TextField id={c.id} value={value.query} placeholder="a receipt, a dog, a whiteboard…" onChange={(e) => set({ query: e.target.value })} />}
      </Field>
      <Field label="Match by">
        <SegmentedControl<SearchFilterOptions["match"]>
          aria-label="Match by"
          value={value.match}
          options={[
            { value: "both", label: "Picture or text" },
            { value: "picture", label: "Picture" },
            { value: "text", label: "Text" },
          ]}
          onChange={(match) => set({ match })}
        />
      </Field>
      <Switch checked={value.invert} onChange={(invert) => set({ invert })} label="Keep the ones that don't match" />
    </div>
  );
}

registerSteps([ui<SearchFilterOptions>("search-filter", parseSearchFilter, SearchFilterEditor)]);
