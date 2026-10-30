/** Lyric Stage (SPEC.md §6.10 #17): the cover art as a soft, breathing stage with light rays, dust and big karaoke words. */
import type { Preset } from "./types";
import { BG, L, m, makeShow, P, S, director, globalPost, text } from "./kit";

const cover = (blur: number, dark: number, breathe: number, zoom: number) =>
  BG("cover", "image", {
    source: "auto",
    blur: P(blur, m("section.energy", -0.1)),
    darken: dark,
    breathe: P(breathe, m("bass.level", 0.03)),
    zoom,
    kenBurns: 0.5,
    saturation: 1.1,
    tint: 0.15,
    brightness: P(0.7, m("section.energy", 0.05), m("drop.pulse", 0.06, "exp")),
  });

const dust = (count: number, bright: number) =>
  L("dust", "fireflies", { count: P(count, m("mix.level", 0.1)), size: 0.8, glow: 0.45, drift: 0.5, bokeh: 0.3, brightness: bright }, { opacity: 0.8 });

const rays = (bright: number) => L("rays", "lightrays", { rays: 12, length: 1, brightness: P(bright, m("vocals.held", 0.2), m("beat.pulse", 0.05)), held: 0.8, y: 1.2 }, { opacity: 0.75 });

export const lyricStage: Preset = {
  id: "lyric-stage",
  name: "Lyric Stage",
  description: "Your cover art as a soft glowing stage with drifting dust and light rays, with big karaoke words in front.",
  bestFor: "Lyric videos",
  show: makeShow({
    id: "lyric-stage",
    name: "Lyric Stage",
    palette: { mode: "mood", ids: ["dawn"] },
    scenes: [
      S("calm", "Calm", [cover(22, 0.55, 0.03, 1.08), dust(25, 1.1)]),
      S("main", "Main", [cover(14, 0.45, 0.05, 1.06), dust(45, 1.3), rays(0.25)]),
      S("full", "Full", [cover(8, 0.35, 0.08, 1.04), dust(70, 1.5), rays(0.4)]),
    ],
    post: globalPost({ bloom: P(0.5, m("section.energy", 0.05), m("drop.pulse", 0.1)), vignette: 0.5, grain: 0.1 }),
    controls: [
      { label: "Cover blur", target: "cover.blur" },
      { label: "Cover dimming", target: "cover.darken" },
      { label: "Cover breathing", target: "cover.breathe" },
      { label: "Light rays", target: "rays.brightness" },
      { label: "Dust", target: "dust.count" },
      { label: "Bloom", target: "post.bloom.intensity" },
    ],
    text: text("karaoke", { size: 9, weight: 900, position: "center", showNext: false, glow: 0.6, outline: 0.04, emphasis: { scale: 1.3, glow: 0.9, color: "mood", sparks: true }, react: { signal: "vocals.level", amount: 0.4 } }),
    director: director({ transitions: { chorus: { kind: "crossfade", ms: 2500 }, chorusAfterLift: { kind: "crossfade", ms: 2500 } } }),
  }),
};
