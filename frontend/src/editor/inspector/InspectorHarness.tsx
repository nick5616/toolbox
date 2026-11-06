/**
 * Test harness: everything the editor offers for the current selection in one
 * column, the way the old Inspector did. Production shows these panels in
 * click-in drawers behind the rail and the selection bar; tests that exercise
 * the controls of several panels at once render them together here.
 */
import { findClip } from "../doc";
import { useEditorProfile } from "../profileContext";
import { defineEditorWorkspace } from "../workspace";
import { ClipQuickControls } from "../selection/SelectionBar";
import { CLIP_CHIPS } from "../selection/summaries";
import { useEditStudio } from "../store";

export function InspectorHarness() {
  const profile = useEditorProfile();
  const ws = defineEditorWorkspace(profile);
  const selection = useEditStudio((s) => s.selection);
  const project = useEditStudio((s) => s.history?.present ?? null);
  if (!project) return null;
  const panel = (id: string) => {
    const Body = ws.getPanel(id)?.component;
    return Body ? <Body key={id} /> : null;
  };
  if (selection?.kind === "clips" && selection.ids.length === 1) {
    const clip = findClip(project, selection.ids[0] as string)?.clip;
    if (!clip) return null;
    return (
      <div>
        <ClipQuickControls clip={clip} />
        {CLIP_CHIPS.filter((c) => c.kinds.includes(clip.kind)).map((c) => panel(c.panel))}
      </div>
    );
  }
  if (selection?.kind === "track") return panel("track");
  if (selection?.kind === "song") return panel(profile.songPanel ?? "music");
  if (selection?.kind === "markers" && profile.markersPanel) return panel(profile.markersPanel);
  return panel("project");
}
