import { EmptyState } from "@/components";
import type { ToolViewProps } from "@/tools";

/** Placeholder until the Phase 5 work package replaces it. */
export default function ChatView(_props: ToolViewProps) {
  return <EmptyState icon="message-square" title="Not built yet" body="This tool is being built in Phase 5." />;
}
