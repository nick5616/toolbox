/** The header's Auto-fill button: opens the Auto-fill dialog for the selected range, if any. */
import { Button } from "@/components";
import { useEditStudio } from "@/editor/store";

export function AutofillButton({ disabled }: { disabled: boolean }) {
  const selection = useEditStudio((s) => s.selection);
  return (
    <Button
      icon="wand-sparkles"
      collapsible
      data-tip={disabled ? "Set up the song first" : "Fill the timeline with clips cut to the music using a recipe (the selected range, if any)"}
      disabled={disabled}
      onClick={() => useEditStudio.getState().openDialog({ kind: "autofill", range: selection?.kind === "range" ? { fromMs: selection.fromMs, toMs: selection.toMs } : null })}
    >
      Auto-fill
    </Button>
  );
}
