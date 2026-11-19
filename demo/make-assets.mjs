#!/usr/bin/env node
// Generates the demo's missing media roles into <repo>/.dev/demo-generated/ (SPEC section 0).
//
//   node demo/make-assets.mjs              both steps
//   node demo/make-assets.mjs --offline    step 1 only: article, stems mix, B-roll (FFmpeg and Pillow, no app)
//   node demo/make-assets.mjs --app        step 2 only: narration, talk video, noisy audio and PDF, made by
//                                          driving the running app (Text to Speech + Document Converter)
//   options: --force (regenerate), --port 9232, --only broll,stems,article,talk,noisy,pdf
//
// Output names match demo/roles.json (without the "Extras/" prefix). demoAssets/ is only read.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultPaths, launchApp, supportsWorkspaceEnv } from "./capture/app.mjs";
import { findFfmpeg } from "./capture/record.mjs";
import { loadRoles } from "./roles.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const ARTICLE_NAME = "Ten basic drum beats, explained.md";
export const NARRATION = [
  "Almost every song you know is built on a small handful of drum patterns. Learn these ten and you can recognise the engine underneath most pop, rock, funk and electronic music.",
  "Number one: the eighth-note rock beat. The hi-hat plays on every count and every and. The kick lands on one and three, and the snare lands on two and four.",
  "Number two: the quarter-note pulse. The same kick and snare, but the hi-hat plays only on the counts. It sounds calmer, and it leaves more space for a singer.",
  "Number three: four on the floor. The kick drum plays on every count, with a clap on two and four. It is the backbone of dance music, and it makes people move without thinking about it.",
  "Start slowly, around sixty beats per minute, with a metronome. Play each pattern for one full minute without speeding up. Count out loud, because counting is what keeps your hands and feet in time.",
];
/** Seconds of silence after each paragraph: deliberate pauses for the Silence Cutter scene. */
export const GAPS = [1.4, 1.2, 1.2, 3.0, 0];
const TALK_PHOTOS = ["IMG_3409", "IMG_4265", "IMG_3771", "IMG_4227", "IMG_3249", "IMG_3935", "IMG_3677", "IMG_4160"];

function run(bin, args, { quiet = true } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("exit", (c) => (c === 0 ? resolve(out) : reject(new Error(`${path.basename(bin)} exited ${c}: ${err.slice(-600)}`))));
  });
}

/** Pure: FFmpeg arguments for a 1080p30 Ken Burns clip from one still. `variant` alternates zoom in/out and pan direction. */
export function kenBurnsArgs({ image, out, seconds, variant = 0, fps = 30, w = 1920, h = 1080 }) {
  const frames = Math.round(seconds * fps);
  const zoomIn = variant % 2 === 0;
  const z = zoomIn ? `1+0.14*on/${frames}` : `1.14-0.14*on/${frames}`;
  const pan = variant % 3 === 0 ? `(iw-iw/zoom)*on/${frames}` : variant % 3 === 1 ? `(iw-iw/zoom)*(1-on/${frames})` : `(iw-iw/zoom)/2`;
  const vf =
    `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase,crop=${w * 2}:${h * 2},` +
    `zoompan=z='${z}':x='${pan}':y='(ih-ih/zoom)/2':d=${frames}:s=${w}x${h}:fps=${fps},format=yuv420p`;
  return ["-y", "-hide_banner", "-loglevel", "error", "-i", image, "-vf", vf, "-frames:v", String(frames), "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", out];
}

/** Pure: FFmpeg arguments that join narration clips with silences between them (mono, 48 kHz WAV). */
export function narrationArgs({ wavs, gaps, out }) {
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  const labels = [];
  let n = 0;
  wavs.forEach((w, i) => {
    args.push("-i", w);
    labels.push(`[a${i}]`);
    if (gaps[i] > 0) {
      args.push("-f", "lavfi", "-t", String(gaps[i]), "-i", "anullsrc=r=48000:cl=mono");
    }
  });
  // Inputs alternate: clip, (silence)?, clip, ... in the order added above.
  const parts = [];
  const order = [];
  let idx = 0;
  wavs.forEach((_, i) => {
    parts.push(`[${idx}:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=mono[c${n}]`);
    order.push(`[c${n++}]`);
    idx++;
    if (gaps[i] > 0) {
      parts.push(`[${idx}:a]aformat=sample_fmts=s16:channel_layouts=mono[c${n}]`);
      order.push(`[c${n++}]`);
      idx++;
    }
  });
  parts.push(`${order.join("")}concat=n=${order.length}:v=0:a=1[a]`);
  args.push("-filter_complex", parts.join(";"), "-map", "[a]", out);
  return args;
}

/** Pure: noisy version of the narration: pink noise at -28 dB and a 60 Hz hum. */
export function noisyArgs({ narration, out }) {
  return [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", narration,
    "-f", "lavfi", "-i", "anoisesrc=color=pink:r=48000:amplitude=1.0",
    "-f", "lavfi", "-i", "sine=frequency=60:sample_rate=48000",
    "-filter_complex", "[1:a]volume=-28dB[n];[2:a]volume=-34dB[h];[0:a]aresample=48000[v];[v][n][h]amix=inputs=3:normalize=0:duration=first:dropout_transition=0[a]",
    "-map", "[a]", "-c:a", "pcm_s16le", out,
  ];
}

function pythonFor(toolsDir) {
  const win = path.join(toolsDir, "sidecar", ".venv", "Scripts", "python.exe");
  const nix = path.join(toolsDir, "sidecar", ".venv", "bin", "python");
  return [win, nix].find((p) => fs.existsSync(p));
}

async function durationOf(ffmpeg, file) {
  const probe = ffmpeg === "ffmpeg" ? "ffprobe" : path.join(path.dirname(ffmpeg), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  const out = await run(probe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  return Number(out.trim());
}

/** Upright, metadata-free JPEGs of the named photos in tmp/, using the engine's Pillow. */
async function photoJpegs(ctx, stems) {
  const py = pythonFor(ctx.paths.toolsDir);
  if (!py) throw new Error("the AI engine's Python was not found under the tools folder (needed to read HEIC)");
  const dir = path.join(ctx.tmp, "photos");
  const need = stems.filter((s) => !fs.existsSync(path.join(dir, s + ".jpg")));
  if (need.length) {
    const inputs = need.map((s) => {
      const f = [".HEIC", ".heic", ".JPG", ".jpg"].map((e) => path.join(ctx.paths.assetsDir, s + e)).find((p) => fs.existsSync(p));
      if (!f) throw new Error(`photo ${s} not found in ${ctx.paths.assetsDir}`);
      return f;
    });
    await run(py, ["-I", path.join(HERE, "tools", "heic2jpg.py"), dir, "3200", ...inputs]);
  }
  return stems.map((s) => path.join(dir, s + ".jpg"));
}

const have = (ctx, name) => fs.existsSync(path.join(ctx.out, name)) && !ctx.force;

// --- step 1: offline ---------------------------------------------------------

async function makeArticle(ctx) {
  const dest = path.join(ctx.out, ARTICLE_NAME);
  if (have(ctx, ARTICLE_NAME)) return log("article: present");
  fs.copyFileSync(path.join(HERE, "assets", "ten-basic-drum-beats.md"), dest);
  log(`article: ${ARTICLE_NAME}`);
}

async function makeStemsMix(ctx) {
  const name = "Misery Business (from stems).flac";
  if (have(ctx, name)) return log("stems mix: present");
  const stems = ["Vocals", "Drums", "Bass", "Other"].map((k) => path.join(ctx.paths.assetsDir, `Paramore-Misery business (Lyrics) [4dvcXBNIwYU] - ${k}.flac`));
  for (const s of stems) if (!fs.existsSync(s)) throw new Error(`missing stem ${s}`);
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const s of stems) args.push("-i", s);
  args.push("-filter_complex", "amix=inputs=4:normalize=0,alimiter=limit=0.97", "-c:a", "flac", path.join(ctx.out, name));
  await run(ctx.ffmpeg, args);
  log(`stems mix: ${name}`);
}

async function makeBroll(ctx) {
  const rows = [
    ["B-roll 1 - Rain.mp4", "IMG_3409"],
    ["B-roll 2 - Bridge.mp4", "IMG_4265"],
    ["B-roll 3 - Skyline.mp4", "IMG_3771"],
    ["B-roll 4 - Ferris wheel.mp4", "IMG_4227"],
    ["B-roll 5 - Park.mp4", "IMG_3249"],
    ["B-roll 6 - Painting.mp4", "IMG_3935"],
  ];
  const todo = rows.filter(([n]) => !have(ctx, n));
  if (!todo.length) return log("B-roll: present");
  const jpgs = await photoJpegs(ctx, todo.map(([, s]) => s));
  for (let i = 0; i < todo.length; i++) {
    await run(ctx.ffmpeg, kenBurnsArgs({ image: jpgs[i], out: path.join(ctx.out, todo[i][0]), seconds: 12, variant: i }));
    log(`B-roll: ${todo[i][0]}`);
  }
}

// --- step 2: through the running app -------------------------------------------

function appCaller(cdp) {
  const call = (name, args) => cdp.eval(`window.__demo.call(${cdp.lit(name)}, ${cdp.lit(args)})`);
  const waitJobs = async (jobs, timeoutMs = 20 * 60000) => {
    const ids = (jobs ?? []).map((j) => j.id);
    const end = Date.now() + timeoutMs;
    for (;;) {
      const now = await Promise.all(ids.map((id) => call("toolbox/api.JobsService.Get", [id])));
      const bad = now.find((j) => j.status === "failed" || j.status === "cancelled");
      if (bad) throw new Error(`job ${bad.title} ${bad.status}: ${bad.error}`);
      if (now.every((j) => j.status === "done")) return now;
      if (Date.now() > end) throw new Error("timed out waiting for the app's jobs");
      await sleep(1500);
    }
  };
  return { call, waitJobs };
}

async function makeNarration(ctx, app) {
  const narr = path.join(ctx.out, "_narration.wav");
  if (fs.existsSync(narr) && !ctx.force) return narr;
  const wavs = [];
  for (let i = 0; i < NARRATION.length; i++) {
    const jobs = await app.call("toolbox/modules/tts.Service.SpeakText", [NARRATION[i], { voice: "am_michael", speed: 1, split: "none", format: "wav", preview: false }]);
    const done = await app.waitJobs(jobs);
    const file = done.flatMap((j) => j.outputs ?? [])[0]?.path;
    if (!file) throw new Error("Text to Speech produced no file");
    const keep = path.join(ctx.tmp, `narration-${i}.wav`);
    fs.mkdirSync(ctx.tmp, { recursive: true });
    fs.copyFileSync(file, keep);
    wavs.push(keep);
    log(`narration ${i + 1}/${NARRATION.length}`);
  }
  await run(ctx.ffmpeg, narrationArgs({ wavs, gaps: GAPS, out: narr }));
  return narr;
}

async function makeTalk(ctx, narr) {
  const name = "Ten basic drum beats - narration.mp4";
  if (have(ctx, name)) return log("talk video: present");
  const dur = await durationOf(ctx.ffmpeg, narr);
  const jpgs = await photoJpegs(ctx, TALK_PHOTOS);
  const each = dur / TALK_PHOTOS.length + 0.05;
  const clips = [];
  for (let i = 0; i < jpgs.length; i++) {
    const c = path.join(ctx.tmp, `talk-${i}.mp4`);
    await run(ctx.ffmpeg, kenBurnsArgs({ image: jpgs[i], out: c, seconds: each, variant: i }));
    clips.push(c);
  }
  const list = path.join(ctx.tmp, "talk.txt");
  fs.writeFileSync(list, clips.map((c) => `file '${c.replace(/\\/g, "/")}'`).join("\n") + "\n");
  await run(ctx.ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-i", narr, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", path.join(ctx.out, name)]);
  log(`talk video: ${name} (${dur.toFixed(0)} s)`);
}

async function makeNoisy(ctx, narr) {
  const name = "Ten basic drum beats - narration (noisy).wav";
  if (have(ctx, name)) return log("noisy audio: present");
  await run(ctx.ffmpeg, noisyArgs({ narration: narr, out: path.join(ctx.out, name) }));
  log(`noisy audio: ${name}`);
}

async function makePdf(ctx, app) {
  const name = "Ten basic drum beats, explained.pdf";
  if (have(ctx, name)) return log("pdf: present");
  const md = path.join(ctx.out, ARTICLE_NAME);
  const opts = { to: "pdf", pageSize: "a4", marginMm: 30, mainFont: "", fontSizePt: 13, toc: true, numberSections: false, referenceDoc: "", embedResources: true, extractMedia: false };
  const jobs = await app.call("toolbox/modules/documents.Service.Enqueue", [[md], opts]);
  const done = await app.waitJobs(jobs);
  const file = done.flatMap((j) => j.outputs ?? [])[0]?.path;
  if (!file) throw new Error("Document Converter produced no file");
  fs.copyFileSync(file, path.join(ctx.out, name));
  log(`pdf: ${name} (check it is 4 pages)`);
}

async function appStep(ctx, only) {
  const { attach } = await import("./run.mjs");
  const mode = supportsWorkspaceEnv(ctx.paths.repo) ? "workspace" : "legacy";
  const app = await launchApp({ paths: ctx.paths, port: ctx.port, mode });
  let cdp = null;
  try {
    cdp = await attach(ctx.port);
    const caller = appCaller(cdp);
    const want = (k) => !only || only.includes(k);
    const narr = want("talk") || want("noisy") ? await makeNarration(ctx, caller) : null;
    if (want("talk")) await makeTalk(ctx, narr);
    if (want("noisy")) await makeNoisy(ctx, narr);
    if (want("pdf")) await makePdf(ctx, caller);
  } finally {
    await cdp?.close();
    app.stop();
  }
}

const log = (m) => console.log(m);

export async function main(argv) {
  const get = (f) => argv.includes(f);
  const val = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
  const paths = defaultPaths();
  const ctx = { paths, out: paths.generatedDir, tmp: path.join(paths.repo, ".dev", "demo-generated-tmp"), force: get("--force"), port: Number(val("--port", 9232)), ffmpeg: findFfmpeg(paths.toolsDir) };
  fs.mkdirSync(ctx.out, { recursive: true });
  fs.mkdirSync(ctx.tmp, { recursive: true });
  loadRoles(path.join(HERE, "roles.json")); // fails early when the mapping is broken
  const only = val("--only", null)?.split(",") ?? null;
  const want = (k) => !only || only.includes(k);
  if (!get("--app")) {
    if (want("article")) await makeArticle(ctx);
    if (want("stems")) await makeStemsMix(ctx);
    if (want("broll")) await makeBroll(ctx);
  }
  if (!get("--offline")) {
    if (!fs.existsSync(path.join(ctx.out, ARTICLE_NAME))) await makeArticle(ctx);
    try {
      await appStep(ctx, only);
    } catch (e) {
      console.error(`app step failed: ${e.message}\n(re-run with --app once Text to Speech and Document Converter work in the capture app)`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.stack ?? e.message);
    process.exitCode = 1;
  });
}
