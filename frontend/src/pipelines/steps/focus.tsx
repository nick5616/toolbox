import { useState } from "react";
import { AppIcon, AppPicker } from "@/blocks/app-picker";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { IconButton } from "@/components/IconButton";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Select } from "@/components/Select";
import { Stepper } from "@/components/Stepper";
import { TextField } from "@/components/TextField";
import { FocusService, type FocusAllowRule, type FocusStepOptions } from "@/lib/api";
import { useUI } from "@/state/ui";
import { useLoadedList } from "./context";
import { parseObject, registerSteps, type StepEditorProps, type StepUI } from "./registry";
import { clampInt, isHHMM, minutesText } from "./timeUtil";
import styles from "./timing.module.css";

// Focus step (Phase 18, SPEC §4.1, §5.3): start a session, wait for it to end, or end it.

export const MAX_FOCUS_MINUTES = 720;
export const MAX_FOCUS_EXTRA = 20;

type Action = "start" | "wait" | "end";
type Strength = FocusStepOptions["strength"];

export const DEFAULT_FOCUS_STEP: FocusStepOptions = {
  action: "start",
  profileId: "",
  mode: "for",
  minutes: 50,
  at: "17:00",
  strength: "firm" as Strength,
  extra: [],
  onStart: "close",
  ifActive: "extend",
};

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : d);

export function parseFocusStep(json: string): FocusStepOptions {
  const o = parseObject(json);
  const extra = Array.isArray(o.extra) ? (o.extra.filter((r) => r && typeof r === "object") as FocusAllowRule[]).slice(0, MAX_FOCUS_EXTRA) : [];
  return {
    action: oneOf<Action>(o.action, ["start", "wait", "end"], "start"),
    profileId: typeof o.profileId === "string" ? o.profileId : "",
    mode: o.mode === "until" ? "until" : "for",
    minutes: clampInt(o.minutes, 1, MAX_FOCUS_MINUTES, DEFAULT_FOCUS_STEP.minutes),
    at: typeof o.at === "string" && isHHMM(o.at) ? o.at : DEFAULT_FOCUS_STEP.at,
    strength: oneOf(o.strength, ["soft", "firm", "strict"], "firm") as Strength,
    extra,
    onStart: o.onStart === "leave" ? "leave" : "close",
    ifActive: oneOf(o.ifActive, ["extend", "wait", "fail"], "extend"),
  };
}

/** The step's one-line summary ("Start focus · 50 min", "Wait for focus to end"). */
export function focusSummary(v: FocusStepOptions): string {
  if (v.action === "wait") return "Wait for focus to end";
  if (v.action === "end") return "End focus";
  return `Start focus · ${v.mode === "until" ? `until ${v.at}` : minutesText(v.minutes)}`;
}

/** A start step without a profile is a problem. */
export function focusProblem(v: FocusStepOptions): string {
  return v.action === "start" && v.profileId === "" ? "Pick a profile" : "";
}

/** Rules added on top of the profile, without repeats of the same path. */
export function addExtraRules(current: readonly FocusAllowRule[], added: readonly FocusAllowRule[]): FocusAllowRule[] {
  const out = [...current];
  for (const r of added) {
    if (out.length >= MAX_FOCUS_EXTRA) break;
    if (!out.some((x) => x.path.toLowerCase() === r.path.toLowerCase())) out.push(r);
  }
  return out;
}

const STRENGTHS = [
  { value: "soft", label: "Soft (easy to end)" },
  { value: "firm", label: "Firm (a short wait to end)" },
  { value: "strict", label: "Strict (hard to end)" },
] as const;

function FocusEditor({ value, onChange }: StepEditorProps<FocusStepOptions>) {
  const profiles = useLoadedList(() => FocusService.Profiles());
  const [picking, setPicking] = useState(false);
  const set = (patch: Partial<FocusStepOptions>) => onChange({ ...value, ...patch });
  const action = value.action as Action;
  const extra = value.extra ?? [];
  const profileOptions = [
    { value: "", label: profiles.loading ? "Loading…" : profiles.items.length === 0 ? "No profiles yet: make one in Focus" : "Choose a profile…" },
    ...profiles.items.map((p) => ({ value: p.id, label: p.name })),
    ...(value.profileId && !profiles.loading && !profiles.items.some((p) => p.id === value.profileId) ? [{ value: value.profileId, label: "Unknown profile" }] : []),
  ];
  return (
    <div className={styles.root}>
      <SegmentedControl
        size="sm"
        aria-label="Focus action"
        value={action}
        onChange={(a) => set({ action: a })}
        options={[
          { value: "start", label: "Start", tip: "Begin a focus session and carry on" },
          { value: "wait", label: "Wait for end", tip: "Pause this item until the session is over" },
          { value: "end", label: "End", tip: "End the session this run started" },
        ]}
      />
      {action === "start" && (
        <>
          <Field label="Profile" error={value.profileId === "" ? "Pick a profile" : undefined}>
            {(c) => (
              <div className={styles.row}>
                <Select id={c.id} aria-describedby={c["aria-describedby"]} value={value.profileId} options={profileOptions} invalid={value.profileId === ""} onChange={(profileId) => set({ profileId })} />
                <Button size="sm" variant="ghost" icon="focus" data-tip="Open Focus Lock to make or change profiles" onClick={() => useUI.getState().navigate("focus")}>
                  Edit profiles
                </Button>
              </div>
            )}
          </Field>
          <div className={styles.row}>
            <SegmentedControl
              size="sm"
              aria-label="Session length"
              value={value.mode === "until" ? "until" : "for"}
              onChange={(mode) => set({ mode })}
              options={[
                { value: "for", label: "For", tip: "A number of minutes from when it starts" },
                { value: "until", label: "Until", tip: "Until a time of day" },
              ]}
            />
            {value.mode === "until" ? (
              <Field label="Time" error={isHHMM(value.at) ? undefined : "Use HH:MM, 24 hour"}>
                {(c) => <TextField {...c} type="time" size="sm" value={value.at} onChange={(e) => set({ at: e.target.value })} />}
              </Field>
            ) : (
              <Field label="Minutes">
                {(c) => <Stepper id={c.id} value={value.minutes} min={1} max={MAX_FOCUS_MINUTES} step={5} unit="min" onChange={(minutes) => set({ minutes })} />}
              </Field>
            )}
          </div>
          <Field label="Strength">
            {(c) => <Select id={c.id} value={value.strength as string} options={STRENGTHS} onChange={(strength) => set({ strength: strength as Strength })} />}
          </Field>
          <Field label="Programs already open">
            {(c) => (
              <Select
                id={c.id}
                value={value.onStart === "leave" ? "leave" : "close"}
                options={[
                  { value: "close", label: "Ask them to close" },
                  { value: "leave", label: "Leave them open" },
                ]}
                onChange={(onStart) => set({ onStart })}
              />
            )}
          </Field>
          <Field label="If a session is already on">
            {(c) => (
              <Select
                id={c.id}
                value={value.ifActive}
                options={[
                  { value: "extend", label: "Extend it to this end time" },
                  { value: "wait", label: "Wait for it to end first" },
                  { value: "fail", label: "Stop with an error" },
                ]}
                onChange={(ifActive) => set({ ifActive })}
              />
            )}
          </Field>
          <Field label={`Extra allowed apps (${extra.length})`} hint="Allowed in this session on top of the profile.">
            {() => (
              <div className={styles.list}>
                {extra.map((r) => (
                  <div key={r.id || r.path} className={styles.rule}>
                    <AppIcon path={r.path} label={r.label} size={18} />
                    <span className={styles.ruleName} data-tip={r.path}>
                      {r.label}
                    </span>
                    <IconButton size="sm" icon="x" label={`Remove ${r.label}`} onClick={() => set({ extra: extra.filter((x) => x !== r) })} />
                  </div>
                ))}
                <div>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="plus"
                    aria-disabled={extra.length >= MAX_FOCUS_EXTRA}
                    data-tip={extra.length >= MAX_FOCUS_EXTRA ? `At most ${MAX_FOCUS_EXTRA} extra apps` : "Pick programs to allow for this session only"}
                    onClick={() => extra.length < MAX_FOCUS_EXTRA && setPicking(true)}
                  >
                    Add app…
                  </Button>
                </div>
              </div>
            )}
          </Field>
          <AppPicker
            open={picking}
            onClose={() => setPicking(false)}
            mode="rule"
            multiple
            chosen={extra.map((r) => r.path)}
            onPickRules={(rules) => set({ extra: addExtraRules(extra, rules) })}
          />
        </>
      )}
      {action === "wait" && <p className={styles.hint}>This item waits here until the focus session ends, then the next step runs. If the session is ended early, it carries on at once. Continue now never ends the session.</p>}
      {action === "end" && <p className={styles.hint}>Ends the session this run started. A session started somewhere else can only be ended here if its strength is soft.</p>}
    </div>
  );
}

/** Only a start has settings; its length shows minutes or a time, not both. */
export function focusRelevant(o: Record<string, unknown>, pointer: string): boolean {
  if (o.action !== "start") return false;
  if (pointer === "/minutes") return o.mode !== "until";
  if (pointer === "/at") return o.mode === "until";
  return true;
}

export const focusSteps: ReadonlyArray<StepUI<never>> = [
  {
    type: "focus",
    parse: parseFocusStep,
    Editor: FocusEditor,
    params: {
      "/action": { hidden: true },
      "/profileId": { label: "Profile", type: "text", primary: true, tip: "A focus profile's id; pick it in the step instead of wiring when you can" },
      "/mode": {
        label: "Length",
        type: "choice",
        choices: [
          { value: "for", label: "For a while" },
          { value: "until", label: "Until a time" },
        ],
      },
      "/minutes": { label: "Minutes", min: 1, max: MAX_FOCUS_MINUTES, primary: true },
      "/at": { label: "Until (HH:MM)", tip: "24 hour, local time", primary: true },
      "/strength": { label: "Strength", type: "choice", choices: STRENGTHS.map((s) => ({ value: s.value, label: s.label })) },
      "/onStart": {
        label: "Programs already open",
        type: "choice",
        choices: [
          { value: "close", label: "Ask them to close" },
          { value: "leave", label: "Leave them open" },
        ],
      },
      "/ifActive": {
        label: "If a session is on",
        type: "choice",
        choices: [
          { value: "extend", label: "Extend it" },
          { value: "wait", label: "Wait for it" },
          { value: "fail", label: "Stop with an error" },
        ],
      },
    },
    relevant: focusRelevant,
  } as unknown as StepUI<never>,
];

registerSteps(focusSteps);
