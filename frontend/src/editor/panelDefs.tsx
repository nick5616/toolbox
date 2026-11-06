/**
 * The editor's own panels (Phase 10 SPEC §5.5), registered at import. Both
 * tool profiles import this module (so do the part windows through them);
 * the music layer registers its panels in `tools/edit-studio/panels.tsx`.
 *
 * Every panel reads only the editor store and the profile context, so it
 * renders the same in a click-in drawer and in its own window.
 */
import { useMemo } from "react";
import { Button } from "@/components";
import { registerEditorPanel } from "./panels";
import {
  ClipCutoutPanel,
  ClipEffectsPanel,
  ClipMasksPanel,
  ClipSpeedPanel,
  ClipTextPanel,
  ClipTransformPanel,
  ClipTransitionPanel,
  ClipVisualPanel,
} from "./inspector/clipPanels";
import { MusicInspector } from "./inspector/MusicInspector";
import { ProjectInspector } from "./inspector/ProjectInspector";
import { TrackInspector } from "./inspector/TrackInspector";
import { SourcesPanel } from "./sources/SourcesPanel";
import { useEditStudio, useProject } from "./store";
import { addTextClip } from "./text/addText";
import { clipLabel } from "./timeline/clipInfo";
import inspector from "./inspector/inspector.module.css";

/** Media: the project's photos and videos. */
function MediaPanel() {
  return <SourcesPanel />;
}

/** Text: add a title or caption, and jump to the text clips already in the edit. */
function TextPanel() {
  const project = useProject();
  const texts = useMemo(() => (project ? project.tracks.flatMap((t) => t.clips.filter((c) => c.kind === "text")) : []), [project]);
  if (!project) return null;
  return (
    <div className={inspector.root} aria-label="Text">
      <Button icon="type" data-tip="Add a text clip at the playhead: a title, a lyric line or any words over the picture" onClick={() => addTextClip()}>
        Add text
      </Button>
      {texts.length === 0 ? (
        <p className={inspector.hint}>No text yet. Add a clip, then style it from the bar under the preview.</p>
      ) : (
        <ul className={inspector.list} aria-label="Text clips">
          {texts.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className={inspector.listItem}
                data-tip="Select this text clip and move the playhead to it"
                onClick={() => {
                  const st = useEditStudio.getState();
                  st.select({ kind: "clips", ids: [c.id] });
                  st.setPlayhead(c.startMs);
                }}
              >
                {clipLabel(c)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Track: the selected track's name, mute, lock and matte. */
function TrackPanel() {
  const track = useEditStudio((s) => {
    const sel = s.selection;
    const doc = s.history?.present;
    if (!doc || sel?.kind !== "track") return null;
    return doc.tracks.find((t) => t.id === sel.id) ?? null;
  });
  if (!track) return <p className={inspector.empty}>Select a track on the timeline to edit its settings.</p>;
  return <TrackInspector key={track.id} track={track} />;
}

registerEditorPanel({ id: "media", title: "Media", icon: "images", tip: "Your photos and videos for this edit: add, tag, drag onto tracks", component: MediaPanel, width: 420, height: 720 });
registerEditorPanel({ id: "text", title: "Text", icon: "type", tip: "Add a title or caption clip", component: TextPanel });
registerEditorPanel({ id: "music", title: "Music", icon: "music", tip: "Music under the video: add, trim, volume and fades", component: MusicInspector });
registerEditorPanel({ id: "project", title: "Project", icon: "sliders-horizontal", tip: "Aspect, frame rate, background, Look and export size", component: ProjectInspector });
registerEditorPanel({ id: "track", title: "Track", icon: "film", tip: "The selected track's name, mute, lock and matte", component: TrackPanel });
registerEditorPanel({ id: "clip-transform", title: "Transform", icon: "maximize-2", tip: "Move, scale, rotate and fade the selected clip; flip and blend", component: ClipTransformPanel });
registerEditorPanel({ id: "clip-effects", title: "Effects", icon: "sparkles", tip: "Effects on the selected clip", component: ClipEffectsPanel });
registerEditorPanel({ id: "clip-masks", title: "Masks", icon: "square-dashed", tip: "Shapes that limit where the selected clip shows", component: ClipMasksPanel });
registerEditorPanel({ id: "clip-cutout", title: "Cut-out", icon: "scan-face", tip: "Separate the subject of the selected clip from its background", component: ClipCutoutPanel });
registerEditorPanel({ id: "clip-speed", title: "Speed", icon: "gauge", tip: "In point, speed ramps and slow motion of the selected video", component: ClipSpeedPanel });
registerEditorPanel({ id: "clip-transition", title: "Transition", icon: "layers", tip: "How the selected clip comes in", component: ClipTransitionPanel });
registerEditorPanel({ id: "clip-text-style", title: "Text style", icon: "type", tip: "The words, reveal and look of the selected text clip", component: ClipTextPanel });
registerEditorPanel({ id: "clip-visual", title: "Visual", icon: "sparkles", tip: "The layer, palette and settings of the selected visual clip", component: ClipVisualPanel });

/** The ids this module registers. */
export const EDITOR_PANEL_IDS = ["media", "text", "music", "project", "track", "clip-transform", "clip-effects", "clip-masks", "clip-cutout", "clip-speed", "clip-transition", "clip-text-style", "clip-visual"] as const;
