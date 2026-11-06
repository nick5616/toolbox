import { Badge, Button, Field, Icon, SegmentedControl, Select, Switch, TextArea, cx, toast } from "@/components";
import type { PostIssue, PostLimits, PostSlide } from "@/lib/api";
import { CAROUSEL_ASPECTS, FORMAT_LABELS, FORMAT_TIPS, aspectFor, captionStats, countChars, type PostDoc, type PostFormat } from "./logic";
import styles from "./SidePanel.module.css";

const FORMAT_OPTIONS = (Object.keys(FORMAT_LABELS) as PostFormat[]).map((value) => ({ value, label: FORMAT_LABELS[value], tip: FORMAT_TIPS[value] }));

export async function copyText(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast({ title: done, tone: "success" });
  } catch {
    toast({ title: "Couldn't copy to the clipboard", tone: "danger" });
  }
}

export interface ShapePanelProps {
  doc: PostDoc;
  onChange: (patch: Partial<Pick<PostDoc, "format" | "aspect" | "keepLocation">>) => void;
}

export function ShapePanel({ doc, onChange }: ShapePanelProps) {
  return (
    <section className={styles.section} aria-label="Format" data-tip="What kind of post this is and its shape">
      <Field label="Format">
        <SegmentedControl
          size="sm"
          value={doc.format as PostFormat}
          onChange={(format) => onChange({ format, aspect: aspectFor(format, doc.aspect) })}
          options={FORMAT_OPTIONS}
          aria-label="Format"
          fullWidth
        />
      </Field>
      {doc.format === "carousel" ? (
        <Field label="Shape" hint="Changing the shape keeps each slide's pan and zoom.">
          {(c) => (
            <Select
              id={c.id}
              data-tip="Frame shape for every slide: 4:5 portrait is the tallest feed shape, 1:1 square, 1.91:1 landscape"
              size="sm"
              value={doc.aspect}
              onChange={(aspect) => onChange({ aspect })}
              options={CAROUSEL_ASPECTS.map((a) => ({ value: a.value, label: a.label }))}
            />
          )}
        </Field>
      ) : (
        <p className={styles.hint} data-tip="Reels and stories always use this vertical size">9:16 (1080 × 1920)</p>
      )}
      <Switch checked={doc.keepLocation} onChange={(keepLocation) => onChange({ keepLocation })} label="Keep location and other metadata" tip="Off by default: exports strip GPS location and camera details from your photos" />
    </section>
  );
}

export interface CaptionPanelProps {
  caption: string;
  limits: PostLimits;
  onChange: (caption: string) => void;
}

export function CaptionPanel({ caption, limits, onChange }: CaptionPanelProps) {
  const st = captionStats(caption, limits);
  return (
    <section className={styles.section} aria-label="Caption">
      <div className={styles.rowHead}>
        <h3 className={styles.h} data-tip="The text under the post on Instagram">Caption</h3>
        <Button size="sm" variant="ghost" icon="copy" data-tip={caption ? "Copy the caption to paste into Instagram" : "Write a caption first"} disabled={!caption} onClick={() => void copyText(caption, "Caption copied")}>
          Copy
        </Button>
      </div>
      <TextArea aria-label="Caption" data-tip="Hashtags and @mentions count toward Instagram's limits shown below" value={caption} minRows={4} maxRows={10} invalid={st.left < 0} onChange={(e) => onChange(e.target.value)} placeholder="Write a caption…" />
      <div className={styles.counters}>
        <span className={cx(styles.counter, st.left < 0 && styles.over)} data-testid="chars-left" data-tip="Instagram allows a limited number of characters in a caption">
          {st.left.toLocaleString("en-US")} characters left
        </span>
        <span className={cx(styles.counter, st.hashtags > limits.maxHashtags && styles.over)} data-testid="hashtags" data-tip="Hashtags used / the most Instagram allows">
          {st.hashtags}/{limits.maxHashtags} hashtags
        </span>
        <span className={cx(styles.counter, st.mentions > limits.maxMentions && styles.over)} data-testid="mentions" data-tip="People tagged with @ in the caption">
          {st.mentions} {st.mentions === 1 ? "mention" : "mentions"}
        </span>
      </div>
    </section>
  );
}

export interface AltPanelProps {
  slide: PostSlide | undefined;
  index: number;
  limits: PostLimits;
  onChange: (altText: string) => void;
}

export function AltPanel({ slide, index, limits, onChange }: AltPanelProps) {
  const n = slide ? countChars(slide.altText) : 0;
  return (
    <section className={styles.section} aria-label="Alt text">
      <div className={styles.rowHead}>
        <h3 className={styles.h} data-tip="A description of the picture for screen readers and when images fail to load">{slide ? `Slide ${index + 1}` : "No slide selected"}</h3>
        <span className={cx(styles.counter, n > limits.maxAltTextChars && styles.over)} data-tip="Characters used / the most Instagram allows for alt text">
          {n}/{limits.maxAltTextChars}
        </span>
      </div>
      <TextArea
        aria-label="Alt text"
        data-tip={slide ? "Describe what is in this slide for people who can't see it" : "Select a slide to write its alt text"}
        value={slide?.altText ?? ""}
        disabled={!slide}
        minRows={2}
        maxRows={5}
        invalid={n > limits.maxAltTextChars}
        placeholder="Describe the picture for people who can't see it"
        onChange={(e) => onChange(e.target.value)}
      />
    </section>
  );
}

const LEVEL_ICON: Record<string, string> = { error: "circle-alert", warning: "triangle-alert", note: "info" };

export interface ChecksPanelProps {
  issues: PostIssue[];
  slides: PostSlide[];
  onSelect: (slideId: string) => void;
}

export function ChecksPanel({ issues, slides, onSelect }: ChecksPanelProps) {
  const errors = issues.filter((i) => i.level === "error").length;
  return (
    <section className={styles.section} aria-label="Checks">
      <div className={styles.rowHead}>
        <span className={styles.hint}>{issues.length === 0 ? "Nothing to fix." : "Problems that would stop Instagram accepting the post, or make it look wrong."}</span>
        {issues.length === 0 ? <Badge tone="ok" tip="Nothing to fix; the post is ready to export">All clear</Badge> : errors > 0 ? <Badge tone="danger" mono tip="Errors must be fixed before you can export">{errors} to fix</Badge> : <Badge tone="warn" mono tip="Warnings and notes; you can still export">{issues.length}</Badge>}
      </div>
      {issues.length > 0 && (
        <ul className={styles.issues}>
          {issues.map((i, n) => {
            const idx = slides.findIndex((s) => s.id === i.slideId);
            const body = (
              <>
                <Icon name={LEVEL_ICON[i.level] ?? "info"} size={14} className={cx(styles.issueIcon, styles[i.level])} />
                <span className={styles.issueText}>
                  {idx >= 0 && <strong>Slide {idx + 1}: </strong>}
                  {i.message}
                </span>
              </>
            );
            return (
              <li key={`${n}-${i.slideId}-${i.message}`}>
                {idx >= 0 ? (
                  <button type="button" className={cx(styles.issue, styles.issueButton)} data-tip="Go to this slide" onClick={() => onSelect(i.slideId)}>
                    {body}
                  </button>
                ) : (
                  <div className={styles.issue}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
