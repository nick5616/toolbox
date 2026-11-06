import { LanReceiveMode, type LanActivity, type LanDevice, type LanMessage, type LanPrompt, type LanState } from "@/lib/api";
import { JobStatus } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import type { JobView } from "@/state/jobs";

/** Error code the service returns when the receiver wants a PIN (core.CodeLanPinRequired). */
export const PIN_REQUIRED_CODE = "lan_pin_required";
/** DOM id prefix of a device row (a file drop target). */
export const DEVICE_DROP_PREFIX = "lan-device:";
/** Two-column layout at this width and above. */
export const WIDE_WIDTH = 1100;
/** A listening computer nobody has found for this long gets the firewall hint. */
export const FIREWALL_HINT_MS = 120_000;
export const HOLD_INTERVAL_MS = 10_000;

export const RECEIVE_OPTIONS: ReadonlyArray<{ value: LanReceiveMode; label: string; tip: string }> = [
  { value: LanReceiveMode.ReceiveOff, label: "Off", tip: "This computer doesn't receive files" },
  { value: LanReceiveMode.ReceiveOpen, label: "While open", tip: "Receive while Local File Transfer is on screen" },
  { value: LanReceiveMode.ReceiveAlways, label: "Always", tip: "Receive for as long as Toolbox runs" },
];

export const FIREWALL_WINDOWS = "If your other devices can't see this computer, allow Toolbox on private networks in Windows Security → Firewall.";
export const FIREWALL_MAC = "If asked, allow Toolbox to find devices on your local network.";

export function firewallHint(isMac: boolean): string {
  return isMac ? FIREWALL_MAC : FIREWALL_WINDOWS;
}

/** Lucide icon for a device type. */
export function deviceIcon(deviceType: string): string {
  switch (deviceType) {
    case "mobile":
      return "smartphone";
    case "desktop":
      return "monitor";
    case "web":
      return "globe";
    case "server":
    case "headless":
      return "server";
    default:
      return "laptop";
  }
}

/** "seen 2 min ago" / "online now". */
export function seenLabel(d: Pick<LanDevice, "online" | "lastSeen">, now: number = Date.now()): string {
  if (d.online) return "online now";
  if (!d.lastSeen) return "not seen yet";
  const mins = Math.floor((now - d.lastSeen) / 60_000);
  if (mins < 1) return "seen just now";
  if (mins < 60) return `seen ${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `seen ${hours} h ago`;
  return `seen ${Math.floor(hours / 24)} d ago`;
}

/** The address the header and the bottom bar show for this computer. */
export function receivingAddress(s: Pick<LanState, "addresses">): string {
  return s.addresses?.[0] ?? "";
}

export function describeFiles(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

/** The first five names of a prompt, then "and N more". */
export function promptNames(p: Pick<LanPrompt, "files" | "fileCount">): { names: string[]; more: number } {
  const files = p.files ?? [];
  const names = files.slice(0, 5).map((f) => f.name);
  return { names, more: Math.max(0, Math.max(p.fileCount, files.length) - names.length) };
}

export function promptSummary(p: Pick<LanPrompt, "fileCount" | "totalBytes">): string {
  return `${describeFiles(p.fileCount)} · ${formatBytes(p.totalBytes)}`;
}

/** Seconds left until `expiresAt` (never negative). */
export function secondsLeft(expiresAt: number, now: number = Date.now()): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/** "482911" → "482 911". */
export function formatPairCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** Whether the pairing code of an in-flight send looks like one. */
export function isPinRequired(e: { code?: string } | null | undefined): boolean {
  return e?.code === PIN_REQUIRED_CODE;
}

/** What the header says while the listener runs. */
export function receivingLabel(s: LanState): string {
  if (s.error) return s.error;
  if (!s.listening) return "";
  const a = receivingAddress(s);
  return a ? `Receiving on ${a}` : "Receiving";
}

export type ActivityEntry =
  | { kind: "received"; id: string; at: number; job: JobView }
  | { kind: "message"; id: string; at: number; message: LanMessage }
  | { kind: "note"; id: string; at: number; note: LanActivity };

/** Finished receives, messages and notes, newest first. */
export function buildActivity(receives: readonly JobView[], messages: readonly LanMessage[], notes: readonly LanActivity[]): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  for (const job of receives) {
    if (job.status === JobStatus.JobDone && job.outputs.length > 0) out.push({ kind: "received", id: job.id, at: job.finishedAt || job.createdAt, job });
  }
  for (const message of messages) out.push({ kind: "message", id: message.id, at: message.at, message });
  for (const note of notes) out.push({ kind: "note", id: note.id, at: note.at, note });
  return out.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

/** Jobs to show as live rows: running or queued ones, plus failed sends. */
export function liveJobs(jobs: readonly JobView[]): JobView[] {
  return jobs.filter((j) => j.status === JobStatus.JobQueued || j.status === JobStatus.JobRunning || j.status === JobStatus.JobFailed);
}

/** Merges new paths into the queue without duplicates. */
export function mergeQueue(queue: readonly string[], add: readonly string[]): string[] {
  const seen = new Set(queue);
  const out = [...queue];
  for (const p of add) {
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

export function queueSummary(n: number): string {
  return `${describeFiles(n)} ready — drop them on a device or click Send on one`;
}

/** Devices a send can go to: online ones first. */
export function sendTargets(devices: readonly LanDevice[]): LanDevice[] {
  return [...devices].sort((a, b) => Number(b.online) - Number(a.online) || Number(b.paired) - Number(a.paired) || a.alias.localeCompare(b.alias));
}

/** Parses "host" or "host:port" for Add by address; null when it isn't usable. */
export function parseAddress(input: string): { host: string; port: number } | null {
  const t = input.trim();
  if (!t) return null;
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:\s]+):(\d{1,5})$/.exec(t);
  if (m) {
    const port = Number(m[2]);
    if (port < 1 || port > 65535) return null;
    return { host: (m[1] ?? "").replace(/^\[|\]$/g, ""), port };
  }
  if (/\s/.test(t)) return null;
  return { host: t.replace(/^\[|\]$/g, ""), port: 0 };
}

/** A paired or sent-to device may be a step target. */
export function stepDevices(devices: readonly LanDevice[]): LanDevice[] {
  return devices.filter((d) => d.stored).sort((a, b) => Number(b.paired) - Number(a.paired) || a.alias.localeCompare(b.alias));
}
