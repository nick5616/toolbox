"""search handlers: Smart search's image/text embeddings (Phase 20 SPEC.md §2.6/§3.8).

CONTRACT STUB (Wave 0): S1 implements these. Methods and params are frozen:

- search.prefetch {files: [{path, url, sha256, bytes}], modelDir}
    downloads and verifies every file into modelDir/<path> (download.ensure_model).
- search.embed_images {modelDir, paths: [str], threads: int}
    -> {dim: int, vectors: [base64 float16 LE, L2-normalised]} in input order;
    an unreadable picture gives "" at its index plus a log line.
- search.embed_text {modelDir, texts: [str]}
    -> {dim: int, vectors: [base64 float16 LE, L2-normalised]}.
"""

from __future__ import annotations

from typing import Any

from ..registry import Context, HandlerError, handler


@handler("search.prefetch")
def prefetch(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise HandlerError("internal", "search.prefetch is not implemented yet")


@handler("search.embed_images")
def embed_images(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise HandlerError("internal", "search.embed_images is not implemented yet")


@handler("search.embed_text")
def embed_text(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    raise HandlerError("internal", "search.embed_text is not implemented yet")
