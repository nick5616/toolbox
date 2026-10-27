// STUB (foundation). WP-F replaces the body; the export name and props are frozen.
// Used by the job tray and by tool views (e.g. the downloader's "Active" list).
import type { JobView } from "@/state/jobs";

export interface JobRowProps {
  job: JobView;
  /** Compact variant for tool views: no log toggle, no remove action. */
  compact?: boolean;
}

export function JobRow({ job }: JobRowProps) {
  return <div>{job.title}</div>;
}
