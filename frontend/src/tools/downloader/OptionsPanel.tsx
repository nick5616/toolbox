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
      <Section label="Mode">
        <SegmentedControl
          aria-label="Mode"
          value={options.mode}
          onChange={(mode) => onChange({ mode })}
          options={[
            { value: DownloadMode.ModeAudio, label: "Audio" },
            { value: DownloadMode.ModeVideo, label: "Video" },
          ]}
        />
      </Section>

      {audio ? (
        <Section label="Format">
          <div className={styles.stack}>
            <SegmentedControl
              aria-label="Audio format"
              value={options.audioFormat}
              onChange={(audioFormat) => onChange({ audioFormat })}
              options={[
                { value: AudioFormat.FormatMP3, label: "mp3" },
                { value: AudioFormat.FormatWAV, label: "wav" },
                { value: AudioFormat.FormatFLAC, label: "flac" },
              ]}
            />
            {options.audioFormat === AudioFormat.FormatMP3 && (
              <Field label="Quality">
                {(c) => (
                  <Select {...c} value={options.audioQuality} onChange={(audioQuality) => onChange({ audioQuality })} options={QUALITIES} />
                )}
              </Field>
            )}
          </div>
        </Section>
      ) : (
        <Section label="Max resolution">
          <div className={styles.inline}>
            <Select
              aria-label="Max resolution"
              value={options.maxResolution}
              onChange={(maxResolution) => onChange({ maxResolution })}
              options={RESOLUTIONS}
            />
            <Badge mono>MP4</Badge>
          </div>
        </Section>
      )}

      <Section label="Trim">
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

      <Section label="Embed">
        <div className={styles.stack}>
          <Switch checked={options.embedMetadata} onChange={(embedMetadata) => onChange({ embedMetadata })} label="Metadata" />
          <Switch
            checked={options.embedThumbnail && !(audio && wav)}
            disabled={audio && wav}
            onChange={(embedThumbnail) => onChange({ embedThumbnail })}
            label="Thumbnail"
          />
          {audio && wav && <p className={styles.hint}>Not supported for WAV</p>}
        </div>
      </Section>

      <Section label="Playlist">
        <Switch
          checked={options.playlist}
          onChange={(playlist) => onChange({ playlist })}
          label="Download the whole playlist when a link is a playlist"
        />
      </Section>
    </div>
  );
}
