import { useEffect, useMemo } from "react";
import { Field } from "@/components/Field";
import { Select } from "@/components/Select";
import { Stepper } from "@/components/Stepper";
import { TemplateField } from "@/components/TemplateField";
import type { LanShareStepOptions } from "@/lib/api";
import { useLanShare } from "@/state/lanshare";
import { stepDevices } from "@/tools/lan-share/model";
import { registerSteps, parseObject, type StepEditorProps, type StepUI } from "./registry";
import styles from "./lanshare.module.css";

// Step editor for Local File Transfer ("lan-share"): "Send to a device".

export const DEFAULT_LANSHARE_STEP: LanShareStepOptions = { device: "", waitMinutes: 30, text: "" };

export function parseLanShareStep(json: string): LanShareStepOptions {
  const o = parseObject(json);
  const wait = typeof o.waitMinutes === "number" && Number.isFinite(o.waitMinutes) ? Math.min(1440, Math.max(0, Math.round(o.waitMinutes))) : DEFAULT_LANSHARE_STEP.waitMinutes;
  return {
    device: typeof o.device === "string" ? o.device : "",
    waitMinutes: wait,
    text: typeof o.text === "string" ? o.text : "",
  };
}

/** What the editor tells about the chosen device. */
export function lanShareNote(toolbox: boolean, paired: boolean): string {
  if (toolbox && paired) return 'Files arrive without asking if "Accept without asking" is on for this computer there; otherwise that computer asks.';
  return "That device will ask its owner before it accepts the files.";
}

function LanShareEditor({ value, onChange, vars }: StepEditorProps<LanShareStepOptions>) {
  const devices = useLanShare((s) => s.devices);
  const loaded = useLanShare((s) => s.loaded);
  useEffect(() => {
    if (!loaded) void useLanShare.getState().load().catch(() => undefined);
  }, [loaded]);
  const known = useMemo(() => stepDevices(devices), [devices]);
  const options = useMemo(() => {
    const list = known.map((d) => ({ value: d.fingerprint, label: d.paired ? `${d.alias} (paired)` : d.alias }));
    const withCurrent = value.device && !list.some((o) => o.value === value.device) ? [{ value: value.device, label: "Unknown device" }, ...list] : list;
    return [{ value: "", label: known.length === 0 ? "No devices yet: pair or send to one first" : "Choose a device…" }, ...withCurrent];
  }, [known, value.device]);
  const chosen = known.find((d) => d.fingerprint === value.device);
  const set = (patch: Partial<LanShareStepOptions>) => onChange({ ...value, ...patch });
  return (
    <div className={styles.stack}>
      <Field label="Send to" hint="Your paired computers, and devices you sent to before.">
        {(c) => <Select id={c.id} aria-describedby={c["aria-describedby"]} value={value.device} options={options} invalid={value.device === ""} onChange={(device) => set({ device })} />}
      </Field>
      <Field label="Wait for it (minutes)" hint="How long to wait for the device to be on the network.">
        {(c) => <Stepper id={c.id} value={value.waitMinutes} min={0} max={1440} step={5} unit="min" onChange={(waitMinutes) => set({ waitMinutes })} />}
      </Field>
      <TemplateField label="Message (optional)" value={value.text} vars={vars} placeholder="{name} is ready" onChange={(text) => set({ text })} />
      <p className={styles.hint}>{chosen ? lanShareNote(chosen.toolbox, chosen.paired) : "LocalSend devices will ask their owner before they accept."}</p>
    </div>
  );
}

export const lanShareSteps: ReadonlyArray<StepUI<never>> = [
  {
    type: "lan-share",
    parse: parseLanShareStep,
    Editor: LanShareEditor,
    params: {
      "/device": { label: "Device", primary: true, tip: "One of your paired devices, or a device you sent to before" },
      "/waitMinutes": { label: "Wait for it (minutes)", primary: true, min: 0, max: 1440, tip: "How long to wait for the device to be on the network" },
      "/text": { label: "Message", tip: "Sent along with the files; takes {variables}" },
    },
  } as unknown as StepUI<never>,
];

registerSteps(lanShareSteps);
