/** The Inspector section of a text clip: the words, their style, quick styles and how they appear (§23.6). */
import { useEffect, useMemo, useState } from "react";
import { Button, SegmentedControl, Section, Select, Slider, TextArea, toast } from "@/components";
import { TextStyleEditor } from "@/components/viz/TextStyleEditor";
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
      <Section label="Text">
        <div className={styles.stack}>
          <TextArea
            aria-label="Text"
            minRows={2}
            value={t.text}
            onChange={(e) => edit((c) => ({ ...c, text: Array.from(e.target.value).slice(0, MAX_CLIP_TEXT).join("") }), "text")}
          />
          <span className={styles.counter} aria-label="Character count">
            {chars}/{MAX_CLIP_TEXT}
          </span>
          <div className={styles.quick} role="group" aria-label="Quick styles">
            {QUICK_STYLES.map((q) => (
              <Button key={q.id} size="sm" onClick={() => edit(q.apply)}>
                {q.label}
              </Button>
            ))}
          </div>
        </div>
      </Section>

      <Section label="Reveal">
        <div className={styles.stack}>
          <SegmentedControl
            size="sm"
            aria-label="Reveal"
            value={t.reveal}
            onChange={(reveal) => edit((c) => ({ ...c, reveal }))}
            options={[{ value: "all", label: "All at once" }, { value: "words", label: "Word by word" }, { value: "beats", label: "On the beat" }]}
          />
          {t.reveal === "words" && (
            <label className={styles.stack}>
              <span className={styles.label}>Time per word</span>
              <Slider aria-label="Time per word" min={40} max={2000} step={10} value={t.wordMs} onChange={(wordMs) => edit((c) => ({ ...c, wordMs }), "wordMs")} format={(v) => `${Math.round(v)} ms`} />
            </label>
          )}
          {t.reveal === "beats" && (
            <>
              <label className={styles.stack}>
                <span className={styles.label}>Land on</span>
                <Select size="sm" aria-label="Marker lane" value={t.lane} onChange={(lane) => edit((c) => ({ ...c, lane: lane as MarkerLane }))} options={MARKER_LANES.map((l) => ({ value: l, label: l }))} />
              </label>
              <label className={styles.stack}>
                <span className={styles.label}>Every</span>
                <Slider aria-label="Every" min={1} max={16} step={1} value={t.every} onChange={(every) => edit((c) => ({ ...c, every: Math.round(every) }), "every")} format={(v) => `${Math.round(v)}`} />
              </label>
            </>
          )}
        </div>
      </Section>

      <Section label="Style">
        <TextStyleEditor value={t.style} fonts={fonts} allowMood={false} onChange={(style: TextStyle) => edit((c) => ({ ...c, style }), "style")} />
      </Section>

      <Section label="Through video">
        <div className={styles.stack}>
          <Button size="sm" icon="layers" onClick={through}>
            Text through video
          </Button>
          <p className={styles.hint}>Shows the video under the playhead only inside the letters. For text behind a person, use Captions, Behind the subject.</p>
        </div>
      </Section>
    </>
  );
}
