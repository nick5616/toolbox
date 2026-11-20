// 39 Vault: create an encrypted vault (made-up passphrase), add files, lock, unlock.
const PASS = "demo-only passphrase 42";

export default {
  id: "vault",
  title: "Vault",
  tool: "Vault",
  kind: "a",
  roles: ["photo.dessert", "doc.pdf"],
  async run(t) {
    await t.rec.start();
    t.note(
      "A new Vault with a made-up passphrase: add two files (copies, originals untouched), lock it, then unlock it again.",
      "Keep private files encrypted on disk behind a passphrase."
    );
    await t.open("vault");
    if (await t.exists({ text: "Create vault" })) {
      await t.click({ css: "input", nth: 0 });
      await t.type(null, PASS);
      await t.click({ css: "input", nth: 1 });
      await t.type(null, PASS);
      await t.hold(500);
      await t.click({ css: "button", text: "Create vault" });
      await t.waitFor({ text: "I've saved it" });
      await t.hold(1800);
      await t.click({ text: "I've saved it" });
      await t.click({ css: "button", text: "Open vault" });
      await t.hold(1500);
    }
    const unlock = async () => {
      await t.click({ css: "input", nth: 0 });
      await t.type(null, PASS);
      await t.hold(400);
      await t.click({ css: "button", text: "Unlock" });
      await t.waitFor({ css: "button", text: "Lock" });
      await t.hold(1000);
    };
    if (await t.exists({ css: "button", text: "Unlock" })) await unlock();
    await t.handOff("vault", t.role("photo.dessert"), t.role("doc.pdf"));
    await t.hold(2500);
    await t.still("Vault with files");
    await t.click({ css: "button", text: "Lock", exact: true });
    await t.waitFor({ css: "button", text: "Unlock" });
    await t.hold(1500);
    await unlock();
    await t.hold(800);
    await t.rec.stop();
  },
};
