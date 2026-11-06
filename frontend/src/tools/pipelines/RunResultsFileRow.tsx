import { Icon, IconButton, MenuButton, cx, toast, type MenuItem } from "@/components";
import { LibraryService, ModulesService, OutputKind, type RunFile } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { openToolItems } from "@/lib/openTool";
import { revealLabel } from "@/lib/platform";
import { isReady } from "@/state/modules";
import styles from "./RunResults.module.css";

export const KIND_ICON: Record<string, string> = {
  [OutputKind.KindAudio]: "music",
  [OutputKind.KindVideo]: "film",
  [OutputKind.KindImage]: "image",
  [OutputKind.KindDocument]: "file-text",
  [OutputKind.KindOther]: "file",
};

function fail(e: unknown): void {
  const err = toAppError(e);
  toast({ tone: "danger", title: err.message, description: err.hint });
}

/** Ready tools that accept `path`, as menu items that hand the file off. */
export async function toolSendToItems(path: string): Promise<MenuItem[]> {
  const res = await ModulesService.Match([path]);
  return (res.matches ?? [])
    .filter((m) => isReady(m.module))
    .flatMap((m) =>
      // The tool, then "(new window)", as the kit's Send to offers.
      openToolItems(m.module.id, [path], "send").map((it, i) => ({
        ...it,
        label: i === 0 ? m.module.name : `${m.module.name} (new window)`,
        icon: i === 0 ? m.module.icon : "app-window",
      })),
    );
}

export function openRunFile(f: RunFile): void {
  if (f.outputId) LibraryService.Open(f.outputId).catch(fail);
}

export function revealRunFile(f: RunFile): void {
  (f.outputId ? LibraryService.Reveal(f.outputId) : LibraryService.RevealPath(f.path)).catch(fail);
}

/** One file with Open, Reveal and Send to. */
export function RunFileRow({ file, sendTo = true }: { file: RunFile; sendTo?: boolean }) {
  return (
    <li className={cx(styles.file, file.missing && styles.missing)}>
      <Icon name={KIND_ICON[file.kind] ?? "file"} size={14} className={styles.fileIcon} />
      <span className={styles.fileName} data-tip={file.path}>
        {file.name || file.path}
      </span>
      {file.roleLabel && <span className={styles.role} data-tip="What kind of result this file is">{file.roleLabel}</span>}
      {file.missing ? (
        <span className={styles.gone} data-tip="This file was deleted, for example as an in-between file">deleted</span>
      ) : (
        <span className={styles.fileActions}>
          <IconButton size="sm" icon="external-link" label={`Open ${file.name}`} data-tip={file.outputId ? "Open with your default app" : "This file is not in the Library, so it cannot be opened from here"} disabled={!file.outputId} onClick={() => openRunFile(file)} />
          <IconButton size="sm" icon="folder-open" label={`${revealLabel}: ${file.name}`} data-tip="Show this file in your file manager" onClick={() => revealRunFile(file)} />
          {sendTo && (
            <MenuButton
              size="sm"
              variant="ghost"
              icon="arrow-left-right"
              label={`Send ${file.name} to…`}
              tip="Send this file to another tool"
              emptyLabel="No tools accept this file"
              items={() => toolSendToItems(file.path)}
            />
          )}
        </span>
      )}
    </li>
  );
}
