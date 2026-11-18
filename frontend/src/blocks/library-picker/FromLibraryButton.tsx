import { Button, IconButton, type ButtonSize, type ButtonVariant } from "@/components";
import type { LibraryPickOptions } from "./options";
import { pickFromLibrary } from "./pick";

export interface FromLibraryButtonProps extends LibraryPickOptions {
  /** Called with the chosen paths (never with an empty list). */
  onPick: (paths: string[]) => void;
  /** Button text (default "From Library…"). */
  label?: string;
  size?: ButtonSize;
  variant?: ButtonVariant;
  /** Icon only (the label becomes the tooltip and accessible name). */
  iconOnly?: boolean;
  /** In a compact toolbar, shows only the icon when narrow (Button's `collapsible`). */
  collapsible?: boolean;
  disabled?: boolean;
  /** Tooltip (default explains the Library). */
  tip?: string;
  className?: string;
}

const DEFAULT_TIP = "Choose from files Toolbox already made (the Library)";

/** "From Library…": the in-app picker next to a tool's own Add/Choose button. */
export function FromLibraryButton({ onPick, label = "From Library…", size = "sm", variant = "secondary", iconOnly, collapsible, disabled, tip, className, ...opts }: FromLibraryButtonProps) {
  const run = async () => {
    const paths = await pickFromLibrary(opts);
    if (paths.length > 0) onPick(paths);
  };
  if (iconOnly) {
    return <IconButton size={size} icon="history" label={label} data-tip={tip ?? DEFAULT_TIP} disabled={disabled} className={className} onClick={() => void run()} />;
  }
  return (
    <Button size={size} variant={variant} icon="history" collapsible={collapsible} disabled={disabled} data-tip={tip ?? DEFAULT_TIP} className={className} onClick={() => void run()}>
      {label}
    </Button>
  );
}
