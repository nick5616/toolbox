/**
 * Search words for the command palette, by module id. A person looks for
 * what they want to do ("vocals", "metadata", "noise"), not for a tool's
 * name. Phase 14 adds `Descriptor.Keywords` on the Go side; until then this
 * map is the source (the palette reads both).
 */
export const TOOL_KEYWORDS: Record<string, string[]> = {
  focus: ["focus", "block", "distraction", "lock", "apps", "pomodoro", "deep work", "timer", "concentrate", "study"],
  compress: ["shrink", "smaller", "size", "mb", "limit", "discord", "email", "gmail", "whatsapp", "fit", "reduce"],
  stems: ["vocals", "karaoke", "instrumental", "acapella", "drums", "bass", "separate", "isolate"],
  exif: ["metadata", "location", "gps", "photo", "privacy", "strip", "camera"],
  "audio-cleanup": ["noise", "hum", "denoise", "hiss", "voice", "podcast", "loudness", "clean"],
  pdf: ["merge", "split", "compress", "rotate", "reorder", "password", "unlock", "pages"],
  downloader: ["youtube", "mp3", "video", "link", "url", "download", "playlist", "tiktok", "instagram"],
  converter: ["convert", "mp4", "mp3", "wav", "gif", "resize", "format", "compress", "transcode"],
  "bg-remover": ["background", "cutout", "transparent", "remove", "png", "sticker"],
  upscaler: ["enlarge", "sharpen", "resolution", "bigger", "4x", "hd"],
  ocr: ["text", "scan", "extract", "read", "screenshot", "image to text"],
  transcribe: ["speech", "captions", "subtitles", "dictation", "whisper", "speech to text", "meeting"],
  subtitles: ["captions", "srt", "burn", "karaoke", "lyrics"],
  "lyric-video": ["karaoke", "lyrics", "song", "music video", "words"],
  visualizer: ["music video", "waveform", "spectrum", "audio reactive", "song"],
  "bpm-key": ["tempo", "beats per minute", "key", "scale", "dj", "camelot"],
  "audio-to-midi": ["notes", "piano", "melody", "transcribe", "midi"],
  trimmer: ["cut", "clip", "shorten", "trim", "split", "crop"],
  clipboard: ["history", "copy", "paste", "snippets"],
  vault: ["encrypt", "private", "secure", "password", "secret", "lock"],
  "llm-chat": ["ai", "assistant", "ask", "chatgpt", "local", "summarise", "summarize", "write"],
  chat: ["ai", "assistant", "ask", "chatgpt", "local", "summarise", "summarize", "write"],
  "dev-utils": ["json", "base64", "hash", "checksum", "uuid", "regex", "url", "encode", "decode", "jwt", "timestamp"],
  documents: ["word", "docx", "epub", "markdown", "text", "convert", "ebook"],
  redact: ["blur", "censor", "faces", "hide", "plates", "privacy", "pixelate"],
  "object-eraser": ["remove", "inpaint", "erase", "clone", "retouch", "watermark"],
  paint: ["draw", "paint", "sketch", "procreate", "brush", "layers", "illustrate", "art", "canvas", "pen", "dissolve"],
  archiver: ["save page", "website", "offline", "web archive", "snapshot", "html", "link"],
  pipelines: ["automate", "batch", "workflow", "recipe", "watch folder", "chain"],
  "photo-composer": ["collage", "design", "poster", "layers", "template", "canvas", "photo"],
  "post-builder": ["instagram", "carousel", "social", "caption", "slides", "post"],
  "video-studio": ["edit", "timeline", "cut", "clip", "movie", "montage"],
  "video-editor": ["edit", "timeline", "slides", "sequence"],
  "lan-share": ["send", "share", "transfer", "airdrop", "localsend", "phone", "wifi", "receive", "nearby", "files"],
  "edit-studio": ["beat", "music video", "edit", "timeline", "cut to the beat", "montage"],
};

/** Words for one tool (frontend map plus any the descriptor carries). */
export function keywordsFor(moduleId: string, descriptorKeywords?: readonly string[] | null): string[] {
  return [...(TOOL_KEYWORDS[moduleId] ?? []), ...(descriptorKeywords ?? [])];
}

/**
 * Word-prefix match for free text (taglines, keywords): every word typed must
 * start a word of `text`. Unlike the fuzzy title match, this never matches
 * scattered letters inside a long sentence. Returns a score (higher = better)
 * or null.
 */
export function wordMatch(query: string, text: string): number | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const lower = text.toLowerCase();
  let score = 0;
  for (const w of words) {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`(^|[^a-z0-9])${esc}`).test(lower)) return null;
    score += new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(lower) ? 6 : 3;
  }
  return score;
}
