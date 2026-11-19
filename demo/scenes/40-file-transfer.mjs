// 40 File Transfer: the send screen and the receive modes explained. Receiving stays OFF; nothing is sent, no settings are changed.
export default {
  id: "file-transfer",
  title: "File Transfer",
  tool: "Local File Transfer",
  kind: "a",
  roles: [],
  async run(t) {
    await t.rec.start();
    t.note(
      "Local File Transfer with receiving Off: the three receive modes (hover for what each means), the send box, and Add by address for a device that does not show up. Nothing is sent and nothing listens.",
      "Send files to your phone or another computer over your own network, with nothing listening until you say so."
    );
    await t.open("lan-share");
    await t.hold(1200);
    await t.hover({ css: "button", text: "Off", exact: true }, 1400);
    await t.hover({ css: "button", text: "While open", exact: true }, 1800);
    await t.hover({ css: "button", text: "Always", exact: true }, 1800);
    await t.hover({ css: "button", textRe: "^Send" }, 1500);
    await t.type('input[placeholder^="Send text"]', "Notes for the other laptop");
    await t.hold(1200);
    await t.click({ text: "Add by address" });
    await t.hold(2200);
    await t.still("File Transfer");
    await t.key("Escape", { chip: false });
    await t.rec.stop();
    await t.reset();
  },
};
