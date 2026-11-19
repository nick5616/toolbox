import { EmptyState } from "@/components";
import type { ToolViewProps } from "@/lib/toolActions";

// Caption Writer (Phase 20, SPEC Part B). CONTRACT STUB (Wave 0): C3 builds
// the tool (input, preset, context, cards, batch bar, past batches, gate).

export default function CaptionsView(_props: ToolViewProps) {
  return <EmptyState icon="message-square-quote" title="Caption Writer" body="Alt text, captions, keywords and names for your photos and videos." />;
}
