// 41 Focus Lock: a profile, a 25 minute session, the top-bar pill counts down. Always a dry run in the capture app.
export default {
  id: "focus",
  title: "Focus Lock",
  tool: "Focus Lock",
  kind: "a",
  roles: [],
  async run(t) {
    // The "Blocked recently" list names the programs running on this machine: hide it for filming.
    await t.eval(`(()=>{clearInterval(window.__hideBlocked);window.__hideBlocked=setInterval(()=>{for(const e of document.querySelectorAll("span,div,p")){if(e.children.length===0&&/^would stop/i.test(e.textContent.trim())){let r=e;while(r.parentElement&&r.parentElement.children.length<3)r=r.parentElement;const list=r.parentElement;if(list&&list.dataset.demoHidden!=="1"){list.dataset.demoHidden="1";list.style.display="none"}}}},60)})()`);
    await t.rec.start();
    t.note(
      "Focus Lock in a dry run (it decides and logs but never closes anything): a profile of the apps to keep, 25 minutes, a soft lock, Start; the pill in the top bar counts down; then the session ends.",
      "Pick the apps you need, start a timed session, and everything else stays out of your way."
    );
    await t.open("focus");
    await t.hold(1200);
    if (await t.exists({ css: "button", text: "Create", exact: true })) {
      await t.click({ css: "button", text: "Create", exact: true });
      await t.hold(1800);
    }
    await t.click({ css: "button", text: "25 min" });
    await t.hold(600);
    await t.click({ css: "button", text: "Soft", exact: true });
    await t.hold(900);
    await t.click({ css: "button", textRe: "^Start" });
    await t.hold(6000);
    await t.still("Focus Lock");
    if (await t.exists({ css: "button", textRe: "^End" })) {
      await t.click({ css: "button", textRe: "^End" });
      await t.hold(1500);
    }
    await t.rec.stop();
    await t.reset();
  },
};
