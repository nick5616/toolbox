import { IconButton, toast } from "@/components";
import { LibraryService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { revealLabel } from "@/lib/platform";

async function run(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    toast({ title: toAppError(e).message, tone: "danger" });
  }
}

export interface FileActionsProps {
  /** Library output id; without it Open is disabled and Reveal falls back to the path. */
  outputId?: string;
  path: string;
  disabled?: boolean;
}

/** Reveal + Open icon buttons for a result file. */
export function FileActions({ outputId, path, disabled }: FileActionsProps) {
  return (
    <>
      <IconButton
        size="sm"
        icon="folder-open"
        label={revealLabel}
        disabled={disabled}
        onClick={() => void run(outputId ? LibraryService.Reveal(outputId) : LibraryService.RevealPath(path))}
      />
      <IconButton
        size="sm"
        icon="external-link"
        label="Open"
        disabled={disabled || !outputId}
        onClick={() => {
          if (outputId) void run(LibraryService.Open(outputId));
        }}
      />
    </>
  );
}
