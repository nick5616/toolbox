import type { ChatConversation } from "@/lib/api";

export interface ConversationGroup {
  label: "Today" | "Earlier";
  items: ChatConversation[];
}

/** Groups (already newest-first) conversations into Today / Earlier; empty groups are dropped. */
export function groupConversations(items: ChatConversation[], now = Date.now()): ConversationGroup[] {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const startOfToday = d.getTime();
  const today = items.filter((c) => c.updatedAt >= startOfToday);
  const earlier = items.filter((c) => c.updatedAt < startOfToday);
  const out: ConversationGroup[] = [];
  if (today.length) out.push({ label: "Today", items: today });
  if (earlier.length) out.push({ label: "Earlier", items: earlier });
  return out;
}

export function isOllamaModel(id: string): boolean {
  return id.startsWith("ollama:");
}
