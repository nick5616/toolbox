import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({
  Catalog: vi.fn(),
  Conversations: vi.fn(),
  Conversation: vi.fn(),
  NewConversation: vi.fn(),
  UpdateConversation: vi.fn(),
  Status: vi.fn(),
  Send: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return { ...actual, ChatService: svc };
});
vi.mock("@/lib/events", () => ({ on: () => () => undefined }));

import { ChatBackend, ChatServerState, DepSource, DepState, type ChatConversation, type ChatModelInfo } from "@/lib/api";
import { useDeps } from "@/state/deps";
import { useUI } from "@/state/ui";
import ChatView from "./ChatView";
import { formatChars } from "./ContextCard";

const model: ChatModelInfo = {
  id: "qwen3-4b", label: "Qwen3 4B Instruct", bytes: 1, license: "", hint: "", isDefault: true, verified: true, installed: true, jobId: "", ollama: false,
};
const conv: ChatConversation = { id: "c1", title: "New", model: "qwen3-4b", systemPrompt: "", createdAt: 1, updatedAt: 1 };

beforeEach(() => {
  for (const f of Object.values(svc)) f.mockReset();
  useDeps.getState().setAll([
    { id: "llama-runtime", name: "x", purpose: "", state: DepState.DepOK, version: "", path: "", source: DepSource.SourceManaged, required: true, requiredBy: [], recommendedBy: null, installHint: "", error: "", managed: false, checkedAt: 0 },
  ]);
  svc.Catalog.mockResolvedValue([model]);
  svc.Conversations.mockResolvedValue({ items: [], nextCursor: "" });
  svc.Status.mockResolvedValue({ state: ChatServerState.ChatReady, model: "qwen3-4b", backend: ChatBackend.ChatBackendGPU, error: "", notice: "", busy: "" });
  svc.NewConversation.mockResolvedValue(conv);
  svc.Send.mockResolvedValue({ userMessageId: "u1", assistantMessageId: "a1", trimmed: false });
  useUI.setState({ handoff: null });
});

describe("formatChars", () => {
  it.each([
    [850, "850 characters"],
    [12_400, "12 k characters"],
  ])("%i", (n, want) => expect(formatChars(n)).toBe(want));
});

describe("Chat text hand-off", () => {
  it("shows the text as a card with prompt chips, and the first message carries it", async () => {
    const user = userEvent.setup();
    render(<ChatView moduleId="llm-chat" />);
    const box = await screen.findByRole("textbox", { name: "Message" });
    await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBe(false));
    act(() => {
      useUI.getState().handOff({ moduleId: "llm-chat", inputs: [], text: { title: "Text of scan.png", body: "Invoice total 42", prompts: ["Summarise", "Fix typos"] } });
    });
    const card = await screen.findByLabelText("Attached text");
    expect(card.textContent).toContain("Text of scan.png · 16 characters");
    expect(screen.queryByText("Invoice total 42")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Read" }));
    expect(screen.getByText("Invoice total 42")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fix typos" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Summarise" }));
    await waitFor(() => expect(svc.Send).toHaveBeenCalled());
    const sent = svc.Send.mock.calls[0]?.[1] as string;
    expect(sent).toContain("Invoice total 42");
    expect(sent.endsWith("Summarise")).toBe(true);
    expect(useUI.getState().handoff).toBeNull();
  });
});
