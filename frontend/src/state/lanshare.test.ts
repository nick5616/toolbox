import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({ map: {} as Record<string, (d: unknown) => void> }));
const svc = vi.hoisted(() => ({
  State: vi.fn(),
  Devices: vi.fn(),
  Messages: vi.fn(),
  Activity: vi.fn(),
}));
const toasts = vi.hoisted(() => ({ calls: [] as Array<{ title: string; action?: { label: string; onClick: () => void } }> }));

vi.mock("@/lib/events", () => ({
  on: (name: string, cb: (d: unknown) => void) => {
    handlers.map[name] = cb;
    return () => {
      delete handlers.map[name];
    };
  },
}));
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, LanShareService: svc };
});
vi.mock("@/components/toast", () => ({ toast: (t: { title: string }) => toasts.calls.push(t) }));

import { JobStatus, LanFromMode, LanPromptKind, LanReceiveMode, type Job, type LanDevice, type LanMessage, type LanPrompt, type LanState } from "@/lib/api";
import { useJobs } from "./jobs";
import { EMPTY_LAN_STATE, appendCapped, deviceGroup, groupDevices, subscribeLanShare, useLanShare } from "./lanshare";
import { useUI } from "./ui";

const dev = (o: Partial<LanDevice> = {}): LanDevice => ({
  fingerprint: "aa",
  alias: "Alpha",
  deviceType: "desktop",
  deviceModel: "",
  toolbox: true,
  paired: false,
  autoAccept: false,
  address: "192.168.1.2",
  port: 53317,
  protocol: "https",
  lastSeen: 1,
  online: true,
  stored: false,
  ...o,
});

const prompt = (id: string, o: Partial<LanPrompt> = {}): LanPrompt => ({
  id,
  kind: LanPromptKind.PromptTransfer,
  device: dev(),
  verified: true,
  files: null,
  fileCount: 0,
  totalBytes: 0,
  text: "",
  pairCode: "",
  canAlways: false,
  expiresAt: 0,
  ...o,
});

const lanState = (o: Partial<LanState> = {}): LanState => ({ ...EMPTY_LAN_STATE, ...o });

beforeEach(() => {
  useLanShare.setState({ loaded: false, state: EMPTY_LAN_STATE, devices: [], prompts: [], messages: [], activity: [], sendPending: false });
  useJobs.setState({ byId: {} });
  handlers.map = {};
  toasts.calls = [];
  svc.State.mockResolvedValue(lanState({ listening: true, addresses: null }));
  svc.Devices.mockResolvedValue(null);
  svc.Messages.mockResolvedValue(null);
  svc.Activity.mockResolvedValue(null);
  useUI.setState({ view: "downloader" });
});

describe("lanshare store reducers", () => {
  it("groups devices: paired, then nearby, then other, alphabetical", () => {
    const list = [dev({ fingerprint: "1", alias: "Zed", online: false }), dev({ fingerprint: "2", alias: "Bob" }), dev({ fingerprint: "3", alias: "Ann", paired: true, online: false }), dev({ fingerprint: "4", alias: "Al" })];
    expect(groupDevices(list).map((g) => [g.label, g.devices.map((d) => d.alias)])).toEqual([
      ["Your devices", ["Ann"]],
      ["Nearby", ["Al", "Bob"]],
      ["Other", ["Zed"]],
    ]);
    expect(groupDevices([])).toEqual([]);
    expect(deviceGroup(dev({ paired: true }))).toBe("mine");
  });

  it("queues prompts, replaces by id and closes them", () => {
    const s = useLanShare.getState();
    s.addPrompt(prompt("a"));
    s.addPrompt(prompt("b", { files: null }));
    s.addPrompt(prompt("a", { fileCount: 3 }));
    expect(useLanShare.getState().prompts.map((p) => [p.id, p.fileCount, p.files])).toEqual([
      ["a", 3, []],
      ["b", 0, []],
    ]);
    s.closePrompt("a");
    expect(useLanShare.getState().prompts.map((p) => p.id)).toEqual(["b"]);
    const before = useLanShare.getState().prompts;
    s.closePrompt("nope");
    expect(useLanShare.getState().prompts).toBe(before);
  });

  it("caps messages and activity at their limits", () => {
    const msgs = Array.from({ length: 55 }, (_, i): LanMessage => ({ id: `m${i}`, from: dev(), text: "x", at: i }));
    for (const m of msgs) useLanShare.getState().addMessage(m);
    expect(useLanShare.getState().messages).toHaveLength(50);
    expect(useLanShare.getState().messages[0]?.id).toBe("m5");
    expect(appendCapped([{ id: "a" }, { id: "b" }], { id: "a" }, 5).map((x) => x.id)).toEqual(["b", "a"]);
    useLanShare.getState().clearMessagesLocal();
    expect(useLanShare.getState().messages).toEqual([]);
  });

  it("normalises nullable state fields", () => {
    useLanShare.getState().setState({ ...lanState(), addresses: null });
    expect(useLanShare.getState().state.addresses).toEqual([]);
  });

  it("takes a palette send request once", () => {
    useLanShare.getState().requestSend();
    expect(useLanShare.getState().takeSendRequest()).toBe(true);
    expect(useLanShare.getState().takeSendRequest()).toBe(false);
  });
});

describe("subscribeLanShare", () => {
  it("loads and follows events", async () => {
    const off = subscribeLanShare({ main: true });
    await vi.waitFor(() => expect(useLanShare.getState().loaded).toBe(true));
    expect(useLanShare.getState().state.listening).toBe(true);
    handlers.map["lanshare:state"]?.(lanState({ mode: LanReceiveMode.ReceiveAlways, from: LanFromMode.FromMine }));
    expect(useLanShare.getState().state.mode).toBe("always");
    handlers.map["lanshare:devices"]?.({ devices: [dev()] });
    expect(useLanShare.getState().devices).toHaveLength(1);
    handlers.map["lanshare:devices"]?.({ devices: null });
    expect(useLanShare.getState().devices).toEqual([]);
    handlers.map["lanshare:prompt"]?.(prompt("p1"));
    expect(useLanShare.getState().prompts).toHaveLength(1);
    handlers.map["lanshare:prompt-closed"]?.({ id: "p1", reason: "timeout" });
    expect(useLanShare.getState().prompts).toHaveLength(0);
    handlers.map["lanshare:activity"]?.({ id: "n1", text: "Turned away", at: 1 });
    expect(useLanShare.getState().activity).toHaveLength(1);
    off();
    expect(Object.keys(handlers.map)).toEqual([]);
  });

  it("toasts messages in the main window with Show, unless the tool is on screen", () => {
    const off = subscribeLanShare({ main: true });
    const m: LanMessage = { id: "m1", from: dev({ alias: "Pixel" }), text: "hello", at: 1 };
    handlers.map["lanshare:message"]?.(m);
    expect(toasts.calls).toHaveLength(1);
    expect(toasts.calls[0]?.title).toBe("Message from Pixel");
    toasts.calls[0]?.action?.onClick();
    expect(useUI.getState().view).toBe("lan-share");
    handlers.map["lanshare:message"]?.({ ...m, id: "m2" });
    expect(toasts.calls).toHaveLength(1);
    expect(useLanShare.getState().messages).toHaveLength(2);
    off();
  });

  it("does not show prompts or toasts in a tool window", () => {
    const off = subscribeLanShare({ main: false });
    handlers.map["lanshare:prompt"]?.(prompt("p"));
    handlers.map["lanshare:message"]?.({ id: "m", from: dev(), text: "x", at: 1 });
    expect(useLanShare.getState().prompts).toHaveLength(0);
    expect(toasts.calls).toHaveLength(0);
    expect(useLanShare.getState().messages).toHaveLength(1);
    off();
  });

  it("toasts once when a receive job finishes", () => {
    const off = subscribeLanShare({ main: true });
    const job = { id: "j1", moduleId: "lan-receive", title: "From Pixel · 2 files", status: JobStatus.JobRunning, inputs: [], outputs: [] } as unknown as Job;
    useJobs.getState().upsert(job);
    expect(toasts.calls).toHaveLength(0);
    useJobs.getState().upsert({ ...job, status: JobStatus.JobDone });
    useJobs.getState().upsert({ ...job, status: JobStatus.JobDone, progress: 1 });
    expect(toasts.calls.map((t) => t.title)).toEqual(["From Pixel · 2 files"]);
    off();
  });
});
