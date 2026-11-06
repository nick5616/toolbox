import { useMemo } from "react";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { IconButton } from "@/components/IconButton";
import { PathText } from "@/components/PathText";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Select } from "@/components/Select";
import { Slider } from "@/components/Slider";
import { Switch } from "@/components/Switch";
import { TemplateField } from "@/components/TemplateField";
import { TextField } from "@/components/TextField";
import {
  FilesService,
  type PipelineChatField,
  type PipelineChatStep,
  type PipelineCopyStep,
  type PipelineRenameStep,
  type PipelineTableColumn,
  type PipelineTableStep,
  type PipelineZipStep,
} from "@/lib/api";
import { BUILTIN_VARS } from "../vars";
import { parseObject, registerSteps, type StepEditorProps, type StepUI } from "./registry";
import { PARAMS } from "./paramDefs";
import styles from "./builtin.module.css";

// Step editors of the built-in steps (SPEC.md §7, §11.4): rename, chat,
// table, zip, copy and check.

export const MAX_PROMPT = 8000;
export const MAX_SYSTEM = 4000;
export const MAX_FIELDS = 12;
export const MAX_COLUMNS = 30;

const str = (v: unknown, d: string): string => (typeof v === "string" ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
const num = (v: unknown, d: number, lo: number, hi: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : d;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// ---- defaults (mirror Default* in modules/pipelines/options.go) -----------------

export const DEFAULT_RENAME: PipelineRenameStep = { template: "{name}" };
export const DEFAULT_CHAT: PipelineChatStep = {
  mode: "write",
  system: "",
  prompt: "",
  fields: [],
  outputName: "{item} (notes)",
  format: "md",
  saveJson: false,
  temperature: 0.3,
};
const DEFAULT_COLUMNS: PipelineTableColumn[] = [{ header: "File", value: "{item}" }];
export const DEFAULT_TABLE: PipelineTableStep = { name: "{pipeline} {date}", columns: DEFAULT_COLUMNS };
export const DEFAULT_ZIP: PipelineZipStep = { together: true, name: "{pipeline} {date}" };
export const DEFAULT_COPY: PipelineCopyStep = { folder: "", subfolder: "" };

const FIELD_TYPES = ["text", "number", "date"] as const;
const CHAT_MODES = ["write", "extract"] as const;
const FORMATS = ["md", "txt"] as const;
const ZIP_EACH_NAME = "{item}";

// ---- parse ----------------------------------------------------------------------

export function parseRename(json: string): PipelineRenameStep {
  const o = parseObject(json);
  return { template: str(o.template, DEFAULT_RENAME.template) };
}

export function parseChat(json: string): PipelineChatStep {
  const o = parseObject(json);
  const fields: PipelineChatField[] = list(o.fields)
    .slice(0, MAX_FIELDS)
    .map((f) => {
      const r = obj(f);
      return { name: str(r.name, ""), label: str(r.label, ""), type: oneOf(r.type, FIELD_TYPES, "text") };
    });
  return {
    mode: oneOf(o.mode, CHAT_MODES, "write"),
    system: str(o.system, ""),
    prompt: str(o.prompt, ""),
    fields,
    outputName: str(o.outputName, DEFAULT_CHAT.outputName),
    format: oneOf(o.format, FORMATS, "md"),
    saveJson: bool(o.saveJson, false),
    temperature: Math.round(num(o.temperature, DEFAULT_CHAT.temperature, 0, 1.5) * 100) / 100,
  };
}

export function parseTable(json: string): PipelineTableStep {
  const o = parseObject(json);
  const columns: PipelineTableColumn[] = list(o.columns)
    .slice(0, MAX_COLUMNS)
    .map((c) => {
      const r = obj(c);
      return { header: str(r.header, ""), value: str(r.value, "") };
    });
  return {
    name: str(o.name, DEFAULT_TABLE.name),
    columns: columns.length > 0 ? columns : DEFAULT_COLUMNS.map((c) => ({ ...c })),
  };
}

export function parseZip(json: string): PipelineZipStep {
  const o = parseObject(json);
  const together = bool(o.together, DEFAULT_ZIP.together);
  return { together, name: str(o.name, together ? DEFAULT_ZIP.name : ZIP_EACH_NAME) };
}

export function parseCopy(json: string): PipelineCopyStep {
  const o = parseObject(json);
  return { folder: str(o.folder, ""), subfolder: str(o.subfolder, "") };
}

// ---- rename ---------------------------------------------------------------------

function RenameEditor({ value, onChange, vars }: StepEditorProps<PipelineRenameStep>) {
  return (
    <div className={styles.root}>
      <TemplateField
        label="New name"
        value={value.template}
        vars={vars}
        placeholder="{name}"
        onChange={(template) => onChange({ ...value, template })}
        error={value.template.trim() === "" ? "Type the new name" : undefined}
      />
      <p className={styles.hint}>
        The extension stays. Files an earlier step made are renamed where they are; your own files are copied into the Pipelines folder with the new name.
      </p>
    </div>
  );
}

// ---- chat -----------------------------------------------------------------------

const PROMPT_VARS = [{ name: "file", label: "Text of the input files" }];

function ChatEditor({ value, onChange, vars }: StepEditorProps<PipelineChatStep>) {
  const extract = value.mode === "extract";
  const fields = value.fields ?? [];
  const promptVars = useMemo(() => [...PROMPT_VARS, ...vars], [vars]);
  const set = (patch: Partial<PipelineChatStep>) => onChange({ ...value, ...patch });
  const setField = (i: number, patch: Partial<PipelineChatField>) =>
    set({ fields: fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });

  return (
    <div className={styles.root}>
      <SegmentedControl
        aria-label="What the chat model does"
        value={value.mode === "extract" ? "extract" : "write"}
        onChange={(mode) => set({ mode })}
        options={[
          { value: "write", label: "Write text" },
          { value: "extract", label: "Pull out fields" },
        ]}
      />
      <TemplateField
        label="Instructions (optional)"
        value={value.system}
        vars={promptVars}
        multiline
        minRows={2}
        placeholder="e.g. You are a careful assistant. Answer in English."
        onChange={(system) => set({ system })}
        error={value.system.length > MAX_SYSTEM ? `At most ${MAX_SYSTEM} characters` : undefined}
      />
      <TemplateField
        label="Prompt"
        value={value.prompt}
        vars={promptVars}
        multiline
        minRows={5}
        placeholder="e.g. Summarise this transcript:{file}"
        onChange={(prompt) => set({ prompt })}
        error={
          value.prompt.trim() === ""
            ? "Write a prompt"
            : value.prompt.length > MAX_PROMPT
              ? `At most ${MAX_PROMPT} characters (${value.prompt.length})`
              : undefined
        }
      />
      <p className={styles.hint}>
        <code>{"{file}"}</code> is the text of the step&apos;s input files. Long text is read in parts automatically.
      </p>

      {extract ? (
        <>
          <div className={styles.group} role="group" aria-label="Fields">
            <span className={styles.groupLabel}>Fields to pull out</span>
            {fields.map((f, i) => (
              <div key={i} className={styles.fieldRow}>
                <TextField
                  mono
                  size="sm"
                  aria-label={`Field ${i + 1} name`}
                  placeholder="name"
                  value={f.name}
                  invalid={f.name !== "" && !/^[a-z][a-z0-9_]{0,31}$/.test(f.name)}
                  onChange={(e) => setField(i, { name: e.target.value })}
                />
                <TextField
                  size="sm"
                  aria-label={`Field ${i + 1} label`}
                  placeholder="Label, e.g. Merchant"
                  value={f.label}
                  onChange={(e) => setField(i, { label: e.target.value })}
                />
                <Select
                  size="sm"
                  aria-label={`Field ${i + 1} type`}
                  value={oneOf(f.type, FIELD_TYPES, "text")}
                  onChange={(type) => setField(i, { type })}
                  options={[
                    { value: "text", label: "Text" },
                    { value: "number", label: "Number" },
                    { value: "date", label: "Date" },
                  ]}
                />
                <IconButton
                  size="sm"
                  icon="trash-2"
                  label={`Remove field ${i + 1}`}
                  onClick={() => set({ fields: fields.filter((_, j) => j !== i) })}
                />
              </div>
            ))}
            <div>
              <Button
                size="sm"
                icon="plus"
                disabled={fields.length >= MAX_FIELDS}
                onClick={() => set({ fields: [...fields, { name: "", label: "", type: "text" }] })}
              >
                Add field
              </Button>
            </div>
            <p className={styles.hint}>Each field becomes a variable (for example {"{merchant}"}) that later steps can use.</p>
          </div>
          <Switch
            checked={value.saveJson}
            onChange={(saveJson) => set({ saveJson })}
            label="Also save the answer as a JSON file"
          />
        </>
      ) : (
        <div className={styles.row}>
          <TemplateField
            label="File name"
            value={value.outputName}
            vars={vars}
            placeholder="{item} (notes)"
            onChange={(outputName) => set({ outputName })}
            error={value.outputName.trim() === "" ? "Type a name" : undefined}
          />
          <Field label="Save as">
            {(c) => (
              <Select
                {...c}
                value={oneOf(value.format, FORMATS, "md")}
                onChange={(format) => set({ format })}
                options={[
                  { value: "md", label: "Markdown (.md)" },
                  { value: "txt", label: "Plain text (.txt)" },
                ]}
              />
            )}
          </Field>
        </div>
      )}

      <Field label="Creativity" hint="Low is steadier; high is more varied.">
        {(c) => (
          <Slider
            id={c.id}
            aria-label="Creativity"
            min={0}
            max={1.5}
            step={0.1}
            value={value.temperature}
            format={(v) => v.toFixed(1)}
            onChange={(temperature) => set({ temperature: Math.round(temperature * 100) / 100 })}
          />
        )}
      </Field>
    </div>
  );
}

// ---- table ----------------------------------------------------------------------

const BUILTIN_NAMES = new Set(BUILTIN_VARS.map((v) => v.name));

function TableEditor({ value, onChange, vars }: StepEditorProps<PipelineTableStep>) {
  const cols = value.columns ?? [];
  const nameVars = useMemo(() => vars.filter((v) => BUILTIN_NAMES.has(v.name)), [vars]);
  const set = (columns: PipelineTableColumn[]) => onChange({ ...value, columns });
  const setCol = (i: number, patch: Partial<PipelineTableColumn>) => set(cols.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const move = (i: number, by: -1 | 1) => {
    const j = i + by;
    const a = cols[i];
    const b = cols[j];
    if (!a || !b) return;
    set(cols.map((c, k) => (k === i ? b : k === j ? a : c)));
  };

  return (
    <div className={styles.root}>
      <TemplateField
        label="File name"
        value={value.name}
        vars={nameVars}
        placeholder="{pipeline} {date}"
        onChange={(name) => onChange({ ...value, name })}
        error={value.name.trim() === "" ? "Type a name" : undefined}
      />
      <div className={styles.group} role="group" aria-label="Columns">
        <span className={styles.groupLabel}>Columns (one row per file)</span>
        {cols.map((c, i) => (
          <div key={i} className={styles.colRow}>
            <TextField
              size="sm"
              aria-label={`Column ${i + 1} heading`}
              placeholder="Heading"
              value={c.header}
              invalid={c.header.trim() === ""}
              onChange={(e) => setCol(i, { header: e.target.value })}
            />
            <TemplateField label={`Column ${i + 1} value`} value={c.value} vars={vars} placeholder="{item}" onChange={(v) => setCol(i, { value: v })} />
            <div className={styles.colButtons}>
              <IconButton size="sm" icon="chevron-up" label={`Move column ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)} />
              <IconButton size="sm" icon="chevron-down" label={`Move column ${i + 1} down`} disabled={i === cols.length - 1} onClick={() => move(i, 1)} />
              <IconButton
                size="sm"
                icon="trash-2"
                label={`Remove column ${i + 1}`}
                disabled={cols.length <= 1}
                onClick={() => set(cols.filter((_, j) => j !== i))}
              />
            </div>
          </div>
        ))}
        <div>
          <Button size="sm" icon="plus" disabled={cols.length >= MAX_COLUMNS} onClick={() => set([...cols, { header: "", value: "" }])}>
            Add column
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---- zip ------------------------------------------------------------------------

function ZipEditor({ value, onChange, vars }: StepEditorProps<PipelineZipStep>) {
  const toggle = (together: boolean) => {
    // Swap the name only while it is still the other mode's default.
    const was = value.together ? DEFAULT_ZIP.name : ZIP_EACH_NAME;
    const next = together ? DEFAULT_ZIP.name : ZIP_EACH_NAME;
    onChange({ together, name: value.name === was ? next : value.name });
  };
  return (
    <div className={styles.root}>
      <Switch checked={value.together} onChange={toggle} label="One zip for the whole run" />
      <p className={styles.hint}>{value.together ? "Every item's files go into a single zip." : "Each item gets its own zip."}</p>
      <TemplateField
        label="Zip name"
        value={value.name}
        vars={vars}
        placeholder={value.together ? "{pipeline} {date}" : "{item}"}
        onChange={(name) => onChange({ ...value, name })}
        error={value.name.trim() === "" ? "Type a name" : undefined}
      />
    </div>
  );
}

// ---- copy -----------------------------------------------------------------------

function CopyEditor({ value, onChange, vars }: StepEditorProps<PipelineCopyStep>) {
  const choose = async () => {
    try {
      const folder = await FilesService.PickFolder("Copy to folder");
      if (folder) onChange({ ...value, folder });
    } catch {
      // The dialog failed or was dismissed; keep the current folder.
    }
  };
  return (
    <div className={styles.root}>
      <div className={styles.group} role="group" aria-label="Folder">
        <span className={styles.groupLabel}>Folder</span>
        <div className={styles.folder}>
          {value.folder ? <PathText path={value.folder} /> : <span className={styles.none}>No folder chosen</span>}
          <Button size="sm" icon="folder-open" onClick={() => void choose()}>
            Choose…
          </Button>
        </div>
      </div>
      <TemplateField
        label="Subfolder (optional)"
        value={value.subfolder}
        vars={vars}
        placeholder="{pipeline}/{date}"
        onChange={(subfolder) => onChange({ ...value, subfolder })}
      />
      <p className={styles.hint}>
        Files are copied, never overwritten: a name already there gets a number. Pick a folder outside your Library.
      </p>
    </div>
  );
}

// ---- check ----------------------------------------------------------------------

function CheckEditor() {
  return (
    <div className={styles.root}>
      <p className={styles.hint}>
        The run pauses here with the files in front of you. Keep the ones you want to carry on (or none, to stop that item), then continue. Write what to look
        for in the note above; it is shown on the card.
      </p>
    </div>
  );
}

const rename: StepUI<PipelineRenameStep> = { type: "pipelines.rename", parse: parseRename, Editor: RenameEditor };
const chat: StepUI<PipelineChatStep> = { type: "pipelines.chat", parse: parseChat, Editor: ChatEditor };
const table: StepUI<PipelineTableStep> = { type: "pipelines.table", parse: parseTable, Editor: TableEditor };
const zip: StepUI<PipelineZipStep> = { type: "pipelines.zip", parse: parseZip, Editor: ZipEditor };
const copy: StepUI<PipelineCopyStep> = { type: "pipelines.copy", parse: parseCopy, Editor: CopyEditor };
const check: StepUI<Record<string, never>> = { type: "pipelines.check", parse: () => ({}), Editor: CheckEditor };

// Step editors owned by WP-BI1 (pipelines.rename, .chat, .table, .zip, .copy, .check).
// The registry is typed StepUI<never>; each editor is typed to its own options.
const erase = <T,>(ui: StepUI<T>): StepUI<never> => ({ ...ui, params: PARAMS[ui.type] }) as unknown as StepUI<never>;
// Local Chat's step is the tool's own (llm-chat); "pipelines.chat" is its saved-pipeline alias.
registerSteps([erase(rename), erase(chat), erase({ ...chat, type: "llm-chat" }), erase(table), erase(zip), erase(copy), erase(check)]);
