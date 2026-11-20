// 70 Library views: card sizes, List, Folders, By tool, Things, and a file's lineage in the detail panel.
import { libraryView, makeChain, waitPicturesIndexed } from "./_d4c.mjs";

export default {
  id: "library-views",
  title: "Library views",
  tool: "Library",
  kind: "a",
  roles: ["song.alt", "photo.skyline"],
  async run(t) {
    // Untimed set-up: a chain (song -> MP3 -> Opus) for the lineage, and the index for Things.
    await t.openLibrary();
    const { mp3 } = await makeChain(t);
    await waitPicturesIndexed(t);

    await t.rec.start();
    t.note("The Library as a grid: Small, Medium and Large cards.", "Look at your files the way that suits the job: small cards to scan, large ones to judge.");
    await t.openLibrary();
    await t.hold(1200);
    for (const s of ["S", "L", "M"]) {
      await t.click({ css: '[aria-label="Card size"] button', text: s, exact: true });
      await t.hold(1700);
    }

    t.note("List: dense rows with sizes and dates. Folders: your library folder exactly as it is on disk.", "A dense list when you want details, or the folders as they are on disk.");
    await libraryView(t, "List");
    await t.hold(2000);
    await libraryView(t, "Folders");
    await t.hold(2000);

    t.note("By tool: one section per tool, so you can find everything one tool made.", "Or group everything by the tool that made it.");
    await libraryView(t, "By tool");
    await t.hold(2200);

    t.note("Open a result: the detail panel shows what it was made from, and what was made from it.", "Open any result to see where it came from and what you made from it.");
    await t.click({ css: '[role="option"]', text: mp3.name, exact: true, nth: 0 });
    await t.hold(1500);
    await t.scroll({ css: '[aria-label="Details"]' }, 420, 1000);
    await t.hover({ css: '[aria-label="Made from"]' }, 2000);
    await t.hover({ css: '[aria-label="Made into"]' }, 2200);
    await t.key("Escape", { chip: false });
    await t.hold(500);

    t.note("Things: the pictures grouped by what Toolbox recognised in them.", "And Things groups your pictures by what is in them.");
    await libraryView(t, "Things");
    await t.hold(2800);
    await libraryView(t, "Grid");
    await t.hold(800);
    await t.still("Library views");
    await t.rec.stop();
  },
};
