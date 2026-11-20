// 73 Send to chain: a photo goes through Background Remover, its cut-out is sent on to Converter (as WebP), and the
// converted file is sent on to Photo Composer, where the composition bar names the tools it is made of.
import { openTool, scrubPaths, setValue } from "./_d2b.mjs";

const SEND = { css: 'button[aria-label="Send to…"]' };

async function sendTo(t, toolName) {
  await t.click(SEND);
  await t.hold(900);
  await t.click({ css: '[role="menuitem"]', text: toolName, exact: true });
  await t.hold(1600);
}

export default {
  id: "send-to-chain",
  title: "Send to chain",
  tool: "Background Remover",
  kind: "a",
  roles: ["photo.tshirt"],
  async run(t) {
    await openTool(t, "bg-remover", "Background Remover");
    await scrubPaths(t);
    await t.waitFor({ css: "button", text: "Add files…" });
    await t.rec.start();

    t.note("A photo goes into Background Remover and comes out as a cut-out.", "Start with a photo and cut the subject out.");
    await t.handOff("bg-remover", "photo.tshirt");
    await t.hold(1100);
    await t.click({ css: "button", textRe: "^Remove background" });
    await t.waitJob({ compress: true });
    await t.hold(1200);

    t.note("Send to: the cut-out goes straight into Converter, no saving and re-adding.", "Send the result straight to the next tool.");
    await sendTo(t, "Converter");
    await t.waitFor({ css: "button", textRe: "^Convert (files|\\d+ files?)" });
    await t.hold(1000);
    await t.hover({ css: "select" }, 500);
    await setValue(t, "select", "webp");
    await t.hold(900);
    await t.click({ css: "button", textRe: "^Convert (files|\\d+ files?)" });
    await t.waitJob({ compress: true });
    await t.hold(1500);

    t.note("And on again: the converted picture goes to Photo Composer, which names the tools it is built from.", "And on again, into a composition.");
    await t.hover({ css: '[role="listitem"], li', nth: 0 }, 400).catch(() => {});
    await sendTo(t, "Photo Composer");
    await t.waitFor({ css: "button", text: "Uses" });
    await t.hold(1500);
    await t.click({ css: "button", text: "Uses" });
    await t.hold(2500);
    await t.still("Send to chain");
    await t.rec.stop();
    await t.reset();
  },
};
