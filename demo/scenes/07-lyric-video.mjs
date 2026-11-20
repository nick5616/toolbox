// 07 Lyric Video: a song, lyrics detected and timed from the vocals, then a render.
import { at } from "./_d2a.mjs";

export default {
  id: "lyric-video",
  title: "Lyric Video",
  tool: "Lyric Video",
  kind: "a",
  roles: ["song.main"],
  async run(t) {
    await t.rec.start();
    t.note("The song's lyrics are detected from the vocals and timed line by line, then the video is rendered.", "Detect the words from the song itself, check the timing, and render a lyric video.");
    await t.open("lyric-video");
    await t.handOff("lyric-video", "song.main");
    await t.hold(1500);
    await t.click({ css: "button", text: "Lyrics", exact: true });
    await t.hold(900);
    // A fresh workspace may remember "Paste lyrics": detect from the song (a pasted-lyrics run with no words makes no job).
    if (await t.exists({ css: "button", text: "Detect from the song" })) await t.click({ css: "button", text: "Detect from the song" });
    if (await t.exists({ css: "button", text: "Get timings" })) {
      await t.click({ css: "button", text: "Get timings" });
      await t.move({ css: "main" });
      await t.waitJob({ compress: true });
      await t.hold(1500);
    }
    await t.click({ css: "button", text: "Close", exact: true });
    await t.hold(600);
    // the first line is timed at 0:29: click the waveform there and play
    await t.click(await at(t, 1887, 113)); // the row's play button plays from that line
    await t.hold(6000);
    await t.key("Space", { chip: false });
    await t.still("Lyric Video");
    t.note("Preview 10 s renders a real piece of the finished video.");
    await t.click({ css: "button", text: "Export", exact: true });
    await t.hold(900);
    await t.click({ css: "button", textRe: "^Preview 10 s" });
    await t.move({ css: "main" });
    await t.waitJob({ compress: true });
    await t.hold(3000);
    await t.rec.stop();
  },
};
