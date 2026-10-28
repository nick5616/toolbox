import { EmptyState } from "@/components";
import type { ToolViewProps } from "@/tools";

/** Placeholder until the Phase 5 work package replaces it. */
export default function OcrView(_props: ToolViewProps) {
  return <EmptyState icon="scan-text" title="Not built yet" body="This tool is being built in Phase 5." />;
}
