// 78 Chat about a transcript: the narration's transcript goes to Local Chat as attached text, a suggested question is
// asked, then a typed follow-up. Nothing is copied to the clipboard: the transcript travels through the app.
import { chatAsk, openTool, scrubPaths } from "./_d2b.mjs";
import { awaitChatAnswer } from "./_d4c.mjs";

export default {
  id: "chat-files",
  title: "Chat about a transcript",
  tool: "Local Chat",
  kind: "a",
  roles: ["video.talk"],
  async run(t) {
    // Untimed set-up: the transcript (it is a result of the Transcribe tool, which Local Chat reads from).
    const opts = await t.svc("toolbox/modules/transcribe.Service", "Defaults");
    await t.openLibrary();
    await t.svc("toolbox/modules/transcribe.Service", "Enqueue", [t.role("video.talk")], opts);
    await t.waitJob({ compress: false, timeoutMs: 30 * 60000 });
    await openTool(t, "transcribe", "Transcribe");
    await scrubPaths(t);

    await t.rec.start();
    t.note("The finished transcript has an Ask Local Chat button: it opens a chat with the text attached.", "Any text a tool makes can be handed to the chat, with nothing copied or pasted.");
    await t.hold(1500);
    await t.click({ css: "button", text: "Ask Local Chat", nth: 0 });
    await t.waitFor({ css: '[aria-label="Attached text"]' });
    await t.hold(1200);
    await t.click({ css: '[aria-label="Attached text"] button', text: "Read" });
    await t.hold(2400);
    await t.click({ css: '[aria-label="Attached text"] button', text: "Hide" });
    await t.hold(600);

    t.note("A suggested question, then a follow-up typed in.", "Ask for a summary, then dig in with your own questions.");
    await t.click({ css: '[aria-label="Suggested prompts"] button', text: "Key points" });
    await awaitChatAnswer(t);
    await t.hold(800);
    await chatAsk(t, "Which of those beats should a beginner learn first?");
    await t.hold(1500);
    await t.still("Chat about a transcript");
    await t.rec.stop();
    await t.reset();
  },
};
