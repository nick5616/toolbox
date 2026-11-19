// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket and fetch.
// Talks to the app's WebView2 on 127.0.0.1 (sandboxed runs only; see TOOLBOX_DEVTOOLS_PORT).

export const VIEWPORT = Object.freeze({ width: 1920, height: 1080 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

/** The page targets the browser lists (no DevTools pages). */
export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  const list = await res.json();
  return list.filter((t) => t.type === "page" && !String(t.url).startsWith("devtools"));
}

/** Picks the main window: not a popup / pop-out (`window=` in the URL) unless `match` says otherwise. */
export function pickMainTarget(targets, match) {
  return targets.find((t) => (match ? String(t.url).includes(match) : !String(t.url).includes("window="))) ?? null;
}

export async function waitForTarget(port, { match, timeoutMs = 60000 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const t = pickMainTarget(await listTargets(port), match);
      if (t) return t;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error(`no DevTools page target on port ${port}`);
    await sleep(400);
  }
}

/** Modifier bits of Input.dispatch*Event. */
export const MOD = Object.freeze({ Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 });

async function openSocket(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("DevTools socket failed"));
  });
  return ws;
}

/** Whether a target is the main window: the URL can still be blank while a popup loads, so ask the page itself. */
async function isMainWindow(target) {
  const ws = await openSocket(target);
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 4000);
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.id === 1) {
          clearTimeout(timer);
          resolve(m.result?.result?.value === "main");
        }
      };
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `location.protocol.startsWith("http") && !new URLSearchParams(location.search).has("window") ? "main" : "other"`, returnByValue: true } }));
    });
  } catch {
    return false;
  } finally {
    ws.close();
  }
}

export async function connect(port, opts = {}) {
  const end = Date.now() + (opts.timeoutMs ?? 60000);
  let target = null;
  while (!target) {
    const first = await waitForTarget(port, { ...opts, timeoutMs: Math.max(1000, end - Date.now()) }).catch(() => null);
    const all = await listTargets(port).catch(() => []);
    for (const t of first ? [first, ...all.filter((x) => x.id !== first.id)] : all) {
      if (opts.match ? String(t.url).includes(opts.match) : await isMainWindow(t)) {
        target = t;
        break;
      }
    }
    if (!target) {
      if (Date.now() > end) throw new Error(`no main-window page target on port ${port}`);
      await sleep(400);
    }
  }
  const ws = await openSocket(target);
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  const logs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(`${m.error.message ?? "CDP error"} ${m.error.data ?? ""}`.trim()));
      else res(m.result);
      return;
    }
    if (m.method === "Runtime.consoleAPICalled") {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    } else if (m.method === "Runtime.exceptionThrown") {
      logs.push(`[exception] ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
    }
    for (const fn of listeners.get(m.method) ?? []) fn(m.params);
  };
  let closed = false;
  ws.onclose = () => {
    closed = true;
    for (const { rej } of pending.values()) rej(new Error("DevTools socket closed"));
    pending.clear();
  };

  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      if (closed) return rej(new Error("DevTools socket closed"));
      const id = ++nextId;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const on = (method, fn) => {
    const set = listeners.get(method) ?? new Set();
    set.add(fn);
    listeners.set(method, set);
    return () => set.delete(fn);
  };

  const c = {
    target,
    send,
    on,
    logs,
    sleep,
    /** Evaluates an expression in the page and returns its JSON value. */
    async eval(expression, { awaitPromise = true } = {}) {
      const r = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
      if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
      return r.result.value;
    },
    /** A JS expression that yields `v` in the page (safe for paths with backslashes and quotes). */
    lit: (v) => `JSON.parse(${JSON.stringify(JSON.stringify(v))})`,
    async setViewport({ width, height } = VIEWPORT) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    },
    async clearViewport() {
      await send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    },
    /** Runs `source` on every future document; returns an id for removal. */
    async addInitScript(source) {
      const r = await send("Page.addScriptToEvaluateOnNewDocument", { source });
      return r.identifier;
    },
    mouse(type, x, y, extra = {}) {
      return send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !extra.buttons ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1, ...extra });
    },
    keyEvent(params) {
      return send("Input.dispatchKeyEvent", params);
    },
    insertText(text) {
      return send("Input.insertText", { text });
    },
    async screenshot({ format = "png", clip } = {}) {
      const r = await send("Page.captureScreenshot", { format, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      return Buffer.from(r.data, "base64");
    },
    async close() {
      try {
        await c.clearViewport();
      } catch {
        /* closing anyway */
      }
      ws.close();
    },
  };
  await send("Runtime.enable");
  await send("Page.enable");
  return c;
}
