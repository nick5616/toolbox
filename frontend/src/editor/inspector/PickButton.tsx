/** The "Pick" button beside a chroma key's colour (Phase 21 SPEC §B4): arms the preview eyedropper for the selected clip. */
import { Button } from "@/components";
import { useEditStudio } from "@/editor/store";
import { useOverlayMode } from "../overlays/overlayMode";
import styles from "./inspector.module.css";

export function PickButton({ postId, param }: { postId: string; param: string }) {
  const clipId = useEditStudio((s) => (s.selection?.kind === "clips" && s.selection.ids.length === 1 ? (s.selection.ids[0] as string) : null));
  const pick = useOverlayMode((s) => s.pick);
  const error = useOverlayMode((s) => s.pickError);
  const startPick = useOverlayMode((s) => s.startPick);
  const endPick = useOverlayMode((s) => s.endPick);
  const active = !!pick && pick.postId === postId && pick.param === param;
  const off = !clipId;
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        icon="crop"
        className={styles.pickBtn}
        aria-pressed={active}
        disabled={off}
        data-tip={off ? "Select a clip first, then click its picture on the preview to pick the key colour" : active ? "Click the colour on the preview, or press Esc to cancel" : "Pick the key colour from the clip's own picture on the preview"}
        onClick={() => {
          if (off || !clipId) return;
          if (active) endPick();
          else startPick({ clipId, postId, param });
        }}
      >
        {active ? "Click the preview…" : "Pick"}
      </Button>
      {error && <p className={styles.warn}>{error}</p>}
    </>
  );
}
