#!/usr/bin/env node
// Ready-to-post cuts of the demo footage: node demo/cuts.mjs [--footage <dir>] [--only shorts,teasers,gifs,sizzle,reels]
//   [--music <file>] [--force]
//
// Reads <footage>/shotlist.json and the clips next to it (default: workspaces/demo/Library/Demo Footage) and writes
// <footage>/Cuts/:
//   Shorts 9x16/NN Title.mp4    1080x1920: the clip over a blurred copy of itself, the tool's name above, its one-line
//                               voice-over below (<= 59 s)
//   Teasers 16x9/NN Title.mp4   the clip's last 10 s (where the result shows) with a lower-third title
//   GIFs/NN Title.gif           the teaser as a 960 px GIF
//   Sizzle reel.mp4             4 s of every A-roll clip with its name, opening and closing cards, a music bed
//   Sizzle reel 60s.mp4         the same with 13 headline tools; "(no music)" versions of both
//   Visualizer reel.mp4         4 s of every Showcase/Visualizer render, with its own sound and the preset name
//   Color Grader reel.mp4       2.5 s of every Showcase/Color Grader export, with the look's name
// Existing outputs are kept unless --force. FFmpeg runs in a temp dir with relative names only (no Windows paths
// inside filter graphs). Titles use Segoe UI (Windows) or Helvetica (macOS).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultPaths } from "./capture/app.mjs";
import { findFfmpeg } from "./capture/record.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const o = { footage: null, only: null, music: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--footage") o.footage = path.resolve(val());
    else if (a === "--only") o.only = new Set(val().split(",").map((s) => s.trim()));
    else if (a === "--music") o.music = path.resolve(val());
    else if (a === "--force") o.force = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

/** Splits text into lines of at most `width` characters, on spaces. */
export function wrap(text, width) {
  const lines = [];
  let line = "";
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line && (line + " " + word).length > width) {
      lines.push(line);
      line = word;
    } else line = line ? line + " " + word : word;
  }
  if (line) lines.push(line);
  return lines;
}

/** The teaser window: the 10 s before the clip's end handle (where results show), or the whole clip. */
export function teaserWindow(duration, length = 10, endHandle = 1) {
  if (duration <= length + endHandle) return { start: 0, length: Math.max(0.5, duration) };
  return { start: +(duration - endHandle - length).toFixed(2), length };
}

/** A clip's title: its file name without the scene number ("09 Video Editor I.mp4" -> "Video Editor I"). */
export function titleOf(entry) {
  return path.basename(entry.file, path.extname(entry.file)).replace(/^\d+\s+/, "");
}

// The headline tools for the 60 s reel, by scene id (missing ones are skipped).
const HEADLINE = ["tour", "grade", "visualizer", "edit-studio", "video-editor-1", "stems", "paint", "smart-search", "lyric-video", "bgremove", "eraser", "pipelines", "chat"];

function fontFiles() {
  const win = process.env.WINDIR ?? "C:\\Windows";
  const cands = [
    [path.join(win, "Fonts", "segoeuib.ttf"), path.join(win, "Fonts", "segoeui.ttf")],
    ["/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Helvetica.ttc"],
  ];
  for (const [bold, reg] of cands) if (fs.existsSync(bold) && fs.existsSync(reg)) return { bold, reg };
  throw new Error("no title font found (Segoe UI or Helvetica)");
}

class Work {
  constructor(ffmpeg, fonts) {
    this.ffmpeg = ffmpeg;
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolbox-cuts-"));
    fs.copyFileSync(fonts.bold, path.join(this.dir, "bold.ttf"));
    fs.copyFileSync(fonts.reg, path.join(this.dir, "reg.ttf"));
    this.n = 0;
  }
  /** Writes a text file in the work dir and returns its relative name (for drawtext textfile=). */
  text(s) {
    const name = `t${++this.n}.txt`;
    fs.writeFileSync(path.join(this.dir, name), s, "utf8");
    return name;
  }
  /** Runs FFmpeg in the work dir with the graph in a file. Inputs and the output are absolute paths (args only). */
  run(args, graph) {
    const full = ["-hide_banner", "-loglevel", "error", "-y", ...args];
    if (graph !== undefined) {
      const g = `g${++this.n}.txt`;
      fs.writeFileSync(path.join(this.dir, g), graph, "utf8");
      const at = full.indexOf("-map");
      full.splice(at < 0 ? full.length - 1 : at, 0, "-/filter_complex", g);
    }
    const r = spawnSync(this.ffmpeg, full, { cwd: this.dir, encoding: "utf8", windowsHide: true, maxBuffer: 64 << 20 });
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${(r.stderr || "").trim().split("\n").slice(-6).join("\n")}`);
  }
  close() {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

const ENC = ["-c:v", "libx264", "-crf", "19", "-preset", "medium", "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart"];
const esc = (s) => String(s).replace(/[\\':]/g, (c) => "\\" + c);

function probeDuration(ffmpeg, file) {
  const probe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m, ext) => "ffprobe" + (ext ?? ""));
  const r = spawnSync(probe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", file], { encoding: "utf8", windowsHide: true });
  const d = Number(r.stdout.trim());
  return Number.isFinite(d) ? d : 0;
}

function hasAudio(ffmpeg, file) {
  const probe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m, ext) => "ffprobe" + (ext ?? ""));
  const r = spawnSync(probe, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file], { encoding: "utf8", windowsHide: true });
  return r.stdout.trim() !== "";
}

function short(w, src, out, title, vo, duration) {
  const t = w.text(title);
  const v = w.text(wrap(vo || "", 34).join("\n"));
  const len = Math.min(duration, 59);
  const graph =
    `[0:v]split=2[a][b];` +
    `[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=28:2,eq=brightness=-0.22:saturation=0.85[bg];` +
    `[b]scale=1080:-2:flags=lanczos[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2-60,` +
    `drawtext=fontfile=bold.ttf:textfile=${t}:fontsize=86:fontcolor=white:x=(w-text_w)/2:y=330:shadowcolor=black@0.55:shadowy=4,` +
    `drawtext=fontfile=reg.ttf:textfile=${v}:fontsize=46:line_spacing=14:text_align=C:fontcolor=white@0.93:x=(w-text_w)/2:y=1290:shadowcolor=black@0.5:shadowy=3,` +
    `drawtext=fontfile=bold.ttf:text=Toolbox:fontsize=40:fontcolor=0xFF7A45:x=(w-text_w)/2:y=1760,` +
    `fade=t=in:st=0:d=0.4,fade=t=out:st=${(len - 0.5).toFixed(2)}:d=0.5,format=yuv420p[v]`;
  w.run(["-i", src, "-t", len.toFixed(2), "-map", "[v]", "-an", ...ENC, out], graph);
}

function teaser(w, src, out, title, duration) {
  const { start, length } = teaserWindow(duration);
  const t = w.text(title);
  const graph =
    `[0:v]drawtext=fontfile=bold.ttf:textfile=${t}:fontsize=52:fontcolor=white:x=64:y=h-170:box=1:boxcolor=black@0.6:boxborderw=26:` +
    `enable='between(t,0.3,4.2)':alpha='min(1,(t-0.3)/0.3)*min(1,(4.2-t)/0.3)',` +
    `fade=t=in:st=0:d=0.3,fade=t=out:st=${(length - 0.4).toFixed(2)}:d=0.4,format=yuv420p[v]`;
  w.run(["-ss", String(start), "-t", String(length), "-i", src, "-map", "[v]", "-an", ...ENC, out], graph);
}

function gif(w, src, out) {
  const graph = `[0:v]fps=12,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=192:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4[v]`;
  w.run(["-i", src, "-map", "[v]", "-loop", "0", out], graph);
}

/** A title card: dark background, a big line and a small line. */
function card(w, out, big, small, seconds) {
  const b = w.text(big);
  const s = w.text(small);
  const graph =
    `color=c=0x0B0C0E:s=1920x1080:r=30:d=${seconds}[c];` +
    `[c]drawtext=fontfile=bold.ttf:textfile=${b}:fontsize=120:fontcolor=white:x=(w-text_w)/2:y=(h/2)-130,` +
    `drawtext=fontfile=reg.ttf:textfile=${s}:fontsize=48:fontcolor=white@0.8:x=(w-text_w)/2:y=(h/2)+40,` +
    `fade=t=in:st=0:d=0.5,fade=t=out:st=${seconds - 0.5}:d=0.5,format=yuv420p[v]`;
  w.run(["-map", "[v]", ...ENC, out], graph);
}

/** One reel segment: `length` s from `start`, normalised to 1080p30, with a small label; audio kept or silent. */
function segment(w, src, out, label, start, length, { audio = false, still = false } = {}) {
  const t = w.text(label);
  const zoom = still ? `scale=2112:1188,zoompan=z='1+0.0008*on':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s=1920x1080:fps=30,` : "";
  const graph =
    `[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0B0C0E,setsar=1,fps=30,${zoom}` +
    `drawtext=fontfile=bold.ttf:textfile=${t}:fontsize=40:fontcolor=white:x=56:y=h-120:box=1:boxcolor=black@0.55:boxborderw=18,` +
    `fade=t=in:st=0:d=0.25,fade=t=out:st=${(length - 0.25).toFixed(2)}:d=0.25,format=yuv420p[v]` +
    (audio ? `;[0:a]aresample=48000,afade=t=in:st=0:d=0.1,afade=t=out:st=${(length - 0.15).toFixed(2)}:d=0.15[a]` : "");
  const input = still ? ["-loop", "1", "-framerate", "30", "-t", String(length), "-i", src] : ["-ss", String(start), "-t", String(length), "-i", src];
  const audioOut = audio ? ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"] : ["-an"];
  w.run([...input, "-map", "[v]", ...audioOut, ...ENC, out], graph);
}

/** Concatenates same-format segments (stream copy). */
function concat(w, parts, out) {
  const list = w.text(parts.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
  w.run(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out]);
}

/** Lays a music bed under a silent video, fading in and out. */
function withMusic(w, video, music, out, duration) {
  const graph = `[1:a]atrim=0:${duration.toFixed(2)},asetpts=PTS-STARTPTS,volume=-4dB,afade=t=in:st=0:d=1,afade=t=out:st=${(duration - 2.5).toFixed(2)}:d=2.5[a]`;
  w.run(["-i", video, "-i", music, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out], graph);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const paths = defaultPaths();
  const footage = o.footage ?? path.join(paths.demoRoot, "Library", "Demo Footage");
  const shot = JSON.parse(fs.readFileSync(path.join(footage, "shotlist.json"), "utf8"));
  const ffmpeg = findFfmpeg(paths.toolsDir);
  if (!ffmpeg) throw new Error("FFmpeg not found");
  const want = (k) => !o.only || o.only.has(k);
  const cuts = path.join(footage, "Cuts");
  const w = new Work(ffmpeg, fontFiles());
  const made = [];
  const keep = (f) => !o.force && fs.existsSync(f);
  try {
    const aroll = shot
      .filter((e) => e.kind === "a-roll" && fs.existsSync(path.join(footage, e.file)))
      .sort((a, b) => a.n - b.n);
    for (const e of aroll) {
      const src = path.join(footage, e.file);
      const name = path.basename(e.file, ".mp4");
      const title = titleOf(e);
      const dur = e.duration || probeDuration(ffmpeg, src);
      const jobs = [
        ["shorts", path.join(cuts, "Shorts 9x16", `${name}.mp4`), (out) => short(w, src, out, title, e.vo || e.shown, dur)],
        ["teasers", path.join(cuts, "Teasers 16x9", `${name}.mp4`), (out) => teaser(w, src, out, title, dur)],
      ];
      for (const [k, out, fn] of jobs) {
        if (!want(k) || keep(out)) continue;
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fn(out);
        made.push(out);
        console.log(`${k}: ${path.relative(footage, out)}`);
      }
      const t = path.join(cuts, "Teasers 16x9", `${name}.mp4`);
      const g = path.join(cuts, "GIFs", `${name}.gif`);
      if (want("gifs") && fs.existsSync(t) && !keep(g)) {
        fs.mkdirSync(path.dirname(g), { recursive: true });
        gif(w, t, g);
        made.push(g);
        console.log(`gif: ${path.relative(footage, g)}`);
      }
    }

    if (want("sizzle")) {
      const music = o.music ?? path.join(path.dirname(footage), "yeule - dazies.mp3");
      for (const [label, picks] of [
        ["Sizzle reel", aroll],
        ["Sizzle reel 60s", HEADLINE.map((id) => aroll.find((e) => e.scene === id)).filter(Boolean)],
      ]) {
        const silent = path.join(cuts, `${label} (no music).mp4`);
        const scored = path.join(cuts, `${label}.mp4`);
        if (keep(silent) && (keep(scored) || !fs.existsSync(music))) continue;
        const parts = [];
        const open = path.join(w.dir, `${label}-open.mp4`);
        card(w, open, "Toolbox", "Every tool on your own machine. Nothing leaves it.", 3);
        parts.push(open);
        picks.forEach((e, i) => {
          const src = path.join(footage, e.file);
          const dur = e.duration || probeDuration(ffmpeg, src);
          const len = label.endsWith("60s") ? 3.5 : 3;
          const start = Math.max(0, dur - 1 - len);
          const p = path.join(w.dir, `${label}-${i}.mp4`);
          segment(w, src, p, titleOf(e), start, len);
          parts.push(p);
        });
        const close = path.join(w.dir, `${label}-close.mp4`);
        card(w, close, "Toolbox", `${aroll.length} tools · local · yours`, 3);
        parts.push(close);
        fs.mkdirSync(cuts, { recursive: true });
        concat(w, parts, silent);
        made.push(silent);
        console.log(`sizzle: ${path.relative(footage, silent)}`);
        if (fs.existsSync(music)) {
          withMusic(w, silent, music, scored, probeDuration(ffmpeg, silent));
          made.push(scored);
          console.log(`sizzle: ${path.relative(footage, scored)}`);
        }
      }
    }

    if (want("reels")) {
      const reel = (dirName, outName, len, opts) => {
        const dir = path.join(footage, "Showcase", dirName);
        const out = path.join(cuts, outName);
        if (!fs.existsSync(dir) || keep(out)) return;
        const files = fs.readdirSync(dir).filter((f) => /\.(mp4|mov|webm|png|jpe?g|webp)$/i.test(f)).sort();
        if (!files.length) return;
        const parts = files.map((f, i) => {
          const src = path.join(dir, f);
          const still = /\.(png|jpe?g|webp)$/i.test(f);
          const dur = still ? len : probeDuration(ffmpeg, src);
          const start = still ? 0 : Math.max(0, Math.min(dur - len, dur * 0.35));
          const p = path.join(w.dir, `${outName}-${i}.mp4`);
          const audio = opts.audio && !still && hasAudio(ffmpeg, src);
          segment(w, src, p, path.basename(f, path.extname(f)), start, Math.min(len, still ? len : dur), { audio, still });
          return { p, audio };
        });
        fs.mkdirSync(cuts, { recursive: true });
        if (opts.audio && parts.every((x) => x.audio)) concat(w, parts.map((x) => x.p), out);
        else {
          // Mixed audio/no audio: drop the audio so every part concatenates.
          const silent = parts.map((x, i) => {
            if (!x.audio) return x.p;
            const s = path.join(w.dir, `${outName}-s${i}.mp4`);
            w.run(["-i", x.p, "-an", "-c:v", "copy", s]);
            return s;
          });
          concat(w, silent, out);
        }
        made.push(out);
        console.log(`reel: ${path.relative(footage, out)}`);
      };
      reel("Visualizer", "Visualizer reel.mp4", 4, { audio: true });
      reel("Color Grader", "Color Grader reel.mp4", 2.5, { audio: false });
    }
  } finally {
    w.close();
  }
  console.log(`${made.length} file(s) written under ${cuts}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(HERE, "cuts.mjs")) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
