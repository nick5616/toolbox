import { Badge, Field, SegmentedControl, Section, Select, Switch } from "@/components";
import { AudioFormat, AudioQuality, DownloadMode, MaxResolution, type DownloaderOptions } from "@/lib/api";
import { TrimFields } from "./TrimFields";
import type { TrimErrors } from "./timecode";
import styles from "./OptionsPanel.module.css";

export interface OptionsPanelProps {
  options: DownloaderOptions;
  onChange: (patch: Partial<DownloaderOptions>) => void;
  trimErrors: TrimErrors;
}

const QUALITIES = [
  { value: AudioQuality.QualityBest, label: "Best (V0)" },
  { value: AudioQuality.Quality320, label: "320 kbps" },
  { value: AudioQuality.Quality256, label: "256 kbps" },
  { value: AudioQuality.Quality192, label: "192 kbps" },
  { value: AudioQuality.Quality128, label: "128 kbps" },
];

const RESOLUTIONS = [
  { value: MaxResolution.ResBest, label: "Best" },
  { value: MaxResolution.Res2160, label: "2160p" },
  { value: MaxResolution.Res1440, label: "1440p" },
  { value: MaxResolution.Res1080, label: "1080p" },
  { value: MaxResolution.Res720, label: "720p" },
  { value: MaxResolution.Res480, label: "480p" },
  { value: MaxResolution.Res360, label: "360p" },
];

export function OptionsPanel({ options, onChange, trimErrors }: OptionsPanelProps) {
  const audio = options.mode === DownloadMode.ModeAudio;
  const wav = options.audioFormat === AudioFormat.FormatWAV;
  return (
    <div className={styles.grid}>
      <Section label="Mode" tip="Save just the sound or the full video">
        <SegmentedControl
          aria-label="Mode"
          value={options.mode}
          onChange={(mode) => onChange({ mode })}
          options={[
            { value: DownloadMode.ModeAudio, label: "Audio", tip: "Extract only the sound and save it as an audio file" },
            { value: DownloadMode.ModeVideo, label: "Video", tip: "Save the picture and sound together as an MP4 video" },
          ]}
        />
      </Section>

      {audio ? (
        <Section label="Format" tip="Which audio file type to save">
          <div className={styles.stack}>
            <SegmentedControl
              aria-label="Audio format"
              value={options.audioFormat}
              onChange={(audioFormat) => onChange({ audioFormat })}
              options={[
                { value: AudioFormat.FormatMP3, label: "mp3", tip: "Small lossy files that play everywhere; pick the bitrate under Quality" },
                { value: AudioFormat.FormatWAV, label: "wav", tip: "Uncompressed audio; big files, no embedded thumbnail" },
                { value: AudioFormat.FormatFLAC, label: "flac", tip: "Lossless compressed audio; half the size of WAV" },
              ]}
            />
            {options.audioFormat === AudioFormat.FormatMP3 && (
              <Field label="Quality">
                {(c) => (
                  <Select {...c} data-tip="MP3 bitrate: higher sounds better and makes larger files. Best uses the highest variable quality (V0)" value={options.audioQuality} onChange={(audioQuality) => onChange({ audioQuality })} options={QUALITIES} />
                )}
              </Field>
            )}
          </div>
        </Section>
      ) : (
        <Section label="Max resolution" tip="The tallest picture to download; lower is smaller and faster">
          <div className={styles.inline}>
            <Select
              aria-label="Max resolution"
              data-tip="Largest picture height to fetch. If a video is smaller than this you get its own size"
              value={options.maxResolution}
              onChange={(maxResolution) => onChange({ maxResolution })}
              options={RESOLUTIONS}
            />
            <Badge mono tip="Videos are saved as MP4, which plays almost everywhere">
              MP4
            </Badge>
          </div>
        </Section>
      )}

      <Section label="Trim" tip="Download only a section of each video or track">
        <TrimFields
          enabled={options.trimEnabled}
          start={options.trimStart}
          end={options.trimEnd}
          errors={trimErrors}
          onEnabled={(trimEnabled) => onChange({ trimEnabled })}
          onStart={(trimStart) => onChange({ trimStart })}
          onEnd={(trimEnd) => onChange({ trimEnd })}
        />
      </Section>

      <Section label="Embed" tip="Write extra information into the downloaded file">
        <div className={styles.stack}>
          <Switch
            checked={options.embedMetadata}
            onChange={(embedMetadata) => onChange({ embedMetadata })}
            label="Metadata"
            tip="Store title, artist and date inside the file so players can show them"
          />
          <Switch
            checked={options.embedThumbnail && !(audio && wav)}
            disabled={audio && wav}
            onChange={(embedThumbnail) => onChange({ embedThumbnail })}
            label="Thumbnail"
            tip={audio && wav ? "WAV files cannot hold cover art" : "Store the video thumbnail inside the file as cover art"}
          />
          {audio && wav && (
            <p className={styles.hint} data-tip="WAV is a plain format with no place for cover art">
              Not supported for WAV
            </p>
          )}
        </div>
      </Section>

      <Section label="Playlist" tip="What to do when a link points to a whole playlist">
        <Switch
          checked={options.playlist}
          onChange={(playlist) => onChange({ playlist })}
          label="Download the whole playlist when a link is a playlist"
          tip="Off downloads only the single video in the link; on fetches every item in the playlist"
        />
      </Section>
    </div>
  );
}
