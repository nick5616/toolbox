import {
  PackComponentKind,
  PackComponentState,
  PackState,
  type PackComponentStatus,
  type PackStatus,
} from "@/lib/api";
import { normalizePack, type PackView } from "./packSizes";

/** Test helpers: build pack statuses without the whole catalog. */
export function comp(
  id: string,
  state: PackComponentState,
  bytes: number,
  packs: string[],
  kind: PackComponentKind = PackComponentKind.ComponentDep,
): PackComponentStatus {
  const present = state === PackComponentState.ComponentInstalled || state === PackComponentState.ComponentSystem;
  return {
    id,
    name: id.toUpperCase(),
    href: `https://example.com/${id}`,
    license: "MIT",
    kind,
    state,
    downloadBytes: present ? 0 : Math.round(bytes / 2),
    diskBytes: present ? 0 : bytes,
    packs,
  };
}

export function pack(
  id: string,
  name: string,
  state: PackState,
  components: PackComponentStatus[],
  unlocks: string[] = [id],
  extra: Partial<PackStatus> = {},
): PackView {
  return normalizePack({
    id,
    name,
    icon: "box",
    description: `${name} description`,
    state,
    unsupportedReason: "",
    components,
    unlocks: unlocks.map((m) => ({ moduleId: m, name: `${m} tool`, icon: "box", needs: null })),
    jobId: "",
    ...extra,
  });
}

const M = PackComponentState.ComponentMissing;

/** media (ffmpeg, yt-dlp, deno) and music/image sharing the AI engine. */
export function samplePacks(): PackView[] {
  return [
    pack("media", "Media", PackState.PackMissing, [
      comp("ffmpeg", M, 200e6, ["media", "music"]),
      comp("yt-dlp", M, 20e6, ["media"]),
      comp("deno", M, 100e6, ["media"]),
    ], ["downloader", "converter"]),
    pack("music", "Music", PackState.PackMissing, [
      comp("engine", M, 1600e6, ["music", "image"]),
      comp("ffmpeg", M, 200e6, ["media", "music"]),
      comp("stems-default", M, 80e6, ["music"], PackComponentKind.ComponentModel),
    ], ["stems", "bpm-key"]),
    pack("image", "Image", PackState.PackMissing, [
      comp("engine", M, 1600e6, ["music", "image"]),
      comp("bg-default", M, 220e6, ["image"], PackComponentKind.ComponentModel),
      comp("exiftool", M, 35e6, ["image"]),
    ], ["bgremove", "exif"]),
  ];
}
