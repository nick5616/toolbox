import { useEffect, useRef, useState } from "react";
import { Banner, Button, Section, SegmentedControl, Select, cx } from "@/components";
import type { MediaSourceState } from "@/components/media";
import { MediaService, type SubtitleLanguage, type SubtitleStyleInfo } from "@/lib/api";
import type { EditorTab } from "./editor";
import { TabBar } from "./EditStep";
import { CueOverlay } from "./CueOverlay";
import { POSITION_CHOICES, SIZE_CHOICES, type Prefs } from "./options";
import { RunStatus } from "./RunStatus";
import type { JobRun } from "./useJobRun";
import styles from "./SubtitlesView.module.css";

const SAMPLE = "The quick brown fox\njumps over the lazy dog";

function useStill(path: string | null, ms: number, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path || !enabled) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    MediaService.Frame(path, Math.max(0, Math.round(ms)), 640)
      .then((u) => !cancelled && setUrl(u))
      .catch(() => !cancelled && setUrl(null));
    return () => {
      cancelled = true;
    };
  }, [path, ms, enabled]);
  return url;
}

function StyleCard({
  info,
  selected,
  still,
  aspect,
  text,
  prefs,
  onSelect,
}: {
  info: SubtitleStyleInfo;
  selected: boolean;
  still: string | null;
  aspect: number;
  text: string;
  prefs: Prefs;
  onSelect: () => void;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <button type="button" role="radio" aria-checked={selected} className={cx(styles.styleCard, selected && styles.styleOn)} onClick={onSelect}>
      <span ref={box} className={styles.still} style={{ aspectRatio: String(aspect) }}>
        {still && <img src={still} alt="" className={styles.stillImg} />}
        <CueOverlay
          rect={{ left: 0, top: 0, width: size.w, height: size.h }}
          text={text}
          style={info.id}
          size={prefs.size}
          position={prefs.position}
          font={prefs.font}
        />
      </span>
      <span className={styles.styleLabel}>{info.label}</span>
    </button>
  );
}

export interface ExportStepProps {
  tabs: EditorTab[];
  activeId: string;
  onSelectTab: (id: string) => void;
  cueCount: number;
  /** Text to show on the style previews (the cue at the playhead). */
  sampleText: string;
  playheadMs: number;
  blocker: string | null;
  prefs: Prefs;
  setPrefs: (next: Prefs | ((p: Prefs) => Prefs)) => void;
  styleInfos: SubtitleStyleInfo[];
  fonts: string[];
  languages: SubtitleLanguage[];
  mediaPath: string | null;
  media: MediaSourceState;
  save: JobRun;
  burn: JobRun;
  embed: JobRun;
  onSave: () => void;
  onBurn: () => void;
  onEmbed: () => void;
  onPickMedia: () => void;
}

/** Step 4: save files, add a track, or burn into the picture. */
export function ExportStep(p: ExportStepProps) {
  const info = p.media.source?.info;
  const hasVideo = !!info?.video;
  const aspect = info?.video && info.video.height > 0 ? info.video.width / info.video.height : 16 / 9;
  const still = useStill(p.mediaPath, p.playheadMs, hasVideo);
  const formats = p.prefs.formats;
  const toggleFormat = (f: string) =>
    p.setPrefs((o) => {
      const has = o.formats.includes(f);
      const next = has ? o.formats.filter((x) => x !== f) : [...o.formats, f];
      return next.length === 0 ? o : { ...o, formats: next };
    });
  const needVideo = p.mediaPath === null || (p.media.status === "ready" && !hasVideo);
  const anyBusy = p.save.busy || p.burn.busy || p.embed.busy;
  const fontOptions = Array.from(new Set([p.prefs.font, ...p.fonts])).map((f) => ({ value: f, label: f }));
  const langOptions = [{ value: "", label: "Not set" }, ...p.languages.map((l) => ({ value: l.code, label: l.name }))];
  const text = p.sampleText || SAMPLE;

  return (
    <div className={styles.sourceBody}>
      <TabBar tabs={p.tabs} activeId={p.activeId} onSelect={p.onSelectTab} />
      {p.blocker && (
        <Banner tone="warn" title="Fix this before exporting">
          {p.blocker}
        </Banner>
      )}

      <Section label="Save as a file">
        <div className={styles.form}>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Formats</span>
            <div className={styles.chips} role="group" aria-label="Formats">
              {["srt", "vtt"].map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={formats.includes(f)}
                  className={cx(styles.chip, formats.includes(f) && styles.chipOn)}
                  onClick={() => toggleFormat(f)}
                >
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div>
            <Button icon="check" loading={p.save.busy} disabled={p.blocker !== null || p.cueCount === 0 || anyBusy} onClick={p.onSave}>
              Save {formats.map((f) => f.toUpperCase()).join(" + ")}
            </Button>
          </div>
          <RunStatus run={p.save} runningLabel="Saving…" doneLabel="Saved" />
        </div>
      </Section>

      <Section label="Add as a track">
        <div className={styles.form}>
          <div className={styles.muted}>
            No quality loss: the video is copied as is, and the player can turn the subtitles on or off.
          </div>
          {needVideo ? (
            <Button variant="secondary" icon="film" onClick={p.onPickMedia}>
              Pick the video
            </Button>
          ) : (
            <>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Track language</span>
                <Select
                  aria-label="Track language"
                  value={p.prefs.trackLanguage}
                  options={langOptions}
                  onChange={(trackLanguage) => p.setPrefs((o) => ({ ...o, trackLanguage }))}
                />
              </label>
              <div>
                <Button icon="captions" loading={p.embed.busy} disabled={p.blocker !== null || p.cueCount === 0 || anyBusy || p.media.status === "error"} onClick={p.onEmbed}>
                  Add subtitle track
                </Button>
              </div>
            </>
          )}
          <RunStatus run={p.embed} runningLabel="Adding the track…" doneLabel="Track added" />
        </div>
      </Section>

      <Section label="Burn into the video">
        <div className={styles.form}>
          {needVideo ? (
            <>
              <div className={styles.muted}>Burning draws the text into the picture. It needs the video.</div>
              <div>
                <Button variant="secondary" icon="film" onClick={p.onPickMedia}>
                  Pick the video
                </Button>
              </div>
            </>
          ) : (
            <>
              <div role="radiogroup" aria-label="Style" className={styles.styleCards}>
                {p.styleInfos.map((s) => (
                  <StyleCard
                    key={s.id}
                    info={s}
                    selected={p.prefs.style === s.id}
                    still={still}
                    aspect={aspect}
                    text={text}
                    prefs={p.prefs}
                    onSelect={() => p.setPrefs((o) => ({ ...o, style: s.id }))}
                  />
                ))}
              </div>
              <div className={styles.inlineFields}>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Size</span>
                  <SegmentedControl
                    aria-label="Size"
                    value={p.prefs.size}
                    options={SIZE_CHOICES}
                    onChange={(size) => p.setPrefs((o) => ({ ...o, size }))}
                  />
                </div>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Position</span>
                  <SegmentedControl
                    aria-label="Position"
                    value={p.prefs.position}
                    options={POSITION_CHOICES}
                    onChange={(position) => p.setPrefs((o) => ({ ...o, position }))}
                  />
                </div>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Font</span>
                  <Select aria-label="Font" value={p.prefs.font} options={fontOptions} onChange={(font) => p.setPrefs((o) => ({ ...o, font }))} />
                </label>
              </div>
              <div>
                <Button icon="film" loading={p.burn.busy} disabled={p.blocker !== null || p.cueCount === 0 || anyBusy || p.media.status === "error"} onClick={p.onBurn}>
                  Burn into the video
                </Button>
              </div>
            </>
          )}
          <RunStatus run={p.burn} runningLabel="Burning subtitles…" doneLabel="Video ready" />
        </div>
      </Section>
    </div>
  );
}
