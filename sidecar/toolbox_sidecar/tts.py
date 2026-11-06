"""Text to Speech helpers (Phase 15, T1): pure text handling, no model needed.

The Kokoro model is driven from ``handlers/tts.py``. Everything here is
deterministic string work so it can be unit-tested without the model:

* ``clean_markdown``  — Markdown (and stray HTML) → plain speakable lines, keeping
  ``#`` heading lines so chapters can be found.
* ``split_chapters``  — one chapter per heading of the top heading level present.
* ``split_sentences`` / ``make_chunks`` — sentences, then synthesis chunks with the
  pause that should follow each.
* ``safe_name``       — a file-name-safe chapter title.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

#: Longest text (characters) one synthesis call is given; Kokoro splits further by itself.
CHUNK_CHARS = 320
#: A single sentence longer than this is broken at clause marks, then at spaces.
MAX_SENTENCE = 480

PAUSE_CHUNK = 0.2  # between chunks of one paragraph
PAUSE_PARAGRAPH = 0.6
PAUSE_HEADING = 0.9

_ABBREVIATIONS = (
    "mr",
    "mrs",
    "ms",
    "dr",
    "prof",
    "sr",
    "jr",
    "st",
    "vs",
    "etc",
    "e.g",
    "i.e",
    "fig",
    "inc",
    "ltd",
)
_ABBR_RE = re.compile(r"\b(" + "|".join(re.escape(a) for a in _ABBREVIATIONS) + r")\.$", re.IGNORECASE)

_HEADING_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
_FENCE_RE = re.compile(r"^\s{0,3}(```|~~~)")
_HRULE_RE = re.compile(r"^\s{0,3}([-*_])(\s*\1){2,}\s*$")
_SETEXT_RE = re.compile(r"^\s{0,3}(=+|-+)\s*$")
_IMAGE_RE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_LINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_REFLINK_RE = re.compile(r"\[([^\]]+)\]\[[^\]]*\]")
_REFDEF_RE = re.compile(r"^\s{0,3}\[[^\]]+\]:\s*\S+.*$")
_URL_RE = re.compile(r"(?:https?://|www\.)\S+", re.IGNORECASE)
_TAG_RE = re.compile(r"</?[A-Za-z][^>]*>")
_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_EMPH_RE = re.compile(r"(\*\*|__|\*|~~)")
_CODE_RE = re.compile(r"`+([^`]*)`+")
_LIST_RE = re.compile(r"^\s*(?:[-*+]|\d{1,3}[.)])\s+")
_QUOTE_RE = re.compile(r"^\s*(?:>\s?)+")
_TABLE_SEP_RE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")
_SPACES_RE = re.compile(r"[ \t\u00a0]+")
_SENT_END_RE = re.compile(r"""([.!?…]+["'”’)\]]*)(\s+)""")
_BAD_NAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


@dataclass
class Chapter:
    title: str
    text: str  # plain speakable text; heading lines keep their ``# `` prefix only when ``keep_headings``


@dataclass
class Chunk:
    text: str
    pause: float  # seconds of silence after the chunk
    chars: int = field(init=False)

    def __post_init__(self) -> None:
        self.chars = len(self.text)


def clean_markdown(text: str) -> str:
    """Plain speakable text from Markdown. ``#`` heading lines are kept as ``# Title``.

    Code blocks, images, link targets, URLs, tables' separator rows and HTML
    comments/tags are dropped; emphasis marks and list/quote markers are removed.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff")
    text = _COMMENT_RE.sub("", text)
    out: list[str] = []
    in_fence = False
    prev_plain = ""  # the previous non-blank plain line, for setext headings
    for raw in text.split("\n"):
        if _FENCE_RE.match(raw):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if _REFDEF_RE.match(raw) or _TABLE_SEP_RE.match(raw) and "|" in raw:
            continue
        m = _HEADING_RE.match(raw)
        if m:
            title = _inline(m.group(2))
            if title:
                out.append("#" * len(m.group(1)) + " " + title)
            prev_plain = ""
            continue
        s = _SETEXT_RE.match(raw)
        if s and prev_plain and out and out[-1] == prev_plain:
            # "Title\n=====" is a level-1 heading, "Title\n-----" level 2.
            out[-1] = ("# " if s.group(1).startswith("=") else "## ") + prev_plain
            prev_plain = ""
            continue
        if _HRULE_RE.match(raw):
            out.append("")
            prev_plain = ""
            continue
        line = _QUOTE_RE.sub("", raw)
        line = _LIST_RE.sub("", line)
        line = _inline(line)
        if "|" in line:
            line = ", ".join(c.strip() for c in line.strip().strip("|").split("|") if c.strip())
        if not line:
            out.append("")
            prev_plain = ""
            continue
        out.append(line)
        prev_plain = line
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


def _inline(s: str) -> str:
    s = _IMAGE_RE.sub("", s)
    s = _LINK_RE.sub(r"\1", s)
    s = _REFLINK_RE.sub(r"\1", s)
    s = _CODE_RE.sub(r"\1", s)
    s = _TAG_RE.sub("", s)
    s = _URL_RE.sub("", s)
    s = _EMPH_RE.sub("", s)
    s = s.replace("\\", "") if re.search(r"\\[*_`#\[\]()>~|]", s) else s
    return _SPACES_RE.sub(" ", s).strip()


def split_chapters(text: str, split: str) -> list[Chapter]:
    """Splits cleaned text (``clean_markdown`` output) into chapters.

    ``split="none"`` → one chapter holding everything; headings are spoken as
    their own lines. ``split="headings"`` → one chapter per heading of the
    shallowest level present; deeper headings stay inside as spoken lines.
    Text before the first heading becomes an "Introduction" chapter. A heading
    with no text before the next heading is merged into the following chapter.
    """
    lines = text.split("\n")
    levels = [len(m.group(1)) for ln in lines if (m := _HEADING_RE.match(ln))]
    if split != "headings" or not levels:
        return [Chapter("", _speakable(lines))]
    top = min(levels)
    chapters: list[Chapter] = []
    title = "Introduction"
    body: list[str] = []
    has_text = False  # the body holds more than heading lines

    for ln in lines:
        m = _HEADING_RE.match(ln)
        if m and len(m.group(1)) == top:
            if has_text:
                chapters.append(Chapter(title, _speakable(body)))
                body, has_text = [], False
            # A heading with nothing under it joins the next one.
            title = m.group(2).strip() or "Untitled"
            body.append(ln)
            continue
        if m is None and ln.strip():
            has_text = True
        body.append(ln)
    if has_text:
        chapters.append(Chapter(title, _speakable(body)))
    if not chapters:
        return [Chapter("", _speakable(lines))]
    return chapters


def _speakable(lines: list[str]) -> str:
    """Heading lines lose their ``#`` marks (they are read as their own line)."""
    out = []
    for ln in lines:
        m = _HEADING_RE.match(ln)
        out.append(m.group(2).strip() if m else ln)
    return "\n".join(out).strip()


def paragraphs(text: str) -> list[tuple[str, bool]]:
    """(paragraph, is_heading_line) pairs; blank lines separate paragraphs.

    A ``# Heading`` line is its own paragraph. Hard-wrapped lines of one
    paragraph are joined with a space.
    """
    result: list[tuple[str, bool]] = []
    cur: list[str] = []

    def flush() -> None:
        if cur:
            result.append((" ".join(cur), False))
            cur.clear()

    for ln in text.split("\n"):
        s = ln.strip()
        if not s:
            flush()
            continue
        m = _HEADING_RE.match(ln)
        if m:
            flush()
            result.append((m.group(2).strip(), True))
            continue
        cur.append(s)
    flush()
    return [(p, h) for p, h in result if p]


def split_sentences(paragraph: str) -> list[str]:
    """Splits one paragraph at ``. ! ? …`` followed by space, minding abbreviations."""
    paragraph = _SPACES_RE.sub(" ", paragraph).strip()
    if not paragraph:
        return []
    out: list[str] = []
    start = 0
    for m in _SENT_END_RE.finditer(paragraph):
        piece = paragraph[start : m.end(1)]
        if m.group(1) == ".":
            # "Dr." / "e.g." and a lone initial ("J. Smith") are not sentence ends.
            if _ABBR_RE.search(piece) or re.search(r"(?:^|\s)[A-Z]\.$", piece):
                continue
        out.append(piece.strip())
        start = m.end()
    rest = paragraph[start:].strip()
    if rest:
        out.append(rest)
    final: list[str] = []
    for s in out:
        final.extend(_break_long(s))
    return final


def _break_long(sentence: str) -> list[str]:
    if len(sentence) <= MAX_SENTENCE:
        return [sentence]
    parts = re.split(r"(?<=[,;:—–])\s+", sentence)
    result: list[str] = []
    cur = ""
    for p in parts:
        if len(p) > MAX_SENTENCE:
            if cur:
                result.append(cur)
                cur = ""
            result.extend(_break_words(p))
            continue
        if cur and len(cur) + 1 + len(p) > MAX_SENTENCE:
            result.append(cur)
            cur = p
        else:
            cur = f"{cur} {p}".strip()
    if cur:
        result.append(cur)
    return result


def _break_words(s: str) -> list[str]:
    result: list[str] = []
    cur = ""
    for w in s.split(" "):
        if cur and len(cur) + 1 + len(w) > MAX_SENTENCE:
            result.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        result.append(cur)
    return result


def make_chunks(text: str, limit: int = CHUNK_CHARS) -> list[Chunk]:
    """Packs sentences into synthesis chunks of at most ``limit`` characters (a
    longer sentence is its own chunk) and gives each the pause that follows it:
    short inside a paragraph, longer at a paragraph end, longest after a heading.
    The very last chunk has no trailing pause."""
    chunks: list[Chunk] = []
    for para, is_heading in paragraphs(text):
        if is_heading:
            if not re.search(r"[.!?…:]$", para):
                para += "."
            chunks.append(Chunk(para, PAUSE_HEADING))
            continue
        cur = ""
        for sent in split_sentences(para):
            if cur and len(cur) + 1 + len(sent) > limit:
                chunks.append(Chunk(cur, PAUSE_CHUNK))
                cur = sent
            else:
                cur = f"{cur} {sent}".strip()
        if cur:
            chunks.append(Chunk(cur, PAUSE_PARAGRAPH))
    if chunks:
        chunks[-1].pause = 0.0
    return chunks


def safe_name(title: str, max_len: int = 60) -> str:
    """A title usable inside a file name on macOS and Windows."""
    s = _BAD_NAME_RE.sub(" ", title)
    s = _SPACES_RE.sub(" ", s).strip(" .")
    return s[:max_len].rstrip(" .")
