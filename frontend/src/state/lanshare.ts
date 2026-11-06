import { create } from "zustand";
import { toast } from "@/components/toast";
import { JobStatus, LanFromMode, LanReceiveMode, LanShareService, type LanActivity, type LanDevice, type LanMessage, type LanPrompt, type LanState } from "@/lib/api";
import { on } from "@/lib/events";
import { useJobs } from "./jobs";
import { useUI } from "./ui";

export const LAN_MODULE_ID = "lan-share";
export const LAN_RECEIVE_MODULE_ID = "lan-receive";
export const MAX_MESSAGES = 50;
export const MAX_ACTIVITY = 50;

export const EMPTY_LAN_STATE: LanState = {
  mode: LanReceiveMode.ReceiveOff,
  listening: false,
  port: 0,
  addresses: [],
  alias: "",
  fingerprint: "",
  shortCode: "",
  from: LanFromMode.FromAnyone,
  pinSet: false,
  error: "",
};

/** Go's nullable slices become arrays. */
export function normalizeLanState(s: LanState): LanState {
  return { ...s, addresses: s.addresses ?? [] };
}

export function normalizePrompt(p: LanPrompt): LanPrompt {
  return { ...p, files: p.files ?? [] };
}

export type DeviceGroup = "mine" | "nearby" | "other";

export function deviceGroup(d: LanDevice): DeviceGroup {
  if (d.paired) return "mine";
  return d.online ? "nearby" : "other";
}

/** Paired devices first, then nearby (online), then the rest; alphabetical inside a group. */
export function groupDevices(devices: readonly LanDevice[]): Array<{ group: DeviceGroup; label: string; devices: LanDevice[] }> {
  const labels: Record<DeviceGroup, string> = { mine: "Your devices", nearby: "Nearby", other: "Other" };
  const out: Array<{ group: DeviceGroup; label: string; devices: LanDevice[] }> = [];
  for (const group of ["mine", "nearby", "other"] as const) {
    const list = devices.filter((d) => deviceGroup(d) === group).sort((a, b) => a.alias.localeCompare(b.alias) || a.fingerprint.localeCompare(b.fingerprint));
    if (list.length > 0) out.push({ group, label: labels[group], devices: list });
  }
  return out;
}

/** Appends keeping the newest `max`; an entry with an existing id replaces it. */
export function appendCapped<T extends { id: string }>(list: readonly T[], item: T, max: number): T[] {
  const next = [...list.filter((x) => x.id !== item.id), item];
  return next.length > max ? next.slice(next.length - max) : next;
}

export interface LanShareStore {
  loaded: boolean;
  state: LanState;
  devices: LanDevice[];
  /** Open prompts, oldest first; the overlay shows the first. */
  prompts: LanPrompt[];
  messages: LanMessage[];
  activity: LanActivity[];
  /** The palette asked to send files: the tool consumes it with takeSendRequest. */
  sendPending: boolean;

  requestSend: () => void;
  takeSendRequest: () => boolean;
  setState: (s: LanState) => void;
  setDevices: (d: LanDevice[]) => void;
  addPrompt: (p: LanPrompt) => void;
  closePrompt: (id: string) => void;
  addMessage: (m: LanMessage) => void;
  clearMessagesLocal: () => void;
  addActivity: (a: LanActivity) => void;
  load: () => Promise<void>;
}

export const useLanShare = create<LanShareStore>((set, get) => ({
  loaded: false,
  state: EMPTY_LAN_STATE,
  devices: [],
  prompts: [],
  messages: [],
  activity: [],
  sendPending: false,

  requestSend: () => set({ sendPending: true }),
  takeSendRequest: () => {
    const was = get().sendPending;
    if (was) set({ sendPending: false });
    return was;
  },
  setState: (s) => set({ state: normalizeLanState(s) }),
  setDevices: (devices) => set({ devices }),
  addPrompt: (p) =>
    set((st) => ({
      prompts: st.prompts.some((x) => x.id === p.id) ? st.prompts.map((x) => (x.id === p.id ? normalizePrompt(p) : x)) : [...st.prompts, normalizePrompt(p)],
    })),
  closePrompt: (id) => set((st) => (st.prompts.some((p) => p.id === id) ? { prompts: st.prompts.filter((p) => p.id !== id) } : st)),
  addMessage: (m) => set((st) => ({ messages: appendCapped(st.messages, m, MAX_MESSAGES) })),
  clearMessagesLocal: () => set({ messages: [] }),
  addActivity: (a) => set((st) => ({ activity: appendCapped(st.activity, a, MAX_ACTIVITY) })),
  load: async () => {
    const [state, devices, messages, activity] = await Promise.all([
      LanShareService.State(),
      LanShareService.Devices(),
      LanShareService.Messages(),
      LanShareService.Activity(),
    ]);
    set({ loaded: true, state: normalizeLanState(state), devices: devices ?? [], messages: messages ?? [], activity: activity ?? [] });
  },
}));

/** True while the tool is on screen, so a toast about it would be noise. */
function toolOnScreen(): boolean {
  return useUI.getState().view === LAN_MODULE_ID && (typeof document === "undefined" || document.visibilityState !== "hidden");
}

function show(): void {
  useUI.getState().navigate(LAN_MODULE_ID);
}

export function notifyMessage(m: LanMessage): void {
  if (toolOnScreen()) return;
  toast({ title: `Message from ${m.from.alias}`, description: m.text.length > 120 ? m.text.slice(0, 120) + "…" : m.text, action: { label: "Show", onClick: show } });
}

/** Toast for a receive job that just finished. */
export function notifyReceived(title: string): void {
  if (toolOnScreen()) return;
  toast({ tone: "success", title: title || "Received files", action: { label: "Show", onClick: show } });
}

let unsubscribers: Array<() => void> = [];

/**
 * Subscribes the store to the backend's lanshare events and loads it. Called by
 * the main window and tool windows (not popups); only the main window shows prompts and toasts.
 */
export function subscribeLanShare(opts: { main: boolean }): () => void {
  for (const u of unsubscribers) u();
  const s = useLanShare.getState;
  const subs: Array<() => void> = [
    on("lanshare:state", (v) => s().setState(v)),
    on("lanshare:devices", (v) => s().setDevices(v.devices ?? [])),
    on("lanshare:activity", (v) => s().addActivity(v)),
    on("lanshare:prompt", (p) => {
      if (opts.main) s().addPrompt(p);
    }),
    on("lanshare:prompt-closed", (c) => s().closePrompt(c.id)),
    on("lanshare:message", (m) => {
      s().addMessage(m);
      if (opts.main) notifyMessage(m);
    }),
  ];
  if (opts.main) {
    // A receive job that finishes raises one toast ("From Nicole's MacBook · 12 files").
    const seen = new Set<string>(
      Object.values(useJobs.getState().byId)
        .filter((j) => j.moduleId === LAN_RECEIVE_MODULE_ID && j.status === JobStatus.JobDone)
        .map((j) => j.id),
    );
    subs.push(
      useJobs.subscribe((st) => {
        for (const j of Object.values(st.byId)) {
          if (j.moduleId !== LAN_RECEIVE_MODULE_ID || j.status !== JobStatus.JobDone || seen.has(j.id)) continue;
          seen.add(j.id);
          notifyReceived(j.title);
        }
      }),
    );
  }
  unsubscribers = subs;
  void s()
    .load()
    .catch(() => undefined);
  return () => {
    for (const u of subs) u();
    unsubscribers = unsubscribers.filter((u) => !subs.includes(u));
  };
}
