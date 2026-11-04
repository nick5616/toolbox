/**
 * The Subtitles workspace (Phase 11, SPEC §5.3). Defined at module load
 * (`parts/index.ts` imports it by glob) so part windows know the panels and
 * the preview. Panels: Source, Transcription, Translate, Style, Export and
 * Cues; the preview part draws the picture with the current cue.
 */
import { defineWorkspace } from "@/workspace";
import { loadSpeechLanguages } from "@/blocks/speech";
import { CuesPanel } from "./CuesPanel";
import { ExportPanel } from "./ExportPanel";
import { SubtitlesPreview } from "./Preview";
import { SourcePanel } from "./SourcePanel";
import { StylePanel } from "./StylePanel";
import { TranscriptionPanel } from "./TranscriptionPanel";
import { TranslatePanel } from "./TranslatePanel";
import { BRIDGED_ACTIONS, MODULE_ID, bridgedValues, useSubtitles, type SubtitlesState } from "./store";
import { useEffect } from "react";

export const subtitlesWorkspace = defineWorkspace({
  moduleId: MODULE_ID,
  store: useSubtitles,
  bridge: {
    pick: bridgedValues,
    apply: (store, values) => store.setState(values as Partial<SubtitlesState>),
    actions: BRIDGED_ACTIONS,
  },
  isOpen: (s) => s.mediaPath !== null || s.editor.tabs.length > 0,
  panels: [
    { id: "source", title: "Source", icon: "film", tip: "The file, a subtitle file, and subtitle tracks already inside the video", component: SourcePanel, width: 420, height: 640 },
    { id: "transcription", title: "Transcription", icon: "mic", tip: "Model, spoken language and how the text is split, then generate the subtitles", component: TranscriptionPanel, width: 420, height: 640 },
    { id: "translate", title: "Translate", icon: "languages", tip: "Translate the subtitles into another language with Local Chat", component: TranslatePanel, width: 420, height: 560 },
    { id: "style", title: "Style", icon: "palette", tip: "How the burned-in text looks, and the visuals behind or over the picture", component: StylePanel, drawerWidth: 460, width: 520, height: 720 },
    { id: "export", title: "Export", icon: "download", tip: "Save .srt or .vtt files, add a track to the video or burn the text in", component: ExportPanel, width: 420, height: 720 },
    { id: "cues", title: "Subtitles", icon: "captions", tip: "The list of subtitles to edit", component: CuesPanel, width: 440, height: 760 },
  ],
  preview: { title: "Preview", icon: "monitor-play", tip: "The picture with the current subtitle, in its own window", component: SubtitlesPreview, width: 960, height: 600 },
  useReplica() {
    // Part windows load the lists themselves (never bridged).
    useEffect(() => {
      void useSubtitles.getState().loadStatic();
      void loadSpeechLanguages();
    }, []);
  },
});
