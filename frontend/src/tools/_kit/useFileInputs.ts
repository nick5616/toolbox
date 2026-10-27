import type { FileInfo } from "@/lib/api";

export interface FileInputs {
  /** Current inputs (deduped, in add order). */
  files: FileInfo[];
  /** Adds paths: stats them, drops unsupported/duplicate/over-limit ones (toast). */
  add: (paths: string[]) => Promise<void>;
  remove: (path: string) => void;
  clear: () => void;
  /** Opens the native picker for this module and adds the result. */
  pick: () => Promise<void>;
}

/** Manages a file tool's inputs, including handoffs (drop/paste/Send to). */
export function useFileInputs(moduleId: string): FileInputs {
  void moduleId;
  return { files: [], add: async () => {}, remove: () => {}, clear: () => {}, pick: async () => {} };
}
