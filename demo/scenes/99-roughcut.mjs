// 99 Rough cut (SPEC §D3): builds "Demo — rough cut", a Video Editor project in the Demo workspace,
// from the filmed A-roll. Nothing is recorded. Run it after the footage: node demo/run.mjs --final --only 99
//   V1: the A-roll in shot-list order with 0.5 s crossfades
//   V2: empty, for your B-roll
//   A1: song.alt at −14 dB with a 3 s fade-out, as long as the cut
//   a ruler marker per scene, named
import fs from "node:fs";
import path from "node:path";

const NAME = "Demo — rough cut";
const XFADE_MS = 500;

const clipBase = {
  color: "", inMs: 0, speed: "", slow: "blend", volume: 1, fit: "fit", fitColor: "#000000", flipX: false, blend: "normal",
  transform: "", matte: null, fxTarget: "clip", masks: "", effects: "", in: "", text: "", visual: "", pinned: false, auto: false,
};

export default {
  id: "roughcut",
  title: "Rough cut project",
  tool: "Video Editor",
  kind: "setup",
  roles: ["song.alt"],
  async run(t) {
    const listFile = path.join(t.outDir, "shotlist.json");
    if (!fs.existsSync(listFile)) throw new Error(`no shot list at ${listFile}: film the scenes first`);
    const entries = JSON.parse(fs.readFileSync(listFile, "utf8"));
    const list = Array.isArray(entries) ? entries : entries.entries ?? [];
    const aroll = list.filter((e) => e.kind === "a-roll" && e.duration > 0).sort((a, b) => a.n - b.n || a.file.localeCompare(b.file));
    if (!aroll.length) throw new Error("the shot list has no A-roll clips");

    const svc = (m, ...a) => t.svc("toolbox/modules/editstudio.Service", m, ...a);
    const old = ((await svc("List")) ?? []).filter((p) => p.name === NAME);
    for (const p of old) await svc("Delete", p.id); // rebuilt from scratch on each run

    const info = await svc("Create", NAME, "16:9", 30);
    const doc = await svc("Get", info.id);
    const clips = [];
    const custom = [];
    let at = 0;
    for (const [i, e] of aroll.entries()) {
      const file = path.join(t.outDir, ...e.file.split("/"));
      const len = Math.round(e.duration * 1000);
      const start = at; // clips touch; the incoming clip's crossfade plays the outgoing one past its end
      clips.push({ ...clipBase, id: `a${String(i).padStart(3, "0")}`, kind: "video", path: file, startMs: start, endMs: start + len, in: i === 0 ? "" : JSON.stringify({ kind: "crossfade", ms: XFADE_MS }) });
      custom.push({ id: `m${String(e.n).padStart(2, "0")}${i}`, ms: start, label: `${String(e.n).padStart(2, "0")} ${e.tool}`.slice(0, 40) });
      at = start + len;
    }
    const song = t.role("song.alt");
    const songMs = (((await svc("Probe", [song])) ?? [])[0]?.durationMs ?? at) || at;
    doc.sources = [...aroll.map((e) => ({ path: path.join(t.outDir, ...e.file.split("/")), tags: [] })), { path: song, tags: [] }];
    doc.tracks = [
      { id: "a1", kind: "audio", name: "A1 Music", muted: false, locked: false, matte: "", clips: [{ ...clipBase, id: "music", kind: "audio", path: song, startMs: 0, endMs: Math.min(at, songMs), gain: JSON.stringify({ base: -14 }), fadeOutMs: 3000 }] },
      { id: "v1", kind: "video", name: "V1 A-roll", muted: false, locked: false, matte: "", clips },
      { id: "v2", kind: "video", name: "V2 B-roll", muted: false, locked: false, matte: "", clips: [] },
    ];
    doc.markers = { ...(doc.markers ?? {}), custom };
    doc.export = { fps: 30, codec: "h264", quality: "good", audioKbps: 192, inMs: 0, outMs: 0 };
    await svc("Save", info.id, NAME, doc);
    await svc("Prepare", info.id, doc.sources.map((s) => s.path), 30);
    // Wait for the edit streams, so the project opens ready to play (quitting would interrupt the job).
    await t.waitJob({ timeoutMs: 40 * 60000 });
    t.note(`"${NAME}": ${aroll.length} A-roll clips (${Math.round(at / 1000)} s), song.alt bed, a marker per scene.`, "");
  },
};
