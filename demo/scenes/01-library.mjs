// 01 Library: folders, HEIC previews, the lineage of a result, the Things view.
import { waitIndexed } from "./_d2a.mjs";

export default {
  id: "library",
  title: "Library",
  tool: "Library",
  kind: "a",
  roles: ["song.alt", "photo.skyline"],
  async run(t) {
    // Untimed setup: make one result so there is a lineage to look at (song.alt -> MP3).
    const song = t.role("song.alt");
    await t.openLibrary();
    await t.svc("toolbox/modules/converter.Service", "Enqueue", [song], { preset: "mp3-320", maxHeight: "keep", keepMetadata: true });
    await t.waitJob({ compress: true });
    await waitIndexed(t); // Things needs the index

    await t.rec.start();
    t.note("The Library is the folder you work in: previews of every photo (HEIC included), folders as they are on disk.", "Everything you make lands in one library, with real previews, even for iPhone photos.");
    await t.openLibrary();
    await t.hold(2200);
    await t.click({ css: '[aria-label="View"] button', text: "Folders" });
    await t.hold(1800);
    await t.click({ css: '[aria-label="View"] button', text: "Grid" });
    await t.hold(900);

    t.note("Open a result and see what it was made from.", "Open any result and the Library shows what it was made from, and what was made from it.");
    await t.type({ css: '[aria-label="Search the library"]' }, "mp3");
    await t.hold(1200);
    await t.click({ css: '[role="listbox"] [aria-label*="mp3" i]' });
    await t.hold(2000);
    await t.hover({ css: '[aria-label="Made from"]' }, 1800);
    await t.key("Escape", { chip: false });

    t.note("Things: everything Toolbox recognised in your pictures, by category.", "And Things groups your pictures by what is in them.");
    await t.click({ css: '[aria-label="Search the library"]' });
    await t.key("Mod+A");
    await t.key("Backspace", { chip: false });
    await t.click({ css: '[aria-label="View"] button', text: "Things" });
    await t.hold(2500);
    await t.still("Library");
    await t.rec.stop();
  },
};
