// 72 Palette and shortcuts: the command palette opens tools and runs actions, "?" lists the shortcuts, pinning gives a tool a number.
const PALETTE = { css: '[role="dialog"][aria-label="Command palette"]' };

async function palette(t, query, { enter = true, show = 1400 } = {}) {
  await t.key("Mod+K");
  await t.waitFor(PALETTE);
  await t.hold(500);
  await t.type(null, query);
  await t.hold(show);
  if (enter) await t.key("Enter", { chip: false });
  await t.hold(900);
}

export default {
  id: "palette-shortcuts",
  title: "Palette and shortcuts",
  tool: "Toolbox",
  kind: "a",
  roles: [],
  async run(t) {
    await t.rec.start();
    t.note("Ctrl+K opens the command palette: type a few letters of any tool and press Enter to open it.", "Press Control K and type: any tool is a few keystrokes away.");
    await t.hold(700);
    await palette(t, "scene");
    await palette(t, "ocr");

    t.note("The palette runs actions too: it opens the job tray, and shows the other actions you can run without clicking around.", "It does actions as well, like opening the job tray.");
    await palette(t, "job tray");
    await t.hold(1400);
    await t.key("Mod+J");
    await t.hold(900);

    t.note("Press ? for the list of keyboard shortcuts.", "Press the question mark for every shortcut in one list.");
    await t.click({ css: "main" });
    // "?" is a shifted character: the harness' key() has no name for it, so send the keydown the app listens for.
    await t.eval(`(()=>{window.__demoCursor.chip("?");const o={key:"?",code:"Slash",shiftKey:true,bubbles:true,cancelable:true};document.body.dispatchEvent(new KeyboardEvent("keydown",o));document.body.dispatchEvent(new KeyboardEvent("keyup",o));return 1})()`);
    await t.hold(600);
    await t.waitFor({ css: '[role="dialog"][aria-label="Keyboard shortcuts"]' });
    await t.hold(3400);
    await t.key("Escape", { chip: false });
    await t.hold(700);

    t.note("Pin a tool: it moves to the top of the sidebar and gets a number. Ctrl+1 opens it from anywhere.", "Pin the tools you use most, and each one gets a number, so Control 1 jumps straight to it.");
    await t.hover({ css: '[data-testid="nav-transcribe"]' }, 700);
    await t.click({ css: '[aria-label="Pin Transcribe"]' });
    await t.hold(1500);
    await t.open("library");
    await t.hold(700);
    await t.key("Mod+1");
    await t.hold(1800);
    await t.key("Mod+L");
    await t.hold(1200);
    await t.key("Mod+,");
    await t.hold(1500);
    await t.key("Mod+L");
    await t.hold(800);
    await t.still("Palette and shortcuts");

    // Leave the sidebar as it was.
    await t.hover({ css: '[data-testid="nav-transcribe"]' }, 500);
    await t.click({ css: '[aria-label="Unpin Transcribe"]' });
    await t.hold(1200);
    await t.rec.stop();
  },
};
