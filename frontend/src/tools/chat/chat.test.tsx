import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({
  Catalog: vi.fn(),
  Conversations: vi.fn(),
  Conversation: vi.fn(),
  NewConversation: vi.fn(),
  UpdateConversation: vi.fn(),
  DeleteConversation: vi.fn(),
  DownloadModel: vi.fn(),
  DeleteModel: vi.fn(),
  Status: vi.fn(),
  Send: vi.fn(),
  Regenerate: vi.fn(),
  EditAndResend: vi.fn(),
  Stop: vi.fn(),
  Export: vi.fn(),
}));
const jobsSvc = vi.hoisted(() => ({ Cancel: vi.fn() }));
const handlers = vi.hoisted(() => new Map<string, Set<(data: unknown) => void>>());

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, ChatService: svc, JobsService: { ...actual.JobsService, ...jobsSvc } };
});
vi.mock("@/lib/events", () => ({
  on: (name: string, cb: (data: unknown) => void) => {
    const set = handlers.get(name) ?? new Set();
    set.add(cb);
    handlers.set(name, set);
    return () => set.delete(cb);
  },
}));

import { useToastStore } from "@/components/toast";
import {
  ChatBackend,
  ChatMessageStatus,
  ChatRole,
  ChatServerState,
  DepSource,
  DepState,
  JobStatus,
  type ChatConversation,
  type ChatMessage,
  type ChatModelInfo,
  type DepStatus,
  type Job,
} from "@/lib/api";
import { useDeps } from "@/state/deps";
import { useJobs } from "@/state/jobs";
import ChatView from "./ChatView";
import { groupConversations } from "./grouping";

function emit(name: string, data: unknown) {
  act(() => {
    for (const cb of handlers.get(name) ?? []) cb(data);
  });
}

const model = (over: Partial<ChatModelInfo> = {}): ChatModelInfo => ({
  id: "qwen3-4b",
  label: "Qwen3 4B Instruct",
  bytes: 2_497_281_120,
  license: "Apache-2.0",
  hint: "Best all-rounder",
  isDefault: true,
  verified: true,
  installed: true,
  jobId: "",
  ollama: false,
  ...over,
});

const conv = (over: Partial<ChatConversation> = {}): ChatConversation => ({
  id: "c1",
  title: "Hello",
  model: "qwen3-4b",
  systemPrompt: "",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...over,
});

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: "m",
  conversationId: "c1",
  role: ChatRole.ChatRoleUser,
  content: "",
  status: ChatMessageStatus.ChatMessageDone,
  error: "",
  tokens: 0,
  tokensPerSec: 0,
  createdAt: 1,
  ...over,
});

const SEND = { userMessageId: "u1", assistantMessageId: "a1", trimmed: false };

function dep(id: string, state: DepState): DepStatus {
  return {
    id,
    name: id,
    purpose: "",
    state,
    version: "",
    path: "",
    source: DepSource.SourceManaged,
    required: true,
    requiredBy: [],
    recommendedBy: null,
    installHint: "",
    error: "",
    managed: false,
    checkedAt: 0,
  };
}

function toasts(): string[] {
  return useToastStore.getState().toasts.map((t) => t.title);
}

beforeEach(() => {
  for (const f of [...Object.values(svc), ...Object.values(jobsSvc)]) f.mockReset();
  handlers.clear();
  useToastStore.setState({ toasts: [] });
  useJobs.setState({ byId: {} });
  useDeps.getState().setAll([dep("llama-runtime", DepState.DepOK)]);
  svc.Catalog.mockResolvedValue([model()]);
  svc.Conversations.mockResolvedValue({ items: [], nextCursor: "" });
  svc.Status.mockResolvedValue({ state: ChatServerState.ChatReady, model: "qwen3-4b", backend: ChatBackend.ChatBackendGPU, error: "", notice: "" });
  svc.NewConversation.mockResolvedValue(conv());
  svc.Send.mockResolvedValue(SEND);
  svc.Stop.mockResolvedValue(undefined);
  svc.Regenerate.mockResolvedValue({ userMessageId: "", assistantMessageId: "a2", trimmed: false });
});

async function ready() {
  render(<ChatView moduleId="llm-chat" />);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBe(false));
  return box as HTMLTextAreaElement;
}

describe("groupConversations", () => {
  it("splits Today and Earlier and drops empty groups", () => {
    const now = new Date(2026, 9, 28, 15).getTime();
    const g = groupConversations(
      [conv({ id: "a", updatedAt: now - 1000 }), conv({ id: "b", updatedAt: now - 3 * 86_400_000 })],
      now,
    );
    expect(g.map((x) => [x.label, x.items.map((i) => i.id)])).toEqual([
      ["Today", ["a"]],
      ["Earlier", ["b"]],
    ]);
    expect(groupConversations([], now)).toEqual([]);
  });
});

describe("Composer keys", () => {
  it("Enter sends, Shift+Enter adds a newline", async () => {
    const user = userEvent.setup();
    const box = await ready();
    await user.type(box, "line one{Shift>}{Enter}{/Shift}line two");
    expect(box.value).toBe("line one\nline two");
    expect(svc.Send).not.toHaveBeenCalled();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(svc.Send).toHaveBeenCalledWith("c1", "line one\nline two"));
    expect(svc.NewConversation).toHaveBeenCalledWith("qwen3-4b");
    await waitFor(() => expect(box.value).toBe(""));
    expect(screen.getByText(/line one/)).toBeTruthy();
  });

  it("Esc and the Stop button stop the running answer", async () => {
    const user = userEvent.setup();
    const box = await ready();
    await user.type(box, "hi{Enter}");
    await screen.findByTestId("caret");
    await user.type(box, "{Escape}");
    expect(svc.Stop).toHaveBeenCalledWith("c1");
    svc.Stop.mockClear();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(svc.Stop).toHaveBeenCalledWith("c1");
  });

  it("is disabled with a Loading model placeholder while the engine starts", async () => {
    svc.Status.mockResolvedValue({ state: ChatServerState.ChatStarting, model: "", backend: ChatBackend.$zero, error: "", notice: "" });
    render(<ChatView moduleId="llm-chat" />);
    const box = (await screen.findByRole("textbox", { name: "Message" })) as HTMLTextAreaElement;
    await waitFor(() => expect(box.disabled).toBe(true));
    expect(box.placeholder).toBe("Loading model…");
    emit("chat:status", { state: ChatServerState.ChatReady, model: "", backend: ChatBackend.ChatBackendGPU, error: "", notice: "" });
    await waitFor(() => expect(box.disabled).toBe(false));
  });

  it("shows a busy line for a background completion and keeps the composer usable", async () => {
    svc.Status.mockResolvedValue({ state: ChatServerState.ChatReady, model: "", backend: ChatBackend.ChatBackendGPU, error: "", notice: "" });
    render(<ChatView moduleId="llm-chat" />);
    const box = (await screen.findByRole("textbox", { name: "Message" })) as HTMLTextAreaElement;
    emit("chat:status", { state: ChatServerState.ChatReady, model: "", backend: ChatBackend.ChatBackendGPU, error: "", notice: "", busy: "Translating subtitles" });
    expect(await screen.findByText("Busy: translating subtitles\u2026")).toBeTruthy();
    expect(box.disabled).toBe(false);
    emit("chat:status", { state: ChatServerState.ChatReady, model: "", backend: ChatBackend.ChatBackendGPU, error: "", notice: "", busy: "" });
    await waitFor(() => expect(screen.queryByText(/^Busy:/)).toBeNull());
  });
});

describe("streaming", () => {
  it("appends deltas to the right message, then shows the speed footer", async () => {
    const user = userEvent.setup();
    const box = await ready();
    await user.type(box, "hi{Enter}");
    await screen.findByTestId("caret");

    emit("chat:delta", { conversationId: "c1", messageId: "other", delta: "NOPE" });
    emit("chat:delta", { conversationId: "c2", messageId: "a1", delta: "NOPE" });
    emit("chat:delta", { conversationId: "c1", messageId: "a1", delta: "Hello " });
    emit("chat:delta", { conversationId: "c1", messageId: "a1", delta: "**world**" });
    const answer = screen.getByRole("article", { name: "Assistant" });
    expect(answer.textContent).toContain("Hello world");
    expect(answer.textContent).not.toContain("NOPE");
    expect(answer.querySelector("strong")?.textContent).toBe("world");

    emit("chat:done", { conversationId: "c1", messageId: "a1", status: ChatMessageStatus.ChatMessageDone, error: "", tokens: 50, tokensPerSec: 42.3 });
    await waitFor(() => expect(screen.queryByTestId("caret")).toBeNull());
    expect(screen.getByText("42 tok/s · GPU")).toBeTruthy();
  });

  it("keeps deltas that arrive before Send resolves", async () => {
    const user = userEvent.setup();
    let resolve!: (v: typeof SEND) => void;
    svc.Send.mockReturnValue(new Promise((r) => (resolve = r)));
    const box = await ready();
    await user.type(box, "hi{Enter}");
    await waitFor(() => expect(svc.Send).toHaveBeenCalled());
    emit("chat:delta", { conversationId: "c1", messageId: "a1", delta: "early" });
    resolve(SEND);
    await waitFor(() => expect(screen.getByRole("article", { name: "Assistant" }).textContent).toContain("early"));
  });

  it("shows Stopped, and Retry regenerates", async () => {
    const user = userEvent.setup();
    const box = await ready();
    await user.type(box, "hi{Enter}");
    await screen.findByTestId("caret");
    emit("chat:delta", { conversationId: "c1", messageId: "a1", delta: "partial" });
    emit("chat:done", { conversationId: "c1", messageId: "a1", status: ChatMessageStatus.ChatMessageStopped, error: "", tokens: 1, tokensPerSec: 0 });
    expect(await screen.findByText("Stopped")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(svc.Regenerate).toHaveBeenCalledWith("c1");
    await waitFor(() => expect(screen.queryByText("Stopped")).toBeNull());
    expect(screen.queryByText("partial")).toBeNull();
    expect(screen.getAllByRole("article", { name: "Assistant" })).toHaveLength(1);
  });

  it("shows the error with Retry", async () => {
    const user = userEvent.setup();
    const box = await ready();
    await user.type(box, "hi{Enter}");
    await screen.findByTestId("caret");
    emit("chat:done", { conversationId: "c1", messageId: "a1", status: ChatMessageStatus.ChatMessageError, error: "The model crashed", tokens: 0, tokensPerSec: 0 });
    expect((await screen.findByRole("alert")).textContent).toBe("The model crashed");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("errors and history", () => {
  it("toasts the conflict message when another answer is running", async () => {
    const user = userEvent.setup();
    svc.Send.mockRejectedValue({ code: "conflict", message: "Wait for the current answer or stop it" });
    const box = await ready();
    await user.type(box, "hi{Enter}");
    await waitFor(() => expect(toasts()).toContain("Wait for the current answer or stop it"));
    // The text comes back so nothing is lost.
    await waitFor(() => expect(box.value).toBe("hi"));
  });

  it("opens a conversation, shows the context notice and edits and resends", async () => {
    const user = userEvent.setup();
    svc.Conversations.mockResolvedValue({ items: [conv()], nextCursor: "" });
    svc.Conversation.mockResolvedValue({
      conversation: conv(),
      trimmed: true,
      messages: [
        msg({ id: "u0", content: "first question" }),
        msg({ id: "a0", role: ChatRole.ChatRoleAssistant, content: "first answer", tokensPerSec: 10 }),
      ],
    });
    svc.EditAndResend.mockResolvedValue({ userMessageId: "u9", assistantMessageId: "a9", trimmed: false });
    await ready();
    await user.click(await screen.findByRole("button", { name: "Hello" }));
    expect(await screen.findByText("first answer")).toBeTruthy();
    expect(screen.getByText("Older messages were left out to fit the context")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Edit & resend/ }));
    const edit = screen.getByRole("textbox", { name: "Edit message" });
    await user.clear(edit);
    await user.type(edit, "better question");
    await user.click(screen.getByRole("button", { name: "Save and resend" }));
    expect(svc.EditAndResend).toHaveBeenCalledWith("c1", "u0", "better question");
    await waitFor(() => expect(screen.getByText("better question")).toBeTruthy());
    expect(screen.queryByText("first answer")).toBeNull();
  });
});

describe("model cards", () => {
  it("shows download progress from the job and cancels", async () => {
    const user = userEvent.setup();
    svc.Catalog.mockResolvedValue([model({ installed: false, jobId: "j1" }), model({ id: "qwen3.5-2b", label: "Qwen3.5 2B", isDefault: false })].map((m, i) => (i === 1 ? { ...m, installed: false } : m)));
    useJobs.setState({
      byId: {
        j1: { id: "j1", status: JobStatus.JobRunning, progress: 0.4, message: "1.0 GB of 2.5 GB · 18 MB/s", inputs: [], outputs: [] } as unknown as Job & { inputs: string[]; outputs: Job["outputs"] & unknown[] },
      },
    });
    render(<ChatView moduleId="llm-chat" />);
    expect(await screen.findByText("Download a model to start chatting")).toBeTruthy();
    const card = screen.getByText("Qwen3 4B Instruct").closest("li") as HTMLElement;
    expect(within(card).getByRole("progressbar")).toBeTruthy();
    expect(within(card).getByText("1.0 GB of 2.5 GB · 18 MB/s")).toBeTruthy();
    const textbox = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    expect(textbox.disabled).toBe(true);

    await user.click(within(card).getByRole("button", { name: "Cancel" }));
    expect(jobsSvc.Cancel).toHaveBeenCalledWith("j1");

    // The other model starts a download.
    svc.DownloadModel.mockResolvedValue({ id: "j2", status: JobStatus.JobQueued, progress: 0, message: "", inputs: null, outputs: null } as unknown as Job);
    const other = screen.getByText("Qwen3.5 2B").closest("li") as HTMLElement;
    await user.click(within(other).getByRole("button", { name: "Download" }));
    expect(svc.DownloadModel).toHaveBeenCalledWith("qwen3.5-2b");
    await waitFor(() => expect(within(other).getByRole("progressbar")).toBeTruthy());
  });
});

describe("DepsGate", () => {
  it("blocks the composer while the chat engine is missing", async () => {
    useDeps.getState().setAll([dep("llama-runtime", DepState.DepMissing)]);
    render(<ChatView moduleId="llm-chat" />);
    const box = (await screen.findByRole("textbox", { name: "Message" })) as HTMLTextAreaElement;
    await waitFor(() => expect(box.disabled).toBe(true));
    expect(box.placeholder).toContain("llama-runtime");
  });
});
