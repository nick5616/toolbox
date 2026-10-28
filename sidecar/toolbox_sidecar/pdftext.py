"""Invisible text layer for searchable PDFs (Phase 5 SPEC.md section 5.3).

Ported from the research prototype compose.py. The original page content and
images are never re-encoded: for each OCR'd page we append one new content
stream (render mode 3 = invisible) that positions every recognised word over
its picture, using a tiny embedded glyphless Type0 font with an identity
ToUnicode map, so viewers can select, search and extract the text.
"""

from __future__ import annotations

import base64
import math
import zlib
from typing import Any

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    DecodedStreamObject,
    DictionaryObject,
    NameObject,
    NumberObject,
    TextStringObject,
)

FONT_NAME = "GLT"

# 624-byte glyphless TrueType font (one empty .notdef glyph, 1000 units wide),
# zlib-compressed and base64-encoded.
_GLYPHLESS_TTF_B64 = (
    "eNqVUL1KA0EQ/vb2YjQYQ0QhpjrFwkIiWsQUgo2aJiDEFHZ6xDNX3CVH7gKXQrCwsLDwQXwACx8gj2AjKgjeC1gp"
    "nN/9qBhsnGXmm292dmZ2IADkcA4Jbf9gbWPncfcCECuMHrdt3cE09sivyFc71vBUdjNP5HfkZdPQT9bzDxX6N9Sq"
    "yUA2J5fov1CXTdvzZUAP4pJGtXptnZgnv424rfsO+06QT5JrXd02Cs8Lh+T35H2n53q8pyiNqB6iWalnpdnNo8LW"
    "G2RS/TXbeP/BsCYDqZFKKEiEb6QW1mjjfFqB3yLS2mp6o2Bc2EtcI8OMf8o2JS2RzKBhNJaifU0W941+PEcrYlRR"
    "iuPxRGEYazJjPsL0t3wzX1wsymAkg49SUlVFNc0U0c6/f5YlY3V1ipFy0om+ghlU6tbQMS3DdVuG7zWNzsDS+6jD"
    "whAOTKIBl6dF9OGhSexgwLiO/p9bG98yPgF5/E6K"
)


def glyphless_ttf() -> bytes:
    return zlib.decompress(base64.b64decode(_GLYPHLESS_TTF_B64))


_TOUNICODE = (
    b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) "
    b"/Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def "
    b"1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0000> <FFFF> <0000> endbfrange "
    b"endcmap CMapName currentdict /CMap defineresource pop end end"
)


class EncryptedPDF(Exception):
    """The input PDF is encrypted."""


def _n(s: str) -> NameObject:
    return NameObject(s)


def add_font(w: PdfWriter) -> Any:
    """Adds the shared glyphless font once and returns its indirect reference."""
    ttf = DecodedStreamObject()
    data = glyphless_ttf()
    ttf.set_data(data)
    ttf[_n("/Length1")] = NumberObject(len(data))
    ttf_ref = w._add_object(ttf.flate_encode())
    desc = DictionaryObject(
        {
            _n("/Type"): _n("/FontDescriptor"),
            _n("/FontName"): _n("/GlyphlessText"),
            _n("/Flags"): NumberObject(5),
            _n("/FontBBox"): ArrayObject([NumberObject(0), NumberObject(-200), NumberObject(1000), NumberObject(800)]),
            _n("/ItalicAngle"): NumberObject(0),
            _n("/Ascent"): NumberObject(800),
            _n("/Descent"): NumberObject(-200),
            _n("/CapHeight"): NumberObject(700),
            _n("/StemV"): NumberObject(80),
            _n("/FontFile2"): ttf_ref,
        }
    )
    zmap = DecodedStreamObject()
    zmap.set_data(bytes(131072))  # CIDToGIDMap: every CID -> glyph 0
    cid = DictionaryObject(
        {
            _n("/Type"): _n("/Font"),
            _n("/Subtype"): _n("/CIDFontType2"),
            _n("/BaseFont"): _n("/GlyphlessText"),
            _n("/CIDSystemInfo"): DictionaryObject(
                {
                    _n("/Registry"): TextStringObject("Adobe"),
                    _n("/Ordering"): TextStringObject("Identity"),
                    _n("/Supplement"): NumberObject(0),
                }
            ),
            _n("/FontDescriptor"): w._add_object(desc),
            _n("/DW"): NumberObject(1000),
            _n("/CIDToGIDMap"): w._add_object(zmap.flate_encode()),
        }
    )
    tou = DecodedStreamObject()
    tou.set_data(_TOUNICODE)
    font = DictionaryObject(
        {
            _n("/Type"): _n("/Font"),
            _n("/Subtype"): _n("/Type0"),
            _n("/BaseFont"): _n("/GlyphlessText"),
            _n("/Encoding"): _n("/Identity-H"),
            _n("/DescendantFonts"): ArrayObject([w._add_object(cid)]),
            _n("/ToUnicode"): w._add_object(tou),
        }
    )
    return w._add_object(font)


def hexs(s: str) -> str:
    """Text -> hex CIDs (BMP code points; astral characters become '?')."""
    return "".join(f"{ord(c):04X}" if ord(c) < 0x10000 else "003F" for c in s)


def mapper(page: Any, rot: int):
    """Returns (f, R, U): f maps view coords (u, v) in pt from the top-left of the
    displayed page to user space (x, y); R and U are the user-space unit vectors of
    view-right and view-up. Undoes /Rotate and the cropbox offset."""
    cb = page.cropbox
    x0, y0, x1, y1 = float(cb.left), float(cb.bottom), float(cb.right), float(cb.top)
    if rot == 0:
        return (lambda u, v: (x0 + u, y1 - v)), (1, 0), (0, 1)
    if rot == 90:
        return (lambda u, v: (x0 + v, y0 + u)), (0, 1), (-1, 0)
    if rot == 180:
        return (lambda u, v: (x1 - u, y0 + v)), (-1, 0), (0, -1)
    return (lambda u, v: (x1 - v, y1 - u)), (0, -1), (1, 0)


def page_ops(
    page: Any, lines: list[list[dict[str, Any]]], scale: float, visible: bool = False
) -> tuple[list[str], int]:
    """Content-stream operators for one page.

    lines: [[{"t": word, "q": 4 corner points (tl, tr, br, bl) in render pixels}]];
    scale = pixels per point. Returns (ops, words written).
    """
    rot = int(page.rotation) % 360
    f, R, U = mapper(page, rot)
    ops = ["q", "BT", "1 Tr 1 0 0 RG 0.4 w" if visible else "3 Tr", f"/{FONT_NAME} 1 Tf"]
    count = 0
    for line in lines:
        for i, wd in enumerate(line):
            text = wd["t"]
            (ax, ay), (bx, by), _c, (dx, dy) = wd["q"]
            wpx = math.hypot(bx - ax, by - ay)
            hpx = math.hypot(dx - ax, dy - ay)
            if wpx < 1 or hpx < 1 or not text.strip():
                continue
            txt = text + (" " if i < len(line) - 1 else "")
            ang = math.atan2(by - ay, bx - ax)  # view space, y down
            size = hpx / scale * 0.9
            tz = 100 * (wpx / scale) / (len(text) * size)
            ox, oy = f(dx / scale, dy / scale)  # bottom-left of the word quad
            su, cu = -math.sin(ang), math.cos(ang)
            r = (cu * R[0] + su * U[0], cu * R[1] + su * U[1])
            u = (-su * R[0] + cu * U[0], -su * R[1] + cu * U[1])
            ops.append(
                f"{tz:.1f} Tz {r[0] * size:.4f} {r[1] * size:.4f} {u[0] * size:.4f} {u[1] * size:.4f} "
                f"{ox:.2f} {oy:.2f} Tm <{hexs(txt)}> Tj"
            )
            count += 1
    ops += ["ET", "Q"]
    return ops, count


def _inherited_resources(page: Any) -> Any:
    node = page
    while node is not None:
        res = node.get("/Resources")
        if res is not None:
            return res
        parent = node.get("/Parent")
        node = parent.get_object() if parent is not None else None
    return None


def _attach(page: Any, font_ref: Any, cs_ref: Any, q_ref: Any) -> None:
    """Registers the font in the page resources and appends the text stream."""
    if page.get("/Resources") is None:
        inh = _inherited_resources(page)
        copy = DictionaryObject()
        if inh is not None:
            for k, v in inh.get_object().items():
                copy[k] = v
        page[_n("/Resources")] = copy
    res = page["/Resources"].get_object()
    fonts = res.get("/Font")
    if fonts is None:
        fonts = DictionaryObject()
        res[_n("/Font")] = fonts
    fonts.get_object()[_n("/" + FONT_NAME)] = font_ref
    raw = page.raw_get("/Contents") if "/Contents" in page else None
    if raw is None:
        page[_n("/Contents")] = ArrayObject([cs_ref])
        return
    obj = raw.get_object()
    if isinstance(obj, ArrayObject):
        arr = ArrayObject([q_ref])
        arr.extend(list(obj))
        arr.append(cs_ref)
        page[_n("/Contents")] = arr
    else:
        page[_n("/Contents")] = ArrayObject([q_ref, raw, cs_ref])


def is_encrypted(path: str) -> bool:
    return bool(PdfReader(path).is_encrypted)


def overlay(src: str, dst: str, pages: dict[int, dict[str, Any]], visible: bool = False) -> int:
    """Writes dst = src plus an invisible text layer.

    pages maps a 0-based page index to {"scale": px per pt, "lines": [[{"t","q"}]]}.
    Returns the number of words written. Pages without an entry are untouched;
    src is never modified.
    """
    reader = PdfReader(src)
    if reader.is_encrypted:
        raise EncryptedPDF()
    w = PdfWriter(clone_from=reader)
    font_ref = add_font(w)
    q = DecodedStreamObject()
    q.set_data(b"q")
    q_ref = w._add_object(q)
    total = 0
    for idx, pg in sorted(pages.items()):
        page = w.pages[idx]
        ops, n = page_ops(page, pg["lines"], pg["scale"], visible)
        if n == 0:
            continue
        cs = DecodedStreamObject()
        cs.set_data(("Q\n" + "\n".join(ops)).encode("ascii"))
        _attach(page, font_ref, w._add_object(cs.flate_encode()), q_ref)
        total += n
    with open(dst, "wb") as out:
        w.write(out)
    return total


def page_texts(src: str, indices: list[int]) -> dict[int, str]:
    """Text already present on the given 0-based pages (pypdf extraction)."""
    reader = PdfReader(src)
    out: dict[int, str] = {}
    for i in indices:
        try:
            out[i] = (reader.pages[i].extract_text() or "").strip()
        except Exception:  # noqa: BLE001 - best effort for the .txt output
            out[i] = ""
    return out
