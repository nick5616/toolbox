/** The Inspector section of a text clip: the words, their style, quick styles and how they appear (§23.6). */
import { useEffect, useMemo, useState } from "react";
import { Button, SegmentedControl, Section, Select, Slider, TextArea, toast } from "@/components";
import { TextStyleEditor } from "@/components/viz/TextStyleEditor";
import { MAX_TEXT_CLIP_SIZE } from "@/viz/edit/schema";
import { EditStudioService, type EditClip } from "@/lib/api";
import { MAX_CLIP_TEXT, parseTextClip, serializeTextClip } from "@/viz/edit/schema";
import { MARKER_LANES, type MarkerLane, type TextClip } from "@/viz/edit/types";
import type { TextStyle } from "@/viz/types";
import { useEditStudio } from "../store";
import { currentClip, editDoc, patchClip } from "../inspector/inspectorState";
import { QUICK_STYLES, textThroughVideo } from "./textOps";
import styles from "./text.module.css";

let fontsCache: Promise<string[]> | null = null;
function loadFonts(): Promise<string[]> {
  fontsCache ??= EditStudioService.Fonts().then(
    (f) => f ?? [],
    () => {
      fontsCache = null;
      return [];
    },
  );
  return fontsCache;
}

const QUICK_TIPS: Record<string, string> = {
  "big-punch": "Huge bold capitals with a thick outline, centred",
  glow: "Add a soft glow around the letters",
  typewriter: "Letters appear one at a time like typing",
  subtitle: "Small bold text near the bottom, like a subtitle",
  outline: "Thick outlined capitals that fade in softly",
};

export function TextSection({ clip }: { clip: EditClip }) {
  const [fonts, setFonts] = useState<string[]>([]);
  useEffect(() => {
    let off = false;
    void loadFonts().then((f) => !off && setFonts(f));
    return () => {
      off = true;
    };
  }, []);
  const t = useMemo(() => parseTextClip(clip.text).value, [clip.text]);
  const id = clip.id;

  /** Applies `fn` to the clip's text as it is now (no stale closures while typing). */
  const edit = (fn: (t: TextClip) => TextClip, key = "") => {
    const cur = currentClip(id);
    if (!cur) return;
    patchClip(id, { text: serializeTextClip(fn(parseTextClip(cur.text).value)) }, key ? `${id}:${key}` : "");
  };

  const through = () => {
    const st = useEditStudio.getState();
    const p = st.history?.present;
    if (!p) return;
    const res = textThroughVideo(p, id, st.playheadMs);
    if (!res.ok) {
      toast({ title: "Can't put the text through a video", description: res.reason, tone: "warn" });
      return;
    }
    editDoc(() => res.project);
  };

  const chars = Array.from(t.text).length;
  return (
    <>
      <Section label="Text" tip="The words shown by this clip">
        <div className={styles.stack}>
          <TextArea
            data-tip="The words to show; up to the character limit"
            aria-label="Text"
            minRows={2}
            value={t.text}
            onChange={(e) => edit((c) => ({ ...c, text: Array.from(e.target.value).slice(0, MAX_CLIP_TEXT).join("") }), "text")}
          />
          <span className={styles.counter} aria-label="Character count" data-tip="Characters used out of the most this clip can hold">
            {chars}/{MAX_CLIP_TEXT}
          </span>
          <div className={styles.quick} role="group" aria-label="Quick styles" data-tip="One-click looks that change the style settings below">
            {QUICK_STYLES.map((q) => (
              <Button key={q.id} size="sm" data-tip={QUICK_TIPS[q.id] ?? "Apply this look to the text"} onClick={() => edit(q.apply)}>
                {q.label}
              </Button>
            ))}
          </div>
        </div>
      </Section>

      <Section label="Reveal" tip="How the words come on screen over the length of the clip">
        <div className={styles.stack}>
          <SegmentedControl
            size="sm"
            aria-label="Reveal"
            value={t.reveal}
            onChange={(reveal) => edit((c) => ({ ...c, reveal }))}
            options={[{ value: "all", label: "All at once", tip: "Show all the text from the start of the clip" }, { value: "words", label: "Word by word", tip: "Reveal one word after another at a steady pace" }, { value: "beats", label: "On the beat", tip: "Reveal the next word on each chosen marker of the music" }]}
          />
          {t.reveal === "words" && (
            <label className={styles.stack} data-tip="How long to wait before the next word appears, in milliseconds">
              <span className={styles.label}>Time per word</span>
              <Slider aria-label="Time per word" min={40} max={2000} step={10} value={t.wordMs} onChange={(wordMs) => edit((c) => ({ ...c, wordMs }), "wordMs")} format={(v) => `${Math.round(v)} ms`} />
            </label>
          )}
          {t.reveal === "beats" && (
            <>
              <label className={styles.stack} data-tip="Which musical moment makes the next word appear (beats, kicks, snares…)">
                <span className={styles.label}>Land on</span>
                <Select size="sm" aria-label="Marker lane" value={t.lane} onChange={(lane) => edit((c) => ({ ...c, lane: lane as MarkerLane }))} options={MARKER_LANES.map((l) => ({ value: l, label: l }))} />
              </label>
              <label className={styles.stack} data-tip="Reveal a word on every Nth marker only, e.g. 2 = every second beat">
                <span className={styles.label}>Every</span>
                <Slider aria-label="Every" min={1} max={16} step={1} value={t.every} onChange={(every) => edit((c) => ({ ...c, every: Math.round(every) }), "every")} format={(v) => `${Math.round(v)}`} />
              </label>
            </>
          )}
        </div>
      </Section>

      <Section label="Style" tip="Font, size, colour, outline, glow and position of the text">
        <TextStyleEditor value={t.style} fonts={fonts} allowMood={false} maxSize={MAX_TEXT_CLIP_SIZE} onChange={(style: TextStyle) => edit((c) => ({ ...c, style }), "style")} />
      </Section>

      <Section label="Through video" tip="Use the text as a window onto the video under it">
        <div className={styles.stack}>
          <Button size="sm" icon="layers" data-tip="Add a track below that shows the video at the playhead only inside the letters" onClick={through}>
            Text through video
          </Button>
          <p className={styles.hint}>Shows the video under the playhead only inside the letters. For text behind a person, use Captions, Behind the subject.</p>
        </div>
      </Section>
    </>
  );
}
