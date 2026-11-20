// 42 Dev Utilities: format JSON, hash some text, convert a colour.
export default {
  id: "dev-utils",
  title: "Dev Utilities",
  tool: "Dev Utilities",
  kind: "a",
  roles: [],
  async run(t) {
    await t.rec.start();
    t.note(
      "Dev Utilities: paste compact JSON and it is formatted; switch to Hash for the digests of a line of text; Colour converts a hex colour to every notation.",
      "The small converters you reach for every day, offline, in one place."
    );
    await t.open("dev-utils");
    await t.hold(800);
    const panel = async (name) => {
      await t.click({ css: "button", textRe: "^Utilities\\s*\\w+" });
      await t.hold(600);
      await t.click({ css: "button", text: name, exact: true });
      await t.hold(900);
    };
    // The tool reopens on the last panel used (an earlier take ended on Colour).
    if (!(await t.exists({ css: "textarea" }))) await panel("JSON");
    await t.click({ css: "textarea", nth: 0 });
    await t.key("Mod+A", { chip: false });
    await t.type(null, '{"tool":"Toolbox","tags":["media","ai","utility"],"local":true,"version":{"major":1,"minor":4}}');
    await t.hold(1800);
    await panel("Hash");
    await t.click({ css: "textarea", nth: 0 });
    await t.type(null, "hello from the demo");
    await t.hold(2200);
    await panel("Colour");
    await t.hold(800);
    await t.click({ css: "main input", nth: 0 });
    await t.key("Mod+A", { chip: false });
    await t.type(null, "#ff6b35");
    await t.hold(2200);
    await t.still("Dev Utilities");
    await t.rec.stop();
    await t.reset();
  },
};
