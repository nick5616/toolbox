import type { ReactNode } from "react";
import { Banner, Button, ColorSwatchPicker, Icon, Section, SegmentedControl, Select, Switch, cx } from "@/components";
import { basename, type Row } from "./logic";
import { ASPECTS, type Prefs, type RememberedLook, type SongMeta } from "./options";
import { Preview } from "./Preview";
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
  onPickBackground: (kind: "image" | "video") => void;
  onContinue: () => void;
}

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
          />
        </div>
        <div className={styles.hint}>Preview is approximate — Render preview shows the exact result.</div>
        {p.player}
      </div>

      <div className={styles.lookRight}>
        <Section label="Shape">
          <div className={styles.form}>
            <SegmentedControl
              aria-label="Aspect"
              value={prefs.aspect}
              options={ASPECTS.map((a) => ({ value: a, label: a }))}
              onChange={(aspect) => setPrefs((o) => ({ ...o, aspect }))}
            />
            <SegmentedControl
              aria-label="Quality"
              value={String(prefs.height)}
              options={[
                { value: "720", label: "720p" },
                { value: "1080", label: "1080p" },
              ]}
              onChange={(v) => setPrefs((o) => ({ ...o, height: Number(v) }))}
            />
          </div>
        </Section>

        <Section label="Background">
          <div className={styles.bgGrid} role="radiogroup" aria-label="Background">
            {BACKGROUND_CARDS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={look.background === c.id}
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
              <Button size="sm" variant="secondary" icon="folder-open" onClick={() => p.onPickBackground(look.background === "image" ? "image" : "video")}>
                {look.backgroundPath ? "Change…" : look.background === "image" ? "Choose an image…" : "Choose a video…"}
              </Button>
              <span className={styles.muted}>{look.backgroundPath ? basename(look.backgroundPath) : "Nothing chosen yet"}</span>
            </div>
          )}
          {needsFile && <div className={styles.warnText}>Choose a file to use this background.</div>}
          {(look.background === "color" || look.background === "gradient") && (
            <div className={styles.form}>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>{look.background === "gradient" ? "Top colour" : "Colour"}</span>
                <ColorSwatchPicker aria-label="Background colour" value={look.color1} onChange={(color1) => setLook({ color1 })} />
              </div>
              {look.background === "gradient" && (
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>Bottom colour</span>
                  <ColorSwatchPicker aria-label="Gradient bottom colour" value={look.color2} onChange={(color2) => setLook({ color2 })} />
                </div>
              )}
            </div>
          )}
        </Section>

        <Section label="Text">
          <div className={styles.form}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Font</span>
              <Select aria-label="Font" value={look.font} options={fontOptions} onChange={(font) => setLook({ font })} />
            </label>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Text colour</span>
              <ColorSwatchPicker aria-label="Text colour" value={look.textColor} onChange={(textColor) => setLook({ textColor })} />
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Highlight colour</span>
              <ColorSwatchPicker aria-label="Highlight colour" value={look.highlightColor} onChange={(highlightColor) => setLook({ highlightColor })} />
            </div>
            <Switch checked={look.karaoke} onChange={(karaoke) => setLook({ karaoke })} label="Karaoke fill" />
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Position</span>
              <SegmentedControl
                aria-label="Position"
                value={look.position}
                options={[
                  { value: "center", label: "Centre" },
                  { value: "lower", label: "Lower" },
                ]}
                onChange={(position) => setLook({ position })}
              />
            </div>
            <Switch checked={look.showNext} onChange={(showNext) => setLook({ showNext })} label="Show next line" />
          </div>
        </Section>

        <Section label="Extras">
          <div className={styles.form}>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Visualiser</span>
              <SegmentedControl
                aria-label="Visualiser"
                value={look.visualizer}
                options={[
                  { value: "none", label: "None" },
                  { value: "wave", label: "Wave" },
                  { value: "bars", label: "Bars" },
                ]}
                onChange={(visualizer) => setLook({ visualizer })}
              />
            </div>
            <Switch checked={look.titleCard} onChange={(titleCard) => setLook({ titleCard })} label="Title card" />
          </div>
        </Section>

        <div className={styles.footer}>
          <Button onClick={p.onContinue}>Continue to Render</Button>
        </div>
      </div>
    </div>
  );
}
