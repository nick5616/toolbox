#!/usr/bin/env node
// Films the demo scenes: node demo/run.mjs [--list] [--only 00,12] [--fresh] [--no-record] [--port 9230] [--out <dir>]
// See demo/README.md.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createActions } from "./capture/act.mjs";
import { defaultPaths, launchApp, removeCaptureState, supportsWorkspaceEnv, waitForSeed } from "./capture/app.mjs";
import { connect, sleep, VIEWPORT } from "./capture/cdp.mjs";
import { findFfmpeg, Recorder } from "./capture/record.mjs";
import { buildEntries, writeShotlist } from "./capture/shotlist.mjs";
import { copyExtras, seedLibraryFromAssets } from "./capture/workspace.mjs";
import { listFiles, loadRoles, roleStatus, sourceListing } from "./roles.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const o = { list: false, only: null, fresh: false, record: true, port: 9230, out: null, bin: null, tools: null, mode: null, keepFrames: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--list") o.list = true;
    else if (a === "--only") o.only = val().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--fresh") o.fresh = true;
    else if (a === "--no-record") o.record = false;
    else if (a === "--port") o.port = Number(val());
    else if (a === "--out") o.out = path.resolve(val());
    else if (a === "--bin") o.bin = path.resolve(val());
    else if (a === "--tools") o.tools = path.resolve(val());
    else if (a === "--legacy-env") o.mode = "legacy";
    else if (a === "--workspace-env") o.mode = "workspace";
    else if (a === "--keep-frames") o.keepFrames = true;
    else if (a === "--final") o.final = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

/** Scenes in demo/scenes, sorted by number. A scene file is NN-<id>.mjs exporting default {id, title, tool, roles, kind, run}. */
export async function loadScenes(dir = path.join(HERE, "scenes")) {
  const files = fs.readdirSync(dir).filter((f) => /^\d\d-.+\.mjs$/.test(f)).sort();
  const scenes = [];
  for (const f of files) {
    const mod = (await import(pathToFileURL(path.join(dir, f)).href)).default;
    const number = Number(f.slice(0, 2));
    scenes.push({ kind: "a", roles: [], restart: false, ...mod, number, file: f });
  }
  return scenes;
}

export function selectScenes(scenes, only) {
  if (!only) return scenes;
  const want = new Set(only.map((s) => (/^\d+$/.test(s) ? String(Number(s)) : s.toLowerCase())));
  return scenes.filter((s) => want.has(String(s.number)) || want.has(s.id.toLowerCase()));
}

function printList(scenes, doc, listing) {
  console.log(`Scenes (${scenes.length}):`);
  for (const s of scenes) {
    const st = s.roles.map((r) => roleStatus(doc, r, listing));
    const ok = st.every((x) => x.ok);
    console.log(`  ${String(s.number).padStart(2, "0")}  ${s.id.padEnd(14)} ${s.kind}  ${s.title}  [${s.tool ?? ""}]  ${ok ? "ready" : "MISSING ASSETS"}`);
    for (const r of st) {
      console.log(`        ${r.ok ? "ok     " : "missing"} ${r.name}${r.ok ? ` (${r.files.length})` : `: ${r.missing.join(", ") || "no files match"}`}`);
    }
  }
  console.log(`\nRoles (${Object.keys(doc.roles).length}):`);
  for (const name of Object.keys(doc.roles)) {
    const s = roleStatus(doc, name, listing);
    console.log(`  ${s.ok ? "ok     " : "missing"} ${name.padEnd(26)} ${s.files.length} file${s.files.length === 1 ? "" : "s"}${s.ok ? "" : `  (${s.missing.length} missing)`}${doc.roles[name].generated ? "  [generated: node demo/make-assets.mjs]" : ""}`);
  }
}

async function waitForUi(cdp) {
  const end = Date.now() + 60000;
  for (;;) {
    const ok = await cdp.eval(`!!(window._wails && window._wails.clientId && document.querySelector('[data-testid^="nav-"]'))`).catch(() => false);
    if (ok) return;
    // A fresh workspace opens on the first-run "Which tool packs do you want?" page; skip it (never filmed).
    await cdp
      .eval(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^skip for now$/i.test(x.textContent.trim()));if(b)b.click()})()`)
      .catch(() => {});
    if (Date.now() > end) {
      const why = await cdp.eval(`JSON.stringify({wails:!!window._wails,cid:!!(window._wails&&window._wails.clientId),navs:document.querySelectorAll('[data-testid^="nav-"]').length,body:document.body.innerText.slice(0,160)})`).catch((e) => String(e));
      throw new Error(`the app's window never showed its sidebar: ${why}`);
    }
    await sleep(400);
  }
}

export async function attach(port) {
  const cdp = await connect(port);
  await cdp.setViewport(VIEWPORT);
  const src = fs.readFileSync(path.join(HERE, "capture", "cursor.js"), "utf8") + "\n" + fs.readFileSync(path.join(HERE, "capture", "pagelib.js"), "utf8");
  await cdp.addInitScript(src);
  await cdp.eval(src);
  await waitForUi(cdp);
  return cdp;
}

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error(`Node 22 or newer is needed (this is ${process.version}); see CLAUDE.md for the PATH on the dev box`);
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(path.join(HERE, "README.md"), "utf8").split("\n").slice(0, 30).join("\n"));
    return;
  }
  const paths = defaultPaths();
  if (args.tools) paths.toolsDir = args.tools;
  if (args.bin) paths.bin = args.bin;
  if (args.final) {
    // The real filming run: inside the user's Demo workspace (never deleted), footage into its Library.
    if (args.fresh) throw new Error("--final never starts fresh: it films in the Demo workspace itself");
    if (!fs.existsSync(path.join(paths.demoRoot, ".toolbox", "workspace.json"))) throw new Error(`no Demo workspace at ${paths.demoRoot}`);
    paths.workspaceRoot = paths.demoRoot;
    paths.generatedDir = path.join(paths.demoRoot, "Library", "Extras");
    paths.outDir = path.join(paths.demoRoot, "Library", "Demo Footage");
  }
  const outDir = args.out ?? paths.outDir;
  const doc = loadRoles(path.join(HERE, "roles.json"));
  const allScenes = await loadScenes();
  const scenes = selectScenes(allScenes, args.only);
  const mode = args.mode ?? (supportsWorkspaceEnv(paths.repo) ? "workspace" : "legacy");

  if (args.list) {
    printList(scenes, doc, sourceListing(doc, paths));
    return;
  }
  if (scenes.length === 0) throw new Error("no scenes match --only");

  const ffmpeg = args.record ? findFfmpeg(paths.toolsDir) : null;
  if (args.fresh) removeCaptureState(paths, mode === "workspace" ? "workspace" : "legacy");
  if (mode === "legacy") {
    console.log(`TOOLBOX_WORKSPACE is not honoured by this build: using a sandbox support + library dir (GPS is not stripped in this mode).`);
    const n = seedLibraryFromAssets(doc, paths.assetsDir, paths.legacyLibrary);
    const e = copyExtras(paths.generatedDir, paths.legacyLibrary);
    console.log(`Library ready (${n} files copied, ${e} generated).`);
  }

  let app = null;
  let cdp = null;
  const cleanup = () => {
    try {
      cdp?.close();
    } catch {
      /* closing */
    }
    if (app && !app.exited()) app.stop();
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  const start = async () => {
    app = await launchApp({ paths, port: args.port, mode, bin: paths.bin });
    cdp = await attach(args.port);
    if (mode === "workspace") {
      console.log("Waiting for the Demo workspace to copy its starting files…");
      await waitForSeed(paths);
      copyExtras(paths.generatedDir, app.libraryDir);
    }
    console.log(`App up (pid ${app.pid}, ${mode} mode, ${app.libraryDir}).`);
  };

  const results = [];
  const failures = [];
  try {
    await start();
    const listing = listFiles(app.libraryDir);
    for (const scene of scenes) {
      const missing = scene.roles.map((r) => roleStatus(doc, r, listing)).filter((s) => !s.ok);
      if (missing.length) {
        console.log(`skip ${String(scene.number).padStart(2, "0")} ${scene.id}: missing ${missing.map((m) => m.name).join(", ")}`);
        continue;
      }
      if (scene.restart && results.length > 0) {
        cdp.close();
        app.stop();
        await sleep(1500);
        await start();
      }
      console.log(`scene ${String(scene.number).padStart(2, "0")} ${scene.id}: ${scene.title}`);
      const recorder = args.record ? new Recorder(cdp, { dir: path.join(paths.framesDir, `${scene.number}-${Date.now()}`), ffmpeg, keepFrames: args.keepFrames }) : null;
      const { t, state, isRecording } = createActions({
        cdp,
        recorder,
        roles: doc,
        libraryDir: app.libraryDir,
        listing,
        outDir,
        scene,
        appPid: app.pid,
        log: (m) => console.log(m),
      });
      try {
        await t.reset();
        await t.openLibrary();
        t.markJobs();
        await scene.run(t);
        if (isRecording()) {
          console.log("  (scene did not stop its recording: stopping)");
          await t.rec.stop();
        }
        results.push({ scene, ...state, clips: state.clips, assets: [...state.assets] });
      } catch (e) {
        console.error(`  FAILED: ${e.message}`);
        failures.push({ scene: scene.id, error: e.message });
        await recorder?.abort().catch(() => {});
        try {
          const f = path.join(outDir, "failed", `${String(scene.number).padStart(2, "0")} ${scene.id}.png`);
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, await cdp.screenshot());
          console.error(`  screenshot: ${f}`);
        } catch {
          /* best effort */
        }
        results.push({ scene, ...state, clips: state.clips, assets: [...state.assets] });
      }
    }
  } finally {
    cleanup();
  }
  if (results.length) {
    const entries = buildEntries(results);
    writeShotlist(outDir, entries, results.map((r) => r.scene.id));
    console.log(`Shot list: ${path.join(outDir, "shotlist.md")}`);
  }
  console.log(failures.length ? `${failures.length} scene(s) failed.` : "Done.");
  if (failures.length) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((e) => {
    console.error(e.stack ?? e.message);
    process.exitCode = 1;
  });
}
