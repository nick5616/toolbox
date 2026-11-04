import { Button, Section, SegmentedControl, Stepper } from "@/components";
import { SpeechOptions } from "@/blocks/speech";
import { RunStatus } from "./RunStatus";
import { useRun } from "./runs";
import { speechOf, splitSummary } from "./options";
import { useSubtitles } from "./store";
import styles from "./SubtitlesView.module.css";

/** Transcription panel: the speech block, how the text is split, Generate and its status. */
export function TranscriptionPanel() {
  const prefs = useSubtitles((s) => s.prefs);
  const patchPrefs = useSubtitles((s) => s.patchPrefs);
  const spoken = useSubtitles((s) => s.spoken);
  const mediaPath = useSubtitles((s) => s.mediaPath);
  const mediaStatus = useSubtitles((s) => s.media.status);
  const generate = useSubtitles((s) => s.generate);
  const hasCues = useSubtitles((s) => s.editor.tabs.length > 0);
  const gen = useRun("gen");
  const extract = useRun("extract");
  const busy = gen.busy || extract.busy;
  const disabled = !mediaPath || busy || mediaStatus === "error";

  return (
    <div className={styles.panel}>
      <Section label="Speech" tip="Listen to the audio on your computer and write out what is said, with timing">
        <SpeechOptions
          value={speechOf(prefs)}
          languages={spoken}
          onChange={(p) =>
            patchPrefs({
              ...(p.model !== undefined ? { model: p.model } : {}),
              ...(p.language !== undefined ? { language: p.language } : {}),
              ...(p.translate !== undefined ? { translateToEnglish: p.translate } : {}),
            })
          }
        />
      </Section>
      <Section label="Subtitle text" tip={`How the text is split into subtitles (${splitSummary(prefs)})`}>
        <div className={styles.drawerForm}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Characters per line</span>
            <Stepper
              aria-label="Characters per line"
              data-tip="The most characters on one line before it wraps; 32 to 60"
              value={prefs.maxLineChars}
              min={32}
              max={60}
              onChange={(maxLineChars) => patchPrefs({ maxLineChars })}
            />
          </label>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Lines</span>
            <SegmentedControl
              aria-label="Lines per subtitle"
              data-tip="How many lines one subtitle may have on screen"
              value={String(prefs.maxLines)}
              options={[
                { value: "1", label: "1", tip: "One line per subtitle; shorter, quicker to read" },
                { value: "2", label: "2", tip: "Up to two lines per subtitle, the usual style" },
              ]}
              onChange={(v) => patchPrefs({ maxLines: Number(v) })}
            />
          </div>
        </div>
      </Section>
      <div>
        <Button
          icon="captions"
          onClick={generate}
          loading={gen.busy}
          disabled={disabled}
          data-tip={!mediaPath ? "Choose a video or audio file first" : mediaStatus === "error" ? "The file couldn't be read" : busy ? "Wait for the current task to finish" : "Listen to the speech and write subtitles for it"}
        >
          {hasCues ? "Regenerate subtitles" : "Generate subtitles"}
        </Button>
      </div>
      <RunStatus run={gen} runningLabel="Listening for speech…" showResult={false} />
    </div>
  );
}
