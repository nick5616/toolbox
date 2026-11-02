// Resolves the files the sequence player needs into URLs the webview can use.
// Videos go through MediaService.Open (a preview copy when the webview can't
// play the file); photos through FilesService.ImageThumb (also fixes EXIF turns).
import { useEffect } from "react";
import { FilesService } from "@/lib/api";
import { toAppError } from "@/lib/errors";
import { useMediaSource } from "@/components/media";

export interface ClipSource {
  status: "loading" | "preparing" | "ready" | "error";
  url?: string;
  /** 0..1 while a preview copy is being made. */
  progress?: number;
  error?: string;
}

export interface SourceRequest {
  path: string;
  kind: "video" | "image";
}

export type SourceMap = Record<string, ClipSource | undefined>;

interface LoaderProps {
  path: string;
  onChange: (path: string, s: ClipSource) => void;
}

function VideoLoader({ path, onChange }: LoaderProps) {
  const m = useMediaSource(path);
  const { status, progress } = m;
  const url = m.source?.url;
  const err = m.error?.message;
  useEffect(() => {
    if (status === "ready") onChange(path, { status: "ready", url: url ?? "" });
    else if (status === "preparing") onChange(path, { status: "preparing", ...(progress !== undefined ? { progress } : {}) });
    else if (status === "error") onChange(path, { status: "error", error: err ?? "This file can't be played" });
    else onChange(path, { status: "loading" });
  }, [path, status, url, progress, err, onChange]);
  return null;
}

function ImageLoader({ path, onChange }: LoaderProps) {
  useEffect(() => {
    let cancelled = false;
    onChange(path, { status: "loading" });
    FilesService.ImageThumb(path, 1600).then(
      (url) => {
        if (!cancelled) onChange(path, { status: "ready", url });
      },
      (e: unknown) => {
        if (!cancelled) onChange(path, { status: "error", error: toAppError(e).message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, onChange]);
  return null;
}

/** Invisible: mounts one loader per requested file. */
export function SourceLoaders({ requests, onChange }: { requests: readonly SourceRequest[]; onChange: LoaderProps["onChange"] }) {
  return (
    <>
      {requests.map((r) =>
        r.kind === "image" ? (
          <ImageLoader key={`i:${r.path}`} path={r.path} onChange={onChange} />
        ) : (
          <VideoLoader key={`v:${r.path}`} path={r.path} onChange={onChange} />
        ),
      )}
    </>
  );
}
