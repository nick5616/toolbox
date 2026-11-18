import { useMemo } from "react";
import { Banner, Button, Section, Select, cx } from "@/components";
import { parseShow } from "@/components/viz/pickerModel";
import { useBlocker, useRows } from "./hooks";
import { RunStatus } from "./RunStatus";
import { useRun } from "./runs";
import { useSubtitles } from "./store";
import { defaultVisuals } from "./visuals";
import { MediaFromLibraryButton } from "./library";
import styles from "./SubtitlesView.module.css";

/** Export panel: save .srt/.vtt files, add a subtitle track to a copy of the video, or burn the text into the picture. */
export function ExportPanel() {
  const prefs = useSubtitles((s) => s.prefs);
  const patchPrefs = useSubtitles((s) => s.patchPrefs);
  const languages = useSubtitles((s) => s.languages);
  const media = useSubtitles((s) => s.media);
  const mediaPath = useSubtitles((s) => s.mediaPath);
  const chosen = useSubtitles((s) => s.chosen);
  const addVisuals = useSubtitles((s) => s.addVisuals);
  const save = useSubtitles((s) => s.save);
  const embed = useSubtitles((s) => s.embed);
  const burn = useSubtitles((s) => s.burn);
  const pickMedia = useSubtitles((s) => s.pickMedia);
  const rows = useRows();
  const blocker = useBlocker();
  const saveRun = useRun("save");
  const embedRun = useRun("embed");
  const burnRun = useRun("burn");
  const cueCount = rows.length;

  const isAudio = media.status === "ready" && !media.isVideo;
  const needVideo = mediaPath === null || isAudio; // a track needs a picture to ride with
  const anyBusy = saveRun.busy || burnRun.busy || embedRun.busy;
  const visuals = useMemo(() => chosen ?? defaultVisuals(media.isVideo ? "overlay" : "background"), [chosen, media.isVideo]);
  const visualized = isAudio ? prefs.background === "visualizer" : addVisuals;
  const needsImage = isAudio && prefs.background === "image" && !prefs.backgroundPath;
  const visualsMissing = visualized && (!visuals || !parseShow(visuals.showJson));
  const formats = prefs.formats;
  const langOptions = [{ value: "", label: "Not set" }, ...languages.map((l) => ({ value: l.code, label: l.name }))];
  const toggleFormat = (f: string) => {
    const next = formats.includes(f) ? formats.filter((x) => x !== f) : [...formats, f];
    if (next.length > 0) patchPrefs({ formats: next });
  };

  return (
    <div className={styles.panel}>
      {blocker && (
        <Banner tone="warn" title="Fix this before exporting">
          {blocker}
        </Banner>
      )}

      <Section label="Save as a file" tip="Write the subtitles to .srt or .vtt files in your Library">
        <div className={styles.form}>
          <div className={styles.field}>
            <span className={styles.fieldLabel} data-tip="Pick one or both; at least one stays on">Formats</span>
            <div className={styles.chips} role="group" aria-label="Formats">
              {["srt", "vtt"].map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={formats.includes(f)}
                  data-tip={f === "srt" ? "SubRip: the most widely supported subtitle format" : "WebVTT: the format used by web video players"}
                  className={cx(styles.chip, formats.includes(f) && styles.chipOn)}
                  onClick={() => toggleFormat(f)}
                >
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div>
            <Button
              icon="check"
              loading={saveRun.busy}
              disabled={blocker !== null || cueCount === 0 || anyBusy}
              data-tip={blocker ?? (cueCount === 0 ? "There are no subtitles to save" : anyBusy ? "Wait for the current task to finish" : "Save the subtitles in the chosen formats")}
              onClick={() => save()}
            >
              Save {formats.map((f) => f.toUpperCase()).join(" + ")}
            </Button>
          </div>
          <RunStatus run={saveRun} runningLabel="Saving…" doneLabel="Saved" />
        </div>
      </Section>

      <Section label="Add as a track" tip="Put the subtitles inside a copy of the video as a track the player can switch on or off">
        <div className={styles.form}>
          {needVideo ? (
            <div className={styles.buttonRow}>
              <Button variant="secondary" icon="film" onClick={() => void pickMedia()} data-tip="A track needs a video to ride with; choose one">
                Pick the video
              </Button>
              <MediaFromLibraryButton />
            </div>
          ) : (
            <>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Track language</span>
                <Select aria-label="Track language" data-tip="The language label stored with the track so players can show it" value={prefs.trackLanguage} options={langOptions} onChange={(trackLanguage) => patchPrefs({ trackLanguage })} />
              </label>
              <div>
                <Button
                  icon="captions"
                  loading={embedRun.busy}
                  disabled={blocker !== null || cueCount === 0 || anyBusy || media.status === "error"}
                  data-tip={blocker ?? (cueCount === 0 ? "There are no subtitles to add" : anyBusy ? "Wait for the current task to finish" : media.status === "error" ? "The video couldn't be read" : "Copy the video with the subtitles added as a switchable track; the picture is not re-encoded")}
                  onClick={embed}
                >
                  Add subtitle track
                </Button>
              </div>
            </>
          )}
          <RunStatus run={embedRun} runningLabel="Adding the track…" doneLabel="Track added" />
        </div>
      </Section>

      <Section label={isAudio ? "Make a video" : "Burn into the video"} tip={isAudio ? "Turn the audio into a video with the subtitles drawn on a background (set its look in Style)" : "Draw the subtitles into the picture so they show everywhere; the video is re-encoded (set the look in Style)"}>
        <div className={styles.form}>
          {mediaPath === null ? (
            <>
              <div className={styles.muted}>Burning draws the text into the picture. It needs the video, or an audio file to make a video from.</div>
              <Button variant="secondary" icon="film" onClick={() => void pickMedia()} data-tip="Choose the video or audio file to draw the subtitles on">
                Pick the video
              </Button>
              <MediaFromLibraryButton />
            </>
          ) : (
            <Button
              icon="film"
              loading={burnRun.busy}
              disabled={blocker !== null || cueCount === 0 || anyBusy || media.status === "error" || needsImage || visualsMissing}
              data-tip={
                blocker ??
                (cueCount === 0
                  ? "There are no subtitles to draw"
                  : anyBusy
                    ? "Wait for the current task to finish"
                    : media.status === "error"
                      ? "The file couldn't be read"
                      : needsImage
                        ? "Choose a background image in Style first"
                        : visualsMissing
                          ? "Choose the visuals in Style first"
                          : isAudio
                            ? "Render a video from the audio with the subtitles drawn on the chosen background"
                            : "Render a copy of the video with the subtitles drawn into the picture")
              }
              onClick={burn}
            >
              {isAudio ? "Make a video" : "Burn into the video"}
            </Button>
          )}
          <RunStatus run={burnRun} runningLabel={isAudio ? "Making the video…" : "Burning subtitles…"} doneLabel="Video ready" />
        </div>
      </Section>
    </div>
  );
}
