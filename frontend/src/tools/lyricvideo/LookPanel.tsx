/**
 * The Look panel (formerly the Look step's controls): shape and quality, the
 * background, how the words look and the extras. The live approximate preview
 * is the stage. Picks files, so it only opens inline.
 */
import { useEffect, useState } from "react";
import { Banner, Button, ColorSwatchPicker, Icon, Section, SegmentedControl, Select, Switch, cx, toast } from "@/components";
import { FilesService, LyricVideoService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { basename } from "./logic";
import { ASPECTS, IMAGE_EXTS, VIDEO_EXTS, type RememberedLook } from "./options";
import { useLyricVideo } from "./store";
import { designLabel } from "./visuals";
import styles from "./panels.module.css";

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

export default function LookPanel() {
  const prefs = useLyricVideo((s) => s.prefs);
  const hasCover = useLyricVideo((s) => s.hasCover);
  const [fonts, setFonts] = useState<string[]>([]);
  const st = useLyricVideo.getState;
  const look = prefs.look;
  const setLook = (patch: Partial<RememberedLook>) => st().setPrefs((o) => ({ ...o, look: { ...o.look, ...patch } }));

  useEffect(() => {
    let off = false;
    LyricVideoService.Fonts().then((f) => !off && setFonts(f ?? [])).catch(() => undefined);
    return () => {
      off = true;
    };
  }, []);

  const fontOptions = (fonts.includes(look.font) ? fonts : [look.font, ...fonts]).map((f) => ({ value: f, label: f }));
  const needsCover = (look.background === "blur-cover" || look.background === "cover") && !hasCover;
  const visuals = look.background === "visualizer";
  const needsFile = (look.background === "image" || look.background === "video") && !look.backgroundPath;

  const onPickBackground = async (kind: "image" | "video") => {
    try {
      const title = kind === "image" ? "Choose a background image" : "Choose a background video";
      const paths = (await FilesService.PickWith(title, kind === "image" ? IMAGE_EXTS : VIDEO_EXTS, false)) ?? [];
      const path = paths[0];
      if (path) setLook({ backgroundPath: path });
    } catch (e) {
      toast({ title: toAppError(e).message, tone: "danger" });
    }
  };

  return (
    <div className={styles.panel}>
      <Section label="Shape" tip="The proportions and sharpness of the video">
        <div className={styles.form}>
          <SegmentedControl
            aria-label="Aspect"
            value={prefs.aspect}
            options={ASPECTS.map((a) => ({ value: a, label: a, tip: ASPECT_TIP[a] ?? "Video shape " + a }))}
            onChange={(aspect) => st().setPrefs((o) => ({ ...o, aspect }))}
          />
          <SegmentedControl
            aria-label="Quality"
            value={String(prefs.height)}
            options={[
              { value: "720", label: "720p", tip: "Smaller file and faster to render" },
              { value: "1080", label: "1080p", tip: "Full HD; sharper text, slower to render" },
            ]}
            onChange={(v) => st().setPrefs((o) => ({ ...o, height: Number(v) }))}
          />
        </div>
      </Section>

      <Section label="Background" tip="What is behind the words">
        {visuals ? (
          <div className={styles.buttonRow}>
            <span data-testid="visuals-label" data-tip="The animated visuals chosen in the Visuals panel">Visuals: {designLabel(look)}</span>
            <Button size="sm" variant="ghost" onClick={() => st().requestPanel("visuals")} data-tip="Open the Visuals panel to change the design">
              Change
            </Button>
          </div>
        ) : (
          <div className={styles.form}>
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
            {needsCover && (
              <Banner tone="info" title="This song has no cover art">
                The video falls back to a gradient.
              </Banner>
            )}
            {(look.background === "image" || look.background === "video") && (
              <div className={styles.buttonRow}>
                <Button size="sm" variant="secondary" icon="folder-open" data-tip={look.background === "image" ? "Pick a picture to use as the background" : "Pick a video to play behind the words"} onClick={() => void onPickBackground(look.background === "image" ? "image" : "video")}>
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
    </div>
  );
}
