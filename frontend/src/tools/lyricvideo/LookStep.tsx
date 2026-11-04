import type { ReactNode } from "react";
import { Banner, Button, ColorSwatchPicker, Icon, Section, SegmentedControl, Select, Switch, cx } from "@/components";
import { VisualsCanvas } from "@/components/viz";
import type { Analysis } from "@/viz/analysis";
import { basename, type Row } from "./logic";
import { ASPECTS, type Prefs, type RememberedLook, type SongMeta } from "./options";
import { Preview } from "./Preview";
import { aspectNumber, designLabel, previewShow } from "./visuals";
import styles from "./LyricVideoView.module.css";

export interface LookStepProps {
  prefs: Prefs;
  setPrefs: (next: Prefs | ((p: Prefs) => Prefs)) => void;
  meta: SongMeta;
  fonts: string[];
  rows: Row[];
  playheadMs: number;
  coverUrl: string | undefined;
  imageUrl: string | undefined;
  hasCover: boolean;
  player: ReactNode;
  /** The loaded analysis of the song, for the visuals background. */
  analysis: Analysis | null;
  /** Back to the Visuals step. */
  onChangeVisuals: () => void;
  onPickBackground: (kind: "image" | "video") => void;
  onContinue: () => void;
}

const ASPECT_TIP: Record<string, string> = {
  "16:9": "Widescreen, for YouTube and TVs",
  "9:16": "Tall, for Reels, Shorts and TikTok",
  "1:1": "Square, for feed posts",
  "4:5": "Slightly tall, for Instagram feed posts",
};

const BACKGROUND_TIP: Record<string, string> = {
  "blur-cover": "A heavily blurred copy of the cover art fills the picture",
  cover: "The sharp cover art in the middle over a blurred copy of it",
  color: "A single plain colour",
  gradient: "A smooth fade between two colours, top to bottom",
  image: "Your own picture behind the words",
  video: "Your own video looping behind the words",
};

const BACKGROUND_CARDS: Array<{ id: string; label: string; icon: string }> = [
  { id: "blur-cover", label: "Blurred cover", icon: "image" },
  { id: "cover", label: "Cover and blur", icon: "music" },
  { id: "color", label: "Colour", icon: "palette" },
  { id: "gradient", label: "Gradient", icon: "palette" },
  { id: "image", label: "Image", icon: "image" },
  { id: "video", label: "Video", icon: "film" },
];

/** Step 3: aspect, background, text style and a live approximate preview. */
export function LookStep(p: LookStepProps) {
  const { prefs, setPrefs } = p;
  const look = prefs.look;
  const setLook = (patch: Partial<RememberedLook>) => setPrefs((o) => ({ ...o, look: { ...o.look, ...patch } }));
  const fontOptions = (p.fonts.includes(look.font) ? p.fonts : [look.font, ...p.fonts]).map((f) => ({ value: f, label: f }));
  const needsCover = (look.background === "blur-cover" || look.background === "cover") && !p.hasCover;
  const visuals = look.background === "visualizer";
  const show = visuals ? previewShow(look.visuals) : null;
  const needsFile = (look.background === "image" || look.background === "video") && !look.backgroundPath;

  return (
    <div className={styles.lookBody}>
      <div className={styles.lookLeft}>
        <div className={styles.previewBox}>
          <Preview
            look={{ ...look, title: p.meta.title, artist: p.meta.artist }}
            aspect={prefs.aspect}
            rows={p.rows}
            ms={p.playheadMs}
            coverUrl={p.coverUrl}
            imageUrl={p.imageUrl}
            backdropNode={
              visuals && show && p.analysis ? (
                <VisualsCanvas show={show} analysis={p.analysis} timeMs={p.playheadMs} aspect={aspectNumber(prefs.aspect)} mode="opaque" cover={p.coverUrl ?? null} />
              ) : undefined
            }
          />
        </div>
        <div className={styles.hint} data-tip="This preview is drawn quickly in the window; the render preview is exact">Preview is approximate — Render preview shows the exact result.</div>
        {p.player}
      </div>

      <div className={styles.lookRight}>
        <Section label="Shape" tip="The proportions and sharpness of the video">
          <div className={styles.form}>
            <SegmentedControl
              aria-label="Aspect"
              value={prefs.aspect}
              options={ASPECTS.map((a) => ({ value: a, label: a, tip: ASPECT_TIP[a] ?? "Video shape " + a }))}
              onChange={(aspect) => setPrefs((o) => ({ ...o, aspect }))}
            />
            <SegmentedControl
              aria-label="Quality"
              value={String(prefs.height)}
              options={[
                { value: "720", label: "720p", tip: "Smaller file and faster to render" },
                { value: "1080", label: "1080p", tip: "Full HD; sharper text, slower to render" },
              ]}
              onChange={(v) => setPrefs((o) => ({ ...o, height: Number(v) }))}
            />
          </div>
        </Section>

        <Section label="Background" tip="What is behind the words">
          {visuals && (
            <div className={styles.buttonRow}>
              <span data-testid="visuals-label" data-tip="The animated visuals chosen in the Visuals step">Visuals: {designLabel(look)}</span>
              <Button size="sm" variant="ghost" onClick={p.onChangeVisuals} data-tip="Go back to the Visuals step to change the design">
                Change
              </Button>
            </div>
          )}
          {!visuals && (
            <div className={styles.bgGrid} role="radiogroup" aria-label="Background" data-tip="Choose what is behind the words">
              {BACKGROUND_CARDS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={look.background === c.id}
                  data-tip={BACKGROUND_TIP[c.id] ?? c.label}
                  className={cx(styles.bgCard, look.background === c.id && styles.bgCardOn)}
                  onClick={() => setLook({ background: c.id })}
                >
                  <Icon name={c.icon} size={16} />
                  {c.label}
                </button>
              ))}
            </div>
          )}
          {needsCover && (
            <Banner tone="info" title="This song has no cover art">
              The video falls back to a gradient.
            </Banner>
          )}
          {(look.background === "image" || look.background === "video") && (
            <div className={styles.buttonRow}>
              <Button size="sm" variant="secondary" icon="folder-open" data-tip={look.background === "image" ? "Pick a picture to use as the background" : "Pick a video to play behind the words"} onClick={() => p.onPickBackground(look.background === "image" ? "image" : "video")}>
                {look.backgroundPath ? "Change…" : look.background === "image" ? "Choose an image…" : "Choose a video…"}
              </Button>
              <span className={styles.muted}>{look.backgroundPath ? basename(look.backgroundPath) : "Nothing chosen yet"}</span>
            </div>
          )}
          {needsFile && <div className={styles.warnText}>Choose a file to use this background.</div>}
          {(look.background === "color" || look.background === "gradient") && (
            <div className={styles.form}>
              <div className={styles.field}>
                <span className={styles.fieldLabel} data-tip="White, black or any #rrggbb colour">{look.background === "gradient" ? "Top colour" : "Colour"}</span>
                <ColorSwatchPicker aria-label="Background colour" value={look.color1} onChange={(color1) => setLook({ color1 })} />
              </div>
              {look.background === "gradient" && (
                <div className={styles.field}>
                  <span className={styles.fieldLabel} data-tip="The colour the gradient fades to at the bottom">Bottom colour</span>
                  <ColorSwatchPicker aria-label="Gradient bottom colour" value={look.color2} onChange={(color2) => setLook({ color2 })} />
                </div>
              )}
            </div>
          )}
        </Section>

        <Section label="Text" tip="How the lyrics look on screen">
          <div className={styles.form}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Font</span>
              <Select aria-label="Font" data-tip="The typeface for the lyrics" value={look.font} options={fontOptions} onChange={(font) => setLook({ font })} />
            </label>
            <div className={styles.field}>
              <span className={styles.fieldLabel} data-tip="Colour of the lyrics; white, black or any #rrggbb">Text colour</span>
              <ColorSwatchPicker aria-label="Text colour" value={look.textColor} onChange={(textColor) => setLook({ textColor })} />
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel} data-tip="Colour of the word being sung when Karaoke fill is on">Highlight colour</span>
              <ColorSwatchPicker aria-label="Highlight colour" value={look.highlightColor} onChange={(highlightColor) => setLook({ highlightColor })} />
            </div>
            <Switch tip="Fill each word with the highlight colour as it is sung" checked={look.karaoke} onChange={(karaoke) => setLook({ karaoke })} label="Karaoke fill" />
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Position</span>
              <SegmentedControl
                aria-label="Position"
                value={look.position}
                options={[
                  { value: "center", label: "Centre", tip: "Put the lyrics in the middle of the picture" },
                  { value: "lower", label: "Lower", tip: "Put the lyrics near the bottom, like subtitles" },
                ]}
                onChange={(position) => setLook({ position })}
              />
            </div>
            <Switch tip="Also show the upcoming line, dimmed, so viewers can read ahead" checked={look.showNext} onChange={(showNext) => setLook({ showNext })} label="Show next line" />
          </div>
        </Section>

        <Section label="Extras" tip="Optional additions to the video">
          <div className={styles.form}>
            {!visuals && (
              <div className={styles.field}>
                <span className={styles.fieldLabel} data-tip="A simple moving graphic that follows the sound">Visualiser</span>
                <SegmentedControl
                  aria-label="Visualiser"
                  value={look.visualizer}
                  options={[
                    { value: "none", label: "None", tip: "No audio visualiser" },
                    { value: "wave", label: "Wave", tip: "A moving waveform of the sound along the bottom" },
                    { value: "bars", label: "Bars", tip: "Spectrum bars that jump with the sound" },
                  ]}
                  onChange={(visualizer) => setLook({ visualizer })}
                />
              </div>
            )}
            <Switch tip="Open the video with a card showing the song title and artist" checked={look.titleCard} onChange={(titleCard) => setLook({ titleCard })} label="Title card" />
          </div>
        </Section>

        <div className={styles.footer}>
          <Button onClick={p.onContinue} data-tip="Go on to preview and render the video">Continue to Render</Button>
        </div>
      </div>
    </div>
  );
}
