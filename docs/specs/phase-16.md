# Toolbox — Phase 16 Spec: Parameters as inputs, and a colour system for values

Status: **BUILT 2026-11-04, uncommitted for review.** The user asked for it directly (no review stop):

> "expand on the parameters that each tool in the pipeline editor can take as inputs, like, there's a lot more. and we can have them show as inputs on the left of different colors. oh and add a color system. orange can be input"

Phase 13 (Local File Transfer) is still a draft in `SPEC.md`, waiting for approval; this phase doesn't depend on it.

Every Phase 14/15 rule still holds:
- every tool is an automatic pipeline step with a `StepUI`;
- every file row is draggable and has Send to;
- the polish rules apply.

## 1. What changes for the user
- **Every node shows its parameters as inputs on the left.**
  - Today a node has one input port (its files) and file outputs on the right. After this phase, every step's scalar options (speed, voice, BPM, title, format, size, threshold, colour, …) are parameter rows on the left edge. Each row has a coloured port, a label and its current value.
  - The **files input** stays the first port on the left, and it's **orange**.
  - Up to 4 *primary* parameters show by default. A "+ 9 more" row expands the node to show all of them, and a "Fewer" row collapses it again. The expanded state is saved per node in the layout.
  - Wired parameters always show.
- **Value outputs on the right.** Below a node's file outputs come its **variables** (BPM & Key's BPM and Key, Transcribe's transcript, Text to Speech's spoken file, …), each with a coloured port.
  - The Input node shows the built-ins (file name, item number, date, …) and the pipeline's **run parameters**.
- **Wiring a value into a parameter.** Drag from a value output to a parameter port (or the other way) and the parameter takes that value for every item.
  - Examples: BPM & Key's BPM → Visualizer speed; Transcribe's transcript → Text to Speech text; the input's file name → Video Editor title.
  - When the value is empty, the step keeps its own setting. The step panel says so: "If the wire is empty, uses 120".
  - An illegal wire is refused with a tooltip saying why ("A number can't take text").
- **Ask when the run starts.** Any parameter port's menu (right-click, or the port's ⋯ on hover) offers **Ask when the run starts**. That creates a run parameter on the Input node, with the parameter's label, type, current value as the default and its choices, and wires it.
  - Starting a run then asks for these values in the start sheet, next to the secrets.
  - Runs started by a watch folder or the clipboard use the defaults.
  - Run parameters are edited, renamed and removed in a "Run parameters" click-in on the Input node's panel.
- **The colour system.** One colour per value type, used on ports, wires, the legend, the step panel's field dots and the start sheet:

| Type | Token | Dark | Light | Means |
|---|---|---|---|---|
| Files (input) | `--type-files` | #ff8c42 orange | #c2410c | a step's file stream: what it takes in and the files it makes |
| File path | `--type-file` | #ffb37a light orange | #c2620c | one file as a value (Text to Speech's spoken file → Visualizer music) |
| Text | `--type-text` | #63e6be mint | #0f766e | |
| Number | `--type-number` | #4cc9f0 sky | #0369a1 | |
| On / off | `--type-toggle` | #b388eb violet | #7c3aed | |
| Choice | `--type-choice` | #8c9bff periwinkle | #3b5bdb | one of a fixed set |
| Colour | `--type-color` | #ff6bd6 pink | #c026d3 | |
| Mixed / unknown | `--type-any` | #a1a2aa | #55575f | |

  - **File wires are always orange.** The media kind (audio, video, …) no longer colours them; it's shown in the port's label and tooltip. The old `k_*` classes that borrowed the Edit Studio lane colours go away.
  - The tokens are in `styles/tokens.css`. `pipelines/params.ts` has `valueTypeVar(t)` and the labels.
  - A small **legend** (bottom left of the graph canvas, floating, collapsible to one "Colours" chip, remembered in localStorage) lists the types.
- **The Runs graph** shows the files port and the wired parameters only, read-only, with no expanders and no menus.

## 2. Data model (Go; already in `core/pipeline_types.go`)

```go
type PipelineStep struct { …; Binds []StepBind `json:"binds"` }   // ≤ 50, one per option
type StepBind struct { Option string `json:"option"`; Var string `json:"var"` } // JSON pointer, variable name
type Pipeline struct { …; Params []PipelineParam `json:"params"` } // ≤ 20
type PipelineParam struct { Name, Label string; Type ValueType; Default string; Choices []string }
type StepVar struct { Name, Label string; Type ValueType `json:"type,omitempty"` } // "" = text
type RunRequest struct { …; Params map[string]string `json:"params"` }
type ValueType string // "text" | "number" | "toggle" | "choice" | "color" | "file"
```

### 2.1 The runner (`core/pipeline`)
- **Applying binds.** `buildRequest` applies a step's binds to a copy of its options before `PrepareStep`. For each bind:
  1. Take the variable's value for the item. Look it up in this order: the item's vars (step variables and built-ins), then run parameters, then the first input file's `core.FileVars` (`name`, `ext`, `role`).
  2. If the value is missing or empty, keep the option's own value.
  3. Otherwise, convert it to the JSON type of the option's **current** value:
     - **string:** the value as is.
     - **number:** parse as a float; if the option's default is an integer, round it. If it isn't a number, the cell fails with `CodeValidation`: "<Step>: {bpm} isn't a number ("abc")", hinted "Check what step N makes".
     - **bool:** `true/yes/on/1` or `false/no/off/0` (any case); anything else fails the same way.
  4. Pointers address object fields (RFC 6901, with `~0`/`~1`), including nested ones, and array elements by index.
  5. A pointer that doesn't resolve, or that resolves to an object or array, is a Describe problem (§2.2) and is never applied.
- **Run parameters.**
  - `StartRun` merges `RunRequest.Params` over each param's `Default`.
  - Values are validated:
    - number parses;
    - toggle parses;
    - choice is in `Choices`;
    - colour is `#rrggbb`;
    - each value is ≤ 1000 chars.
  - A bad value fails the start with `CodeValidation` and `fields: {"params.<name>": message}`.
  - The values are added to every item's vars (so `{name}` templates can use them too) and persisted with the run like other vars.
  - Watch-folder, clipboard and sub-pipeline runs use the defaults.
- **Save validation** (`pipelines.go`) fails with `CodeValidation` when:
  - Binds:
    - a pipeline has more than 50 binds per step;
    - a step binds the same option twice;
    - an option isn't a JSON pointer starting with `/`;
    - a var name doesn't match the var pattern.
  - Params:
    - there are more than 20 params;
    - a param name doesn't match the var pattern or is a built-in var's name;
    - two params share a name;
    - a label is empty or longer than 60 chars;
    - the type is unknown or `file`;
    - a choice param doesn't have 2–30 unique non-empty choices;
    - a default is invalid for its type.
  - Old pipelines with `binds`/`params` missing load as empty lists. Go never sends null for these.
- **Sub-pipelines** ("Run another pipeline") pass nothing new. The inner pipeline uses its own defaults.

### 2.2 Describe
- `StepCheck.Vars` also lists the pipeline's params, labelled "Run parameter · <label>" with their type.
- For each bind, Describe adds a problem when:
  - the option's pointer doesn't resolve in the step's options: "The <label> setting doesn't exist any more";
  - the pointer resolves to an object or array;
  - the variable isn't available: "{v} isn't made by an earlier step".
- When a number or toggle option is wired to a **text** variable, Describe adds a *warning* (not a problem): "{v} is text; the run fails if it isn't a number".

### 2.3 Variable types
Every module's `DescribeStep` gives its `Vars` a `Type`:
- `bpm`, `bpm_exact`, `kept_s`, `removed_s`, `scene`, `scene_total`: number;
- `speech_file`: file;
- `post_folder`, `folder`: text (they're folders, not files);
- everything else: text.

The built-ins get `n` as number and the rest as text. The Go tests list every var name with its type, so a new var has to pick one.

### 2.4 Template change
The Narrated slideshow template now wires `/show/music` (or whatever pointer the slideshow step's music field uses) to `speech_file` with a bind, instead of the `{speech_file}` template string. The template test asserts the bind.

## 3. Frontend

### 3.1 Parameters (`pipelines/params.ts`: written by the architect; `deriveParams`, `paramsOf`, `resolvePointer`, `bindOf`, `setBind`, `canWire` and `humanize` exist)
- `deriveParams(stepType, defaultsJson, overrides?: ParamOverrides): ParamDef[]` walks the defaults JSON depth-first, through object fields, ≤ 3 levels deep and never into arrays.
  - Every string, number or boolean leaf becomes a parameter.
  - Type: boolean → toggle; number → number; a string matching `^#[0-9a-f]{6}$`i → color; another string → text.
  - Label: the key humanised ("maxWidth" → "Max width").
  - Overrides refine or hide each parameter.
- **Order:** primaries first (`primary: true`), then the defaults' key order.
  - Without any primary override, the first 3 non-hidden parameters are primary.
- `paramsOf(type: string, defaultsJson: string): ParamDef[]` uses the registered `StepUI.params` and is memoised per (type, defaultsJson).
- `bindOf(step, pointer)` / `setBind(step, pointer, varName | null): PipelineStep` are pure helpers.
- `canWire(from: ValueType, to: ValueType): { ok: boolean; reason?: string }`:

| from \ to | text | number | toggle | choice | color | file |
|---|---|---|---|---|---|---|
| text | ✓ | ⚠ (warn) | ⚠ | ⚠ | ⚠ | ⚠ |
| number | ✓ | ✓ | ✗ | ⚠ | ✗ | ✗ |
| toggle | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ |
| choice | ✓ | ✗ | ✗ | ✓ | ✗ | ✗ |
| color | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ |
| file | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ |

  - ⚠ wires are allowed and drawn dashed, with a tooltip saying the run fails if the value doesn't fit.
  - A files stream never wires to a parameter, and a value never wires to a files input.

### 3.2 The graph (`tools/pipelines/GraphEditor.tsx`, `GraphNodeView.tsx`, `graphModel.ts`, `graph/*`)
- **Node layout:**
  - head (34);
  - summary (20);
  - **left column:** the files port row, then the parameter rows (20 each), then the "+ N more"/"Fewer" row;
  - **right column:** file output ports, then value output ports;
  - the node is as tall as the taller column.
  - Each parameter row shows the label (muted), with the value (or "← BPM & Key · BPM" when wired) right-aligned, truncated with ellipsis.
  - Node width stays 200 at rest; expanded nodes are 240.
- **Port shapes:** files ports are 12 px circles. Value ports are 10 px **rounded squares**, so they're distinguishable without colour.
  - Colour: `valueTypeVar(type)`.
  - A wired port is filled; an unwired one is hollow (ring in its colour).
- **Wires:**
  - File wires are orange, as today.
  - Value wires use the source port's colour, are thinner (core 1.6), have no flow animation and are dashed when ⚠.
  - `wireStyle.ts` and `WireCanvas` take an RGB per wire from the computed token.
- **Interaction:**
  - Drag from a value output to a parameter port, or from a parameter port to a value output (both directions work).
  - Legal targets highlight while dragging; others dim.
  - Dropping on a parameter that's already wired replaces its wire.
  - Clicking a wired parameter's port selects its wire; Delete removes the bind.
  - Parameter rows are keyboard reachable in the node's port order, as file ports are today.
  - Clicking a parameter row (not its port) opens the step's options panel scrolled to that field when the editor can say where it is (`data-param="<pointer>"` on the field). Otherwise it opens the panel at the top.
- **Validity:** a value wire must come from a step earlier in the step order (or from the Input node), because variables only flow downstream. A drop that would need a later step is refused: "BPM & Key runs after this step".
  - The List view still shows the same pipeline: binds are part of the step.
- **The Input node:** right column shows Files (orange), then the built-ins (Item name, File name, Extension, Item number, Run date, Run time, Pipeline name), then the run parameters. The built-ins collapse behind "+ 7 more" like parameters do.
- **Legend:** floating, bottom-left, per §1.
- The graph fits at 960×600; expanding a node never moves other nodes (overlap is fine; they can be dragged).

### 3.3 The step panel (`StepOptions.tsx`, `panels.tsx`)
- A **Wired** section at the top lists the step's binds. Each row has:
  - the type dot, the parameter label, "← <source step> · <var label>";
  - a select to pick another compatible variable;
  - an unwire ×;
  - the fallback line ("If the wire is empty, uses 120").
- **Add a wire…** opens a compact two-level picker: parameter → variable, compatible ones only.
- Below that comes the step's own editor, unchanged, and every field keeps working. The wired value overrides it at run time.

### 3.4 Run parameters and the start sheet (`RunSheet.tsx`, the Input node's panel)
- **The Input node's panel** gets a **Run parameters** section that lists each param with:
  - type dot, label and name;
  - an editable default (a field fitting the type);
  - rename (the label; the name stays);
  - remove (which also removes its binds, after a confirmation that says how many).
- **The start sheet** shows one field per param, under the inputs and secrets:
  - text → input;
  - number → number input;
  - toggle → switch;
  - choice → select;
  - colour → colour field.
  - Each field is pre-filled with the default, and Start sends `params`.
- The Runs view's run header lists the values used ("Voice: am_adam · Speed: 1.1").

### 3.5 Every step editor gets parameter metadata (`pipelines/steps/*.tsx`)
- Each `StepUI` gets a `params` override map:
  - labels as the editor words them;
  - `choice` types with the same choice lists and labels the editor shows;
  - `primary` on the 2–4 settings that matter most (the same ones the editor puts first);
  - `hidden` on internal fields (ids, JSON blobs such as Visualizer's `showJson`, design names, layout state, password refs, lists).
- A test (`pipelines/params.test.ts`) checks, for every registered step type, against the catalogue fixture's defaults:
  - every override pointer resolves;
  - at most 4 primaries;
  - no visible parameter is labelled with a raw camelCase key (each visible label differs from the key, or is explicitly confirmed with `label`);
  - choice params have ≥ 2 choices.
- `everyTool.test.tsx` additionally asserts every tool has ≥ 1 visible parameter, unless its defaults have no scalar fields. Which those are gets listed in the test with the reason.

## 4. Work packages
**Architect (done first):**
- the Go types;
- regenerated bindings;
- `lib/api.ts` re-exports;
- the tokens;
- `pipelines/params.ts` types;
- `StepUI.params`;
- the literal fixes (`binds: []`, `params: []`/`{}`);
- this spec.

**Then integration:**
- CLAUDE.md;
- DECISIONS;
- sandbox QA at 1180×720 and 960×600.

| WP | Owns | Notes |
|---|---|---|
| **P1 Runner** | `core/pipeline/**`, `core/pipeline_types.go` (comments only), `modules/*/pipeline.go` (only `Vars` types), `modules/pipelines/templates*.go` + tests, `modules/pipelines/service.go` if needed | §2 |
| **P2 Graph and panels** | `pipelines/params.test.ts` (tests of the architect's helpers; may add helpers to `params.ts` without changing existing exports), `tools/pipelines/**` | §3.1–3.4. Must not edit `pipelines/steps/*` |
| **P3 Step metadata** | `pipelines/steps/*.tsx` (except `registry.ts`), `pipelines/steps/params.test.ts`, `pipelines/everyTool.test.tsx` | §3.5. Uses only the types in `params.ts` and the catalogue fixture |

P1, P2 and P3 run in parallel.
