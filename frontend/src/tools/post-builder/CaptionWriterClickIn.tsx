import { useMemo } from "react";
import { ToolClickIn, toast } from "@/components";
import { useDoc, usePostBuilder } from "./postStore";

/**
 * "Write with Caption Writer" beside the caption box. Caption Writer opens in a
 * drawer here (or its own window) with the post's photos and clips; its "Use"
 * returns one JSON string in the embed contract's `paths` array:
 * `captions:{"input","caption","hashtags","alt"}`. The tools never import each
 * other, so the format is repeated here (see tools/captions/options.ts).
 */
const USE_PREFIX = "captions:";

interface Written {
  input: string;
  caption: string;
  hashtags: string[];
  alt: string;
}

export function parseWritten(paths: string[]): Written | null {
  const raw = paths.find((p) => p.startsWith(USE_PREFIX));
  if (!raw) return null;
  try {
    const r = JSON.parse(raw.slice(USE_PREFIX.length)) as Partial<Written>;
    return {
      input: typeof r.input === "string" ? r.input : "",
      caption: typeof r.caption === "string" ? r.caption : "",
      hashtags: Array.isArray(r.hashtags) ? r.hashtags.filter((h): h is string => typeof h === "string") : [],
      alt: typeof r.alt === "string" ? r.alt : "",
    };
  } catch {
    return null;
  }
}

/** The caption box text: the caption, a blank line, then the hashtags. */
export function captionText(w: Pick<Written, "caption" | "hashtags">): string {
  const tags = w.hashtags.join(" ");
  return [w.caption.trim(), tags].filter((s) => s !== "").join("\n\n");
}

export function CaptionWriterClickIn() {
  const doc = useDoc();
  const slides = doc?.slides ?? [];
  const files = useMemo(() => slides.filter((s) => (s.kind === "photo" || s.kind === "clip") && s.path !== "").map((s) => s.path), [slides]);

  const onUse = (paths: string[]) => {
    const w = parseWritten(paths);
    if (!w) return;
    const st = usePostBuilder.getState();
    const text = captionText(w);
    if (text !== "") st.setCaption(text);
    // The picture's alt text goes to its slide when that slide has none yet.
    const slide = st.history?.present.slides.find((s) => s.path === w.input);
    if (slide && w.alt !== "" && slide.altText.trim() === "") st.setAltText(slide.id, w.alt);
    toast({ title: "Caption written into the post", tone: "success" });
  };

  return (
    <ToolClickIn
      host="post-builder"
      module="captions"
      title="Write with Caption Writer"
      icon="sparkles"
      inputs={files}
      action="posting"
      useLabel="Use caption"
      width={560}
      tip="Have a caption, hashtags and alt text written from this post's photos and clips"
      disabledReason={files.length === 0 ? "Add a photo or clip to the post first" : undefined}
      onUse={onUse}
    />
  );
}
