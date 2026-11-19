// Launching and stopping the app for capture.
//
// Safety rules (CLAUDE.md): the capture app is sandboxed (a workspace or support
// dir is set), Focus is a dry run, no global hotkeys, and it is stopped by
// walking the process tree from the PID this module started. Never by name or
// command-line pattern, and never anything that isn't a descendant (so a
// browser such as msedge.exe is never touched).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The main checkout when `repo` is a git worktree (gitignored media and the shared tools folder live there). */
export function mainCheckout(repo = REPO) {
  const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repo, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return repo;
  const common = r.stdout.trim();
  return path.basename(common) === ".git" ? path.dirname(common) : repo;
}

/** First existing candidate. */
function firstDir(cands) {
  return cands.find((c) => fs.existsSync(c)) ?? cands[0];
}

export function defaultPaths(repo = REPO) {
  const main = mainCheckout(repo);
  const dev = (...p) => path.join(repo, ".dev", ...p);
  return {
    repo,
    main,
    assetsDir: firstDir([path.join(repo, "demoAssets"), path.join(main, "demoAssets")]),
    toolsDir: firstDir([dev("support"), path.join(main, ".dev", "support")]),
    generatedDir: dev("demo-generated"),
    workspaceRoot: dev("workspaces", "demo-capture"),
    legacySupport: dev("demo-capture-support"),
    legacyLibrary: dev("demo-capture-library"),
    framesDir: dev("demo-frames"),
    outDir: dev("demo-out"),
    bin: path.join(repo, "bin", process.platform === "win32" ? "toolbox.exe" : "toolbox"),
  };
}

/**
 * Whether this checkout's workspace.Resolve reads TOOLBOX_WORKSPACE. Wave 0 shipped a stub that ignores it
 * (the app then opens the user's real Personal workspace!), so look for an actual read of the variable.
 */
export function supportsWorkspaceEnv(repo = REPO) {
  const dir = path.join(repo, "core", "workspace");
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"))
      .some((f) => /(Getenv|LookupEnv)\(\s*(EnvWorkspace\b|"TOOLBOX_WORKSPACE")/.test(fs.readFileSync(path.join(dir, f), "utf8")));
  } catch {
    return false;
  }
}

/** The `support=` path of the app's "starting Toolbox" log line, or null. */
export function supportFromLog(text) {
  const m = text.match(/msg="?starting Toolbox"?[^\n]*?\bsupport=("([^"]+)"|(\S.*?))\s*$/m);
  if (!m) return null;
  return (m[2] ?? m[3]).replace(/\\\\/g, "\\");
}

/** True when `support` is inside one of the allowed capture dirs. */
export function isCaptureSupport(support, allowed) {
  const s = path.resolve(support).toLowerCase();
  return allowed.some((a) => {
    const r = path.resolve(a).toLowerCase();
    return s === r || s.startsWith(r + path.sep);
  });
}

/** The environment of a capture run. `mode` is "workspace" (TOOLBOX_WORKSPACE) or "legacy" (a sandbox support + library dir). */
export function captureEnv({ mode, paths, port, base = process.env }) {
  const env = { ...base };
  // Nothing from the caller's shell may leak a real workspace or a live Focus session into the capture.
  for (const k of ["TOOLBOX_SUPPORT_DIR", "TOOLBOX_LIBRARY_DIR", "TOOLBOX_WORKSPACE", "TOOLBOX_WORKSPACE_KIND", "TOOLBOX_WORKSPACE_NAME", "TOOLBOX_WORKSPACE_BASELINE", "TOOLBOX_VIEW"]) delete env[k];
  if (mode === "workspace") {
    env.TOOLBOX_WORKSPACE = paths.workspaceRoot;
    env.TOOLBOX_WORKSPACE_KIND = "demo";
    env.TOOLBOX_WORKSPACE_NAME = "Demo";
    env.TOOLBOX_WORKSPACE_BASELINE = paths.assetsDir;
  } else {
    env.TOOLBOX_SUPPORT_DIR = paths.legacySupport;
    env.TOOLBOX_LIBRARY_DIR = paths.legacyLibrary;
  }
  env.TOOLBOX_TOOLS_DIR = paths.toolsDir;
  env.TOOLBOX_DEVTOOLS_PORT = String(port);
  env.TOOLBOX_FOCUS_DRYRUN = "1";
  env.TOOLBOX_NO_HOTKEYS = "1";
  return env;
}

/** The workspace's Library folder for a mode. */
export function libraryDirFor(mode, paths) {
  return mode === "workspace" ? path.join(paths.workspaceRoot, "Library") : paths.legacyLibrary;
}

/** Deletes the capture workspace (and only it): the path must be exactly `<repo>/.dev/workspaces/demo-capture` or the legacy capture dirs. */
export function removeCaptureState(paths, which = "all") {
  const allowed = [paths.workspaceRoot, paths.legacySupport, paths.legacyLibrary].map((p) => path.resolve(p));
  const targets = which === "workspace" ? [paths.workspaceRoot] : which === "legacy" ? [paths.legacySupport, paths.legacyLibrary] : allowed;
  for (const t of targets) {
    const r = path.resolve(t);
    const inside = r.startsWith(path.resolve(paths.repo, ".dev") + path.sep);
    if (!allowed.includes(r) || !inside) throw new Error(`refusing to delete ${r}`);
    fs.rmSync(r, { recursive: true, force: true });
  }
}

// --- process tree -----------------------------------------------------------

/** All descendants of `pid` in a process list ([{pid, ppid, name}]), children after parents. */
export function descendants(list, pid) {
  const kids = new Map();
  for (const p of list) {
    const a = kids.get(p.ppid) ?? [];
    a.push(p);
    kids.set(p.ppid, a);
  }
  const out = [];
  const seen = new Set([pid]);
  const queue = [pid];
  while (queue.length) {
    const cur = queue.shift();
    for (const c of kids.get(cur) ?? []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      out.push(c);
      queue.push(c.pid);
    }
  }
  return out;
}

function ps(command) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`powershell failed: ${r.stderr}`);
  return r.stdout;
}

/** [{pid, ppid, name}] from Win32_Process. */
export function processList() {
  if (process.platform !== "win32") {
    const r = spawnSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" });
    return r.stdout
      .split("\n")
      .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
      .filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3] }));
  }
  const out = ps("Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress");
  const rows = JSON.parse(out || "[]");
  return (Array.isArray(rows) ? rows : [rows]).map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name }));
}

/** Stops `pid` and everything beneath it, found by walking the parent chain. */
export function stopTree(pid) {
  const list = processList();
  const ids = [...descendants(list, pid).map((p) => p.pid).reverse(), pid];
  if (process.platform === "win32") {
    ps(`Stop-Process -Id ${ids.join(",")} -Force -ErrorAction SilentlyContinue`);
  } else {
    for (const id of ids) {
      try {
        process.kill(id, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  return ids;
}

/** Toolbox processes that aren't `ownPids` or descendants of them (a real app the user has open). */
export function otherToolboxProcesses(ownPids = []) {
  const list = processList();
  const mine = new Set(ownPids);
  for (const p of ownPids) for (const d of descendants(list, p)) mine.add(d.pid);
  return list.filter((p) => /^toolbox(\.exe)?$/i.test(p.name) && !mine.has(p.pid));
}

// --- launching ----------------------------------------------------------------

export async function waitForDevtools(port, timeoutMs = 90000, alive = () => true) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (!alive()) throw new Error("the app exited before DevTools came up");
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      /* not yet */
    }
    if (Date.now() > end) throw new Error(`DevTools did not come up on ${port}`);
    await sleep(300);
  }
}

/**
 * Starts the app. Returns {pid, port, mode, libraryDir, stop()}.
 * `mode` defaults to "workspace" when main.go supports it, else "legacy".
 */
export async function launchApp({ paths = defaultPaths(), port = 9230, mode, bin, logFile, env: extra = {} } = {}) {
  mode ??= supportsWorkspaceEnv(paths.repo) ? "workspace" : "legacy";
  const exe = bin ?? paths.bin;
  if (!fs.existsSync(exe)) throw new Error(`${exe} not found: build it with \`wails3 build\``);
  if (!fs.existsSync(paths.toolsDir)) throw new Error(`tools folder ${paths.toolsDir} not found (set --tools)`);
  const env = { ...captureEnv({ mode, paths, port }), ...extra };
  const log = logFile ?? path.join(paths.repo, ".dev", "demo-app.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const logStart = fs.existsSync(log) ? fs.statSync(log).size : 0;
  const fd = fs.openSync(log, "a");
  let exited = false;
  const child = spawn(exe, [], { env, stdio: ["ignore", fd, fd], windowsHide: false, cwd: paths.repo });
  child.on("exit", () => (exited = true));
  child.on("error", () => (exited = true));
  const handle = {
    pid: child.pid,
    port,
    mode,
    libraryDir: libraryDirFor(mode, paths),
    exited: () => exited,
    stop() {
      if (exited) return [];
      const ids = stopTree(child.pid);
      exited = true;
      return ids;
    },
  };
  try {
    // Guard: the app must have opened a capture dir, never a real (Personal) workspace.
    const allowed = [paths.workspaceRoot, paths.legacySupport];
    const end = Date.now() + 30000;
    for (;;) {
      const text = fs.readFileSync(log, "utf8").slice(logStart);
      const support = supportFromLog(text);
      if (support) {
        if (!isCaptureSupport(support, allowed)) throw new Error(`the app opened ${support}, not a capture workspace: stopped it (is TOOLBOX_WORKSPACE honoured by this build?)`);
        break;
      }
      if (exited || Date.now() > end) throw new Error("the app did not report its support folder");
      await sleep(150);
    }
    await waitForDevtools(port, 90000, () => !exited);
  } catch (e) {
    handle.stop();
    throw e;
  }
  return handle;
}

/**
 * In workspace mode a new workspace seeds its Library in the background; waits for the manifest.
 * (Legacy mode copies files before launch, so there is nothing to wait for.)
 */
export async function waitForSeed(paths, timeoutMs = 15 * 60000) {
  const manifest = path.join(paths.workspaceRoot, ".toolbox", "baseline-manifest.json");
  const end = Date.now() + timeoutMs;
  while (!fs.existsSync(manifest)) {
    if (Date.now() > end) throw new Error("the Demo workspace never finished copying its starting files");
    await sleep(1000);
  }
}
