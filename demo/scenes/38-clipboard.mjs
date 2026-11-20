// 38 Clipboard: record test strings and show the history. Needs no other Toolbox running (its recorder would see the copies).
// Only strings made here are copied; the previous clipboard text is restored in `finally`.
export default {
  id: "clipboard",
  title: "Clipboard",
  tool: "Clipboard History",
  kind: "a",
  roles: [],
  async run(t) {
    t.requireNoOtherToolbox();
    const copy = (s) =>
      t.eval(`(()=>{const a=document.createElement("textarea");a.value=${JSON.stringify(s)};a.style.position="fixed";a.style.opacity="0";document.body.appendChild(a);a.focus();a.select();const ok=document.execCommand("copy");a.remove();return ok})()`);
    let previous = null;
    try {
      previous = await t.eval(`navigator.clipboard.readText().catch(()=>null)`);
    } catch {
      previous = null;
    }
    try {
      await t.rec.start();
      t.note(
        "Clipboard History: recording is off until asked; start it, copy a few test strings, and the history lists them, searchable. Nothing here is a real copy.",
        "Never lose something you copied: a private, searchable clipboard history."
      );
      await t.open("clipboard");
      if (await t.exists({ css: "button", text: "Start recording clipboard history" })) {
        await t.click({ css: "button", text: "Start recording clipboard history" });
        await t.hold(1200);
      }
      for (const s of ["https://example.com/demo-page", "Meeting notes: ship the demo on Friday", "#ff6b35"]) {
        await copy(s);
        await t.hold(1600);
      }
      await t.hold(1200);
      await t.still("Clipboard");
      await t.rec.stop();
    } finally {
      if (previous !== null) await t.eval(`navigator.clipboard.writeText(${JSON.stringify(previous)}).catch(()=>{})`).catch(() => {});
    }
  },
};
