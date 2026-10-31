import { Icon, IconButton, MenuButton, cx, toast, type MenuItem } from "@/components";
import { LibraryService, ModulesService, OutputKind, type RunFile } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { revealLabel } from "@/lib/platform";
import { isReady } from "@/state/modules";
import { useUI } from "@/state/ui";
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
    .map((m) => ({
      id: m.module.id,
      label: m.module.name,
      icon: m.module.icon,
      onSelect: () => useUI.getState().handOff({ moduleId: m.module.id, inputs: [path] }),
    }));
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
      <span className={styles.fileName} title={file.path}>
        {file.name || file.path}
      </span>
      {file.roleLabel && <span className={styles.role}>{file.roleLabel}</span>}
      {file.missing ? (
        <span className={styles.gone}>deleted</span>
      ) : (
        <span className={styles.fileActions}>
          <IconButton size="sm" icon="external-link" label={`Open ${file.name}`} disabled={!file.outputId} onClick={() => openRunFile(file)} />
          <IconButton size="sm" icon="folder-open" label={`${revealLabel}: ${file.name}`} onClick={() => revealRunFile(file)} />
          {sendTo && (
            <MenuButton
              size="sm"
              variant="ghost"
              icon="arrow-left-right"
              label={`Send ${file.name} to…`}
              emptyLabel="No tools accept this file"
              items={() => toolSendToItems(file.path)}
            />
          )}
        </span>
      )}
    </li>
  );
}
