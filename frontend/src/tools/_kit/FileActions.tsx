import { useCallback } from "react";
import { Button, IconButton, MenuButton, toast } from "@/components";
import { FilesService, LibraryService } from "@/lib/api";
import { useEmbed } from "@/lib/embed";
import { toAppError } from "@/lib/errors";
import { revealLabel } from "@/lib/platform";
import { useModules } from "@/state/modules";
import { sendToMenuItems } from "./sendTo";
import { useKitTool } from "./toolContext";

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
  /** The tool this row belongs to (left out of "Send to"). Default: the enclosing `FileToolLayout`'s tool. */
  moduleId?: string;
}

/**
 * Result-row actions for a file: **Use** (only inside another tool that wants
 * results back, Phase 11), Reveal, Open and **Send to** (every ready tool that
 * accepts the file, plus "Add to post…").
 */
export function FileActions({ outputId, path, disabled, moduleId }: FileActionsProps) {
  const embed = useEmbed();
  const kitTool = useKitTool();
  const current = moduleId ?? kitTool;
  const modules = useModules((s) => s.list);
  const onUse = embed?.onUse;
  const hostName = embed?.hostName ?? "";

  const use = useCallback(async () => {
    if (!onUse) return;
    try {
      const info = (await FilesService.Stat([path]))?.[0];
      if (info && !info.exists) {
        toast({ title: "That file is gone", tone: "warn" });
        return;
      }
    } catch {
      /* can't tell: hand it over anyway */
    }
    onUse([path]);
    toast({ title: `Sent to ${hostName}`, tone: "success" });
  }, [onUse, path, hostName]);

  return (
    <>
      {onUse ? (
        <Button size="sm" variant="primary" disabled={disabled} data-tip={disabled ? "The file is missing" : `Send this file back to ${hostName}`} onClick={() => void use()}>
          {embed.useLabel}
        </Button>
      ) : null}
      <IconButton
        size="sm"
        icon="folder-open"
        label={revealLabel}
        data-tip={disabled ? "The file is missing" : outputId ? "Show this file in its folder" : "Show the folder that holds this file"}
        disabled={disabled}
        onClick={() => void run(outputId ? LibraryService.Reveal(outputId) : LibraryService.RevealPath(path))}
      />
      <IconButton
        size="sm"
        icon="external-link"
        label="Open"
        data-tip={disabled ? "The file is missing" : outputId ? "Open this file in its default app" : "Not yet registered in the library, so it can only be revealed"}
        disabled={disabled || !outputId}
        onClick={() => {
          if (outputId) void run(LibraryService.Open(outputId));
        }}
      />
      {disabled ? null : (
        <MenuButton
          size="sm"
          variant="ghost"
          icon="send"
          label="Send to…"
          tip="Open this result in another tool"
          emptyLabel="No tools accept this file"
          items={() => sendToMenuItems(path, current, modules)}
        />
      )}
    </>
  );
}
