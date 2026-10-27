// STUB (foundation). WP-V1 replaces this file; keep the default export and props.
import type { ToolViewProps } from "@/tools";

export default function ConverterView({ moduleId }: ToolViewProps) {
  return <section aria-label={moduleId}>{moduleId}</section>;
}
