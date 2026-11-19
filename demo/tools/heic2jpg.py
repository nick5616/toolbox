"""Converts photos (HEIC and others) to upright JPEGs for the demo's Ken Burns clips.

usage: python -I heic2jpg.py <out dir> <max long side> <input> [<input> ...]
Run with the AI engine's Python (it has Pillow and pillow_heif). Metadata (GPS) is not copied.
"""
import os
import sys

from PIL import Image, ImageOps

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:
    pass


def main() -> int:
    out_dir, max_side = sys.argv[1], int(sys.argv[2])
    os.makedirs(out_dir, exist_ok=True)
    for src in sys.argv[3:]:
        im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
        im.thumbnail((max_side, max_side))
        name = os.path.splitext(os.path.basename(src))[0] + ".jpg"
        im.save(os.path.join(out_dir, name), quality=93)  # no exif= argument: location is dropped
        print(name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
