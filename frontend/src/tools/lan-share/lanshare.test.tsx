import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({ map: {} as Record<string, (d: unknown) => void> }));
const svc = vi.hoisted(() => ({
  State: vi.fn(),
  Devices: vi.fn(),
  Messages: vi.fn(),
  Activity: vi.fn(),
  Hold: vi.fn(),
  Release: vi.fn(),
  Send: vi.fn(),
  SetReceive: vi.fn(),
  Scan: vi.fn(),
  Pair: vi.fn(),
  CancelPair: vi.fn(),
  Respond: vi.fn(),
  Forget: vi.fn(),
  SetAutoAccept: vi.fn(),
  AddByAddress: vi.fn(),
  ClearMessages: vi.fn(),
  SaveMessage: vi.fn(),
  Settings: vi.fn(),
  SetSettings: vi.fn(),
}));
const files = vi.hoisted(() => ({ picked: [] as string[], lib: [] as string[] }));
const libPick = vi.hoisted(() => vi.fn());

// "From Library…" resolves with these paths instead of opening the dialog.
vi.mock("@/blocks/library-picker/pick", async (orig) => {
  const actual = await orig<typeof import("@/blocks/library-picker/pick")>();
  return { ...actual, pickFromLibrary: (...a: unknown[]) => libPick(...a) };
});

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
  return {
    ...actual,
    LanShareService: svc,
    FilesService: { PickWith: async () => files.picked, PickFolder: async () => "/photos", Stat: async () => [] },
    LibraryService: { OpenLibraryFolder: vi.fn(async () => undefined), RevealPath: vi.fn(async () => undefined), Reveal: vi.fn(), Open: vi.fn() },
  };
});

import {
  JobStatus,
  LanFromMode,
  LanPromptKind,
  LanReceiveMode,
  type Job,
  type LanDevice,
  type LanPrompt,
  type LanState,
} from "@/lib/api";
import { enabledCommands, registerCommands } from "@/lib/commands";
import { useJobs } from "@/state/jobs";
import { EMPTY_LAN_STATE, useLanShare } from "@/state/lanshare";
import { useUI } from "@/state/ui";
import { lanshareCommands } from "./commands";
import { routeCustomDrop } from "@/lib/dropTargets";
import LanShareView from "./LanShareView";
import LanSharePrompt from "./LanSharePrompt";
import {
  buildActivity,
  deviceIcon,
  firewallHint,
  formatPairCode,
  mergeQueue,
  parseAddress,
  promptNames,
  secondsLeft,
  seenLabel,
  stepDevices,
} from "./model";

const dev = (o: Partial<LanDevice> = {}): LanDevice => ({
  fingerprint: "aa11",
  alias: "Nicole's MacBook",
  deviceType: "desktop",
  deviceModel: "",
  toolbox: true,
  paired: false,
  autoAccept: false,
  address: "192.168.1.2",
  port: 53317,
  protocol: "https",
  lastSeen: Date.now(),
  online: true,
  stored: false,
  ...o,
});

const state = (o: Partial<LanState> = {}): LanState => ({ ...EMPTY_LAN_STATE, alias: "Nicole's Desktop", shortCode: "4F2A", ...o });

const view = (props: Partial<{ moduleId: string }> = {}) => render(<LanShareView moduleId="lan-share" {...(props as object)} />);

beforeEach(() => {
  handlers.map = {};
  files.picked = [];
  files.lib = [];
  libPick.mockReset();
  libPick.mockImplementation(async () => files.lib);
  for (const f of Object.values(svc)) f.mockReset();
  svc.Hold.mockResolvedValue(undefined);
  svc.Release.mockResolvedValue(undefined);
  svc.Send.mockResolvedValue([]);
  svc.SetReceive.mockResolvedValue(undefined);
  svc.Scan.mockResolvedValue(undefined);
  svc.Forget.mockResolvedValue(undefined);
  svc.SetAutoAccept.mockResolvedValue(undefined);
  svc.CancelPair.mockResolvedValue(undefined);
  svc.Respond.mockResolvedValue(undefined);
  svc.ClearMessages.mockResolvedValue(undefined);
  svc.Settings.mockResolvedValue({ alias: "Nicole's Desktop", aliasAuto: "DESKTOP", from: LanFromMode.FromAnyone, pinSet: false, receiveDir: "/lib/Received", firewallTip: "" });
  useLanShare.setState({ loaded: true, state: state(), devices: [], prompts: [], messages: [], activity: [], sendPending: false });
  useJobs.setState({ byId: {} });
  useUI.setState({ view: "lan-share", handoff: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("model helpers", () => {
  it("formats the small things", () => {
    expect(deviceIcon("mobile")).toBe("smartphone");
    expect(deviceIcon("")).toBe("laptop");
    expect(seenLabel({ online: true, lastSeen: 0 })).toBe("online now");
    expect(seenLabel({ online: false, lastSeen: 1_000_000 - 5 * 60_000 }, 1_000_000)).toBe("seen 5 min ago");
    expect(seenLabel({ online: false, lastSeen: 0 })).toBe("not seen yet");
    expect(formatPairCode("482911")).toBe("482 911");
    expect(secondsLeft(10_500, 10_000)).toBe(1);
    expect(secondsLeft(5_000, 10_000)).toBe(0);
    expect(mergeQueue(["a"], ["a", "b", ""])).toEqual(["a", "b"]);
    expect(parseAddress("192.168.1.4")).toEqual({ host: "192.168.1.4", port: 0 });
    expect(parseAddress("192.168.1.4:8080")).toEqual({ host: "192.168.1.4", port: 8080 });
    expect(parseAddress("[fe80::1]:53317")).toEqual({ host: "fe80::1", port: 53317 });
    expect(parseAddress("a b")).toBeNull();
    expect(parseAddress("host:99999")).toBeNull();
    expect(firewallHint(true)).toContain("local network");
    expect(firewallHint(false)).toContain("Windows Security");
  });

  it("lists the first five prompt names and the rest", () => {
    const files = Array.from({ length: 8 }, (_, i) => ({ name: `f${i}`, size: 1, type: "" }));
    expect(promptNames({ files, fileCount: 17 })).toEqual({ names: ["f0", "f1", "f2", "f3", "f4"], more: 12 });
    expect(promptNames({ files: null, fileCount: 0 })).toEqual({ names: [], more: 0 });
  });

  it("only paired or stored devices are step targets", () => {
    expect(stepDevices([dev({ fingerprint: "1", stored: false }), dev({ fingerprint: "2", stored: true }), dev({ fingerprint: "3", paired: true, stored: true, alias: "A" })]).map((d) => d.fingerprint)).toEqual(["3", "2"]);
  });

  it("builds the activity newest first from finished receives, messages and notes", () => {
    const job = (id: string, finishedAt: number, status = JobStatus.JobDone, n = 1) =>
      ({ id, moduleId: "lan-receive", status, finishedAt, createdAt: 0, inputs: [], outputs: Array.from({ length: n }, (_, i) => ({ id: `${id}${i}` })) }) as unknown as Parameters<typeof buildActivity>[0][number];
    const out = buildActivity([job("a", 10), job("b", 30, JobStatus.JobRunning), job("c", 5, JobStatus.JobDone, 0)], [{ id: "m", from: dev(), text: "t", at: 20 }], [{ id: "n", text: "x", at: 40 }]);
    expect(out.map((e) => `${e.kind}:${e.id}`)).toEqual(["note:n", "message:m", "received:a"]);
  });
});

describe("LanShareView", () => {
  it("shows the off state: no listening line, empty devices text, header controls", () => {
    view();
    expect(screen.queryByTestId("receiving")).toBeNull();
    expect(screen.getByText(/No devices yet\. Open Toolbox or LocalSend/)).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Off" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: /Send…/ })).toBeTruthy();
    expect(screen.getByText("This computer · Nicole's Desktop · 4F2A")).toBeTruthy();
  });

  it("shows the listening address and port, and sets the receive mode", async () => {
    useLanShare.setState({ state: state({ mode: LanReceiveMode.ReceiveAlways, listening: true, port: 53317, addresses: ["192.168.1.20"] }) });
    view();
    expect(screen.getByTestId("receiving").textContent).toContain("Receiving on 192.168.1.20");
    expect(screen.getByText("This computer · Nicole's Desktop · 4F2A · port 53317")).toBeTruthy();
    await userEvent.click(screen.getByRole("radio", { name: "While open" }));
    expect(svc.SetReceive).toHaveBeenCalledWith("open");
  });

  it("holds while mounted and releases on unmount", () => {
    vi.useFakeTimers();
    const { unmount } = view();
    expect(svc.Hold).toHaveBeenCalledTimes(1);
    expect(svc.Hold).toHaveBeenCalledWith("main");
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(svc.Hold).toHaveBeenCalledTimes(2);
    unmount();
    expect(svc.Release).toHaveBeenCalledWith("main");
  });

  it("groups devices and shows tags, auto-accept and actions", async () => {
    useLanShare.setState({
      devices: [
        dev({ fingerprint: "p", alias: "Studio Mac", paired: true, stored: true, autoAccept: true }),
        dev({ fingerprint: "n", alias: "Pixel", toolbox: false, deviceType: "mobile" }),
        dev({ fingerprint: "o", alias: "Old laptop", online: false, lastSeen: Date.now() - 10 * 60_000 }),
      ],
    });
    view();
    expect(screen.getByText("Your devices")).toBeTruthy();
    expect(screen.getByText("Nearby")).toBeTruthy();
    expect(screen.getByText("Other")).toBeTruthy();
    const pixel = screen.getByTestId("device-n");
    expect(within(pixel).getByText("LocalSend")).toBeTruthy();
    expect(within(pixel).queryByRole("button", { name: /Pair/ })).toBeNull();
    expect(within(screen.getByTestId("device-p")).getByText("Auto-accept")).toBeTruthy();
    expect(within(screen.getByTestId("device-o")).getByText(/seen 10 min ago/)).toBeTruthy();
    // a row is a file drop target
    expect(screen.getByTestId("device-p").getAttribute("id")).toBe("lan-device:p");
    expect(screen.getByTestId("device-p").hasAttribute("data-file-drop-target")).toBe(true);
    // toggle auto accept off, forget
    await userEvent.click(within(screen.getByTestId("device-p")).getByRole("switch", { name: /Accept from Studio Mac without asking/ }));
    expect(svc.SetAutoAccept).toHaveBeenCalledWith("p", false);
    await userEvent.click(within(screen.getByTestId("device-p")).getByRole("button", { name: "Forget Studio Mac" }));
    expect(svc.Forget).toHaveBeenCalledWith("p");
  });

  it("sends the dropped files to the device and keeps them out of the queue", async () => {
    useLanShare.setState({ devices: [dev({ fingerprint: "n", alias: "Pixel" })] });
    view();
    act(() => {
      routeCustomDrop("lan-device:n", ["/a.jpg", "/b.jpg"]);
    });
    expect(svc.Send).toHaveBeenCalledWith({ fingerprint: "n", paths: ["/a.jpg", "/b.jpg"], text: "", pin: "" });
    expect(screen.queryByTestId("queue")).toBeNull();
  });

  it("ignores drops on other targets", () => {
    useLanShare.setState({ devices: [dev({ fingerprint: "n" })] });
    view();
    act(() => {
      routeCustomDrop("tool-drop:lan-share", ["/a"]);
    });
    expect(svc.Send).not.toHaveBeenCalled();
  });

  it("queues handed-over files, then Send on a device sends them and clears the queue", async () => {
    useLanShare.setState({ devices: [dev({ fingerprint: "n", alias: "Pixel" })] });
    view();
    act(() => {
      useUI.getState().handOff({ moduleId: "lan-share", inputs: ["/x.pdf", "/y.pdf", "/x.pdf"] });
    });
    expect(screen.getByTestId("queue").textContent).toContain("2 files ready — drop them on a device or click Send on one");
    await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "here you go");
    await userEvent.click(within(screen.getByTestId("device-n")).getByRole("button", { name: /Send…/ }));
    expect(svc.Send).toHaveBeenCalledWith({ fingerprint: "n", paths: ["/x.pdf", "/y.pdf"], text: "here you go", pin: "" });
    await waitFor(() => expect(screen.queryByTestId("queue")).toBeNull());
  });

  it("Send… in the header picks files, then a device", async () => {
    files.picked = ["/p.png"];
    useLanShare.setState({ devices: [dev({ fingerprint: "n", alias: "Pixel" })] });
    view();
    await userEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /Send…/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /Pixel/ }));
    expect(svc.Send).toHaveBeenCalledWith({ fingerprint: "n", paths: ["/p.png"], text: "", pin: "" });
  });

  it("Add files from Library… queues the pick (any file type), then sends it", async () => {
    files.lib = ["/lib/Videos/a.mp4", "/lib/Docs/b.pdf"];
    useLanShare.setState({ devices: [dev({ fingerprint: "n", alias: "Pixel" })] });
    view();
    await userEvent.click(screen.getByRole("button", { name: "Add files from Library…" }));
    await waitFor(() => expect(screen.getByTestId("queue").textContent).toContain("2 files ready"));
    expect(libPick).toHaveBeenCalledWith(expect.objectContaining({ exts: null }));
    await userEvent.click(within(screen.getByTestId("device-n")).getByRole("button", { name: /Send…/ }));
    expect(svc.Send).toHaveBeenCalledWith({ fingerprint: "n", paths: ["/lib/Videos/a.mp4", "/lib/Docs/b.pdf"], text: "", pin: "" });
  });

  it("asks for the PIN inline when the receiver wants one, then resends with it", async () => {
    svc.Send.mockRejectedValueOnce({ cause: { code: "lan_pin_required", message: "PIN needed" } });
    useLanShare.setState({ devices: [dev({ fingerprint: "n", alias: "Pixel" })] });
    view();
    act(() => {
      routeCustomDrop("lan-device:n", ["/a"]);
    });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Pixel needs a PIN")).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText("PIN"), "1234");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    expect(svc.Send).toHaveBeenLastCalledWith({ fingerprint: "n", paths: ["/a"], text: "", pin: "1234" });
  });

  it("pairs: waits with a Cancel, then shows the code", async () => {
    let finish: (c: string) => void = () => undefined;
    svc.Pair.mockReturnValueOnce(new Promise<string>((r) => (finish = r)));
    useLanShare.setState({ devices: [dev({ fingerprint: "n", alias: "Mac mini" })] });
    view();
    await userEvent.click(within(screen.getByTestId("device-n")).getByRole("button", { name: /Pair/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Waiting for Mac mini/)).toBeTruthy();
    expect(svc.Pair).toHaveBeenCalledWith("n");
    await act(async () => finish("482911"));
    expect(within(dialog).getByTestId("pair-code").textContent).toBe("482 911");
    await userEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(svc.CancelPair).not.toHaveBeenCalled();
  });

  it("cancelling a pairing calls CancelPair", async () => {
    svc.Pair.mockReturnValueOnce(new Promise<string>(() => undefined));
    useLanShare.setState({ devices: [dev({ fingerprint: "n", alias: "Mac mini" })] });
    view();
    await userEvent.click(within(screen.getByTestId("device-n")).getByRole("button", { name: /Pair/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(svc.CancelPair).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Refresh scans; Add by address adds a device", async () => {
    svc.AddByAddress.mockResolvedValue(dev());
    view();
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(svc.Scan).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Add by address/ }));
    await userEvent.type(screen.getByLabelText("Device address"), "10.0.0.5:4000{Enter}");
    expect(svc.AddByAddress).toHaveBeenCalledWith("10.0.0.5", 4000);
  });

  it("shows received files per transfer, messages and notes", async () => {
    const job = {
      id: "j1",
      moduleId: "lan-receive",
      title: "From Pixel · 2 files",
      status: JobStatus.JobDone,
      finishedAt: Date.now() - 120_000,
      createdAt: 0,
      inputs: [],
      outputs: [
        { id: "o1", jobId: "j1", moduleId: "lan-receive", path: "/lib/Received/Pixel/a.jpg", name: "a.jpg", sizeBytes: 10, missing: false },
        { id: "o2", jobId: "j1", moduleId: "lan-receive", path: "/lib/Received/Pixel/b.jpg", name: "b.jpg", sizeBytes: 10, missing: false },
      ],
    } as unknown as Job;
    useJobs.getState().upsert(job);
    useLanShare.setState({
      messages: [{ id: "m1", from: dev({ alias: "Pixel" }), text: "see you at 5", at: Date.now() - 60_000 }],
      activity: [{ id: "n1", text: "Turned away a transfer from Bob (not one of your devices)", at: Date.now() - 30_000 }],
    });
    svc.SaveMessage.mockResolvedValue({ id: "o9", name: "note.txt", path: "/lib/Received/Pixel/note.txt" });
    view();
    expect(screen.getByText("From Pixel · 2 files")).toBeTruthy();
    expect(screen.getByRole("group", { name: "a.jpg" })).toBeTruthy();
    expect(screen.getByText("see you at 5")).toBeTruthy();
    expect(screen.getByText(/Turned away a transfer from Bob/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Save as file/ }));
    expect(svc.SaveMessage).toHaveBeenCalledWith("m1");
    // groups collapse
    await userEvent.click(screen.getByRole("button", { name: /From Pixel/ }));
    expect(screen.queryByRole("group", { name: "a.jpg" })).toBeNull();
    // clear messages
    await userEvent.click(screen.getByRole("button", { name: "Clear messages" }));
    expect(svc.ClearMessages).toHaveBeenCalled();
    expect(useLanShare.getState().messages).toEqual([]);
  });

  it("palette 'Send files to a device…' makes the view pick files", async () => {
    files.picked = ["/z.txt"];
    view();
    act(() => useLanShare.getState().requestSend());
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByTestId("queue").textContent).toContain("1 file ready");
  });
});

describe("palette commands", () => {
  it("offers start, stop and send according to state", async () => {
    const off = registerCommands(lanshareCommands());
    const titles = () => enabledCommands().map((c) => c.title);
    expect(titles()).toContain("Start receiving files");
    expect(titles()).not.toContain("Stop receiving files");
    expect(titles()).toContain("Send files to a device…");
    useLanShare.setState({ state: state({ mode: LanReceiveMode.ReceiveAlways, listening: true }) });
    expect(titles()).not.toContain("Start receiving files");
    expect(titles()).toContain("Stop receiving files");
    svc.SetReceive.mockResolvedValue(undefined);
    await enabledCommands().find((c) => c.id === "lanshare.stop")?.run();
    expect(svc.SetReceive).toHaveBeenCalledWith("off");
    await enabledCommands().find((c) => c.id === "lanshare.send")?.run();
    expect(useLanShare.getState().sendPending).toBe(true);
    expect(useUI.getState().view).toBe("lan-share");
    off();
  });
});

describe("LanSharePrompt", () => {
  const transfer = (o: Partial<LanPrompt> = {}): LanPrompt => ({
    id: "p1",
    kind: LanPromptKind.PromptTransfer,
    device: dev({ alias: "Pixel" }),
    verified: true,
    files: Array.from({ length: 7 }, (_, i) => ({ name: `IMG_${i}.jpg`, size: 1000, type: "image/jpeg" })),
    fileCount: 12,
    totalBytes: 12_000_000,
    text: "",
    pairCode: "",
    canAlways: false,
    expiresAt: Date.now() + 60_000,
    ...o,
  });

  it("renders nothing without a prompt", () => {
    const { container } = render(<LanSharePrompt />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the sender, counts, five names and 'and N more', then accepts", async () => {
    useLanShare.setState({ prompts: [transfer()] });
    render(<LanSharePrompt />);
    expect(screen.getByText("Pixel wants to send you files")).toBeTruthy();
    expect(screen.getByText(/12 files/)).toBeTruthy();
    expect(screen.getByText("IMG_4.jpg")).toBeTruthy();
    expect(screen.queryByText("IMG_5.jpg")).toBeNull();
    expect(screen.getByText("and 7 more")).toBeTruthy();
    expect(screen.queryByLabelText(/Always accept/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(svc.Respond).toHaveBeenCalledWith("p1", true, false);
    await waitFor(() => expect(useLanShare.getState().prompts).toHaveLength(0));
  });

  it("Esc declines and Enter accepts", async () => {
    useLanShare.setState({ prompts: [transfer()] });
    render(<LanSharePrompt />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(svc.Respond).toHaveBeenCalledWith("p1", false, false));
    cleanup();
    svc.Respond.mockClear();
    useLanShare.setState({ prompts: [transfer({ id: "p2" })] });
    render(<LanSharePrompt />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
    await waitFor(() => expect(svc.Respond).toHaveBeenCalledWith("p2", true, false));
  });

  it("offers 'Always accept' only with canAlways and passes it", async () => {
    useLanShare.setState({ prompts: [transfer({ canAlways: true })] });
    render(<LanSharePrompt />);
    await userEvent.click(screen.getByRole("switch", { name: /Always accept from this device/ }));
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(svc.Respond).toHaveBeenCalledWith("p1", true, true);
  });

  it("counts down to the expiry", () => {
    vi.useFakeTimers();
    useLanShare.setState({ prompts: [transfer({ expiresAt: Date.now() + 60_000 })] });
    render(<LanSharePrompt />);
    expect(screen.getByRole("timer").textContent).toBe("60s");
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByRole("timer").textContent).toBe("50s");
  });

  it("marks unverified senders and closes on prompt-closed", () => {
    useLanShare.setState({ prompts: [transfer({ verified: false })] });
    render(<LanSharePrompt />);
    expect(screen.getByText("Can't confirm who this is")).toBeTruthy();
    act(() => useLanShare.getState().closePrompt("p1"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("pair prompt shows the code large with Pair and Decline", async () => {
    useLanShare.setState({ prompts: [transfer({ kind: LanPromptKind.PromptPair, pairCode: "482911", canAlways: true })] });
    render(<LanSharePrompt />);
    expect(screen.getByText("Pair with Pixel?")).toBeTruthy();
    expect(screen.getByTestId("pair-code").textContent).toBe("482 911");
    expect(screen.queryByLabelText(/Always accept/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Pair" }));
    expect(svc.Respond).toHaveBeenCalledWith("p1", true, false);
  });

  it("message prompt shows the text", () => {
    useLanShare.setState({ prompts: [transfer({ kind: LanPromptKind.PromptMessage, text: "hello there", files: null, fileCount: 1 })] });
    render(<LanSharePrompt />);
    expect(screen.getByText("hello there")).toBeTruthy();
  });

  it("shows prompts one at a time, oldest first", () => {
    useLanShare.setState({ prompts: [transfer({ id: "a", device: dev({ alias: "First" }) }), transfer({ id: "b", device: dev({ alias: "Second" }) })] });
    render(<LanSharePrompt />);
    expect(screen.getByText("First wants to send you files")).toBeTruthy();
    expect(screen.queryByText("Second wants to send you files")).toBeNull();
  });
});
