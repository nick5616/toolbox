import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ save: vi.fn(async (_n: string, _t: string) => "C:/x/answer.md"), copy: vi.fn(async (_t: string) => undefined) }));
vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    FilesService: { SaveText: (n: string, t: string) => h.save(n, t) },
    ClipboardService: { CopyText: (t: string) => h.copy(t) },
  };
});

import { ChatMessageStatus, ChatRole, type ChatMessage } from "@/lib/api";
import { Thread } from "./Thread";

describe("Thread answers", () => {
  it("copies and saves an answer as answer.md", async () => {
    const m = { id: "1", role: ChatRole.ChatRoleAssistant, content: "Hello **there**", status: ChatMessageStatus.ChatMessageDone, tokensPerSec: 0 } as unknown as ChatMessage;
    render(<Thread messages={[m]} busy={false} backendLabel="" onRetry={() => undefined} onEdit={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
    fireEvent.click(screen.getByRole("button", { name: "Save as…" }));
    await vi.waitFor(() => expect(h.save).toHaveBeenCalledWith("answer.md", "Hello **there**"));
    expect(h.copy).toHaveBeenCalledWith("Hello **there**");
  });
});
