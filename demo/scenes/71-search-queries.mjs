// 71 Search queries: a concept ("night city"), words inside a picture ("motown"), words said in a video
// ("four on the floor"), then a hit opened to show its labels and where the words are.
import { clearSearch, SEARCH_BOX, waitIndexed } from "./_d4c.mjs";

const OPTION = { css: '[role="listbox"] [role="option"]' };

export default {
  id: "search-queries",
  title: "Search queries",
  tool: "Library search",
  kind: "a",
  roles: ["photo.night", "image.drumchart", "video.talk"],
  async run(t) {
    await t.openLibrary();
    await waitIndexed(t, { timeoutMs: 60 * 60000 }); // untimed: the index has to be finished first

    await t.rec.start();
    t.note("A concept: \"night city\" finds the skyline and the bridge in the rain, though no file is called that.", "Describe what you are looking for, not what the file is called.");
    await t.hold(700);
    await t.type(SEARCH_BOX, "night city");
    await t.hold(2800);

    t.note("Words inside a picture: \"motown\" finds the drum chart, because Toolbox read the text on it.", "It reads the words inside pictures too.");
    await clearSearch(t);
    await t.type(SEARCH_BOX, "motown");
    await t.hold(2800);

    t.note("Words said out loud: \"four on the floor\" finds the narration video.", "And it listens: words said in a video or a song are searchable.");
    await clearSearch(t);
    await t.type(SEARCH_BOX, "four on the floor");
    await t.hold(2800);

    t.note("Open the first hit: the detail panel shows where the words are, with the moment in the video.", "Open a hit and see exactly where it matched.");
    await t.click({ css: '[role="listbox"] [role="option"]', text: "narration.mp4" });
    await t.hold(1800);
    await t.hover({ css: '[aria-label="Details"]' }, 2400);
    await t.still("Search queries");

    t.note("A picture hit shows the labels Toolbox found in it, which you can add to or remove.", "Every picture carries labels you can keep or change.");
    await clearSearch(t);
    await t.type(SEARCH_BOX, "night city");
    await t.hold(1500);
    await t.click({ css: '[role="listbox"] [role="option"]', text: "IMG_4265" });
    await t.hold(2800);
    await t.rec.stop();
    await clearSearch(t); // untimed: the Library keeps its search text between scenes
    await t.key("Escape", { chip: false });
  },
};
