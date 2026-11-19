// Runs the gradelook shader in a real WebGL2 context (headless Edge, SwiftShader) and prints the difference to the CPU reference per case.
// Used by src/grade/glcheck.test.ts (TOOLBOX_GL_CHECK=1): node scripts/grade-glcheck.mjs <dir with shaders.json>. Stops only the Edge it started.
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";

const dir = process.argv[2];
const S = JSON.parse(fs.readFileSync(`${dir}/shaders.json`, "utf8"));
const port = 9345;
const edge = process.env.TOOLBOX_EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const child = spawn(edge, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}/edge-profile`, "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--no-first-run", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let targets;
  for (let i = 0; i < 40; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (targets.length) break;
    } catch {}
    await sleep(500);
  }
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) pending.get(d.id)(d);
  };
  const send = (method, params) => new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const js = `(() => {
    const S = ${JSON.stringify(S)};
    const W = S.W;
    const c = document.createElement("canvas"); c.width = W; c.height = W;
    const gl = c.getContext("webgl2");
    if (!gl) return JSON.stringify({ error: "no webgl2" });
    if (!gl.getExtension("EXT_color_buffer_float")) return JSON.stringify({ error: "no float rt" });
    const mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); return sh; };
    const prog = gl.createProgram();
    gl.attachShader(prog, mk(gl.VERTEX_SHADER, S.vs)); gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, S.main));
    gl.bindAttribLocation(prog, 0, "a_pos"); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const tex = (w, h, ifmt, fmt, type, data, filt) => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, data); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; };
    const srcT = tex(W, W, gl.RGBA32F, gl.RGBA, gl.FLOAT, new Float32Array(S.src), gl.NEAREST);
    const dd = new Uint8Array(W * W * 4), ss = new Uint8Array(W * W * 4);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; dd[i] = S.depth[x]; dd[i+3] = 255; ss[i] = S.subj[y]; ss[i+3] = 255; }
    const depthT = tex(W, W, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, dd, gl.NEAREST);
    const subjT = tex(W, W, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, ss, gl.NEAREST);
    const outT = tex(W, W, gl.RGBA32F, gl.RGBA, gl.FLOAT, null, gl.NEAREST);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outT, 0);
    gl.viewport(0, 0, W, W);
    const U = (n) => gl.getUniformLocation(prog, n);
    const toSrgb = (x) => x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1/2.4) - 0.055;
    const res = {};
    for (const cs of S.cases) {
      gl.useProgram(prog);
      const tabT = tex(16, 16, gl.RGBA32F, gl.RGBA, gl.FLOAT, new Float32Array(cs.tab), gl.NEAREST);
      const bind = (u, unit, t) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(U(u), unit); };
      bind("u_src", 0, srcT); bind("u_tab", 1, tabT); bind("u_depth", 2, depthT); bind("u_subject", 3, subjT); bind("u_people", 4, subjT);
      gl.uniform2f(U("u_res"), W, W); gl.uniform1i(U("u_n"), cs.count); gl.uniform1f(U("u_time"), 0);
      gl.uniform1fv(U("u_drive"), new Float32Array(16).fill(1));
      gl.uniform1f(U("u_hasDepth"), 1); gl.uniform1f(U("u_hasSubject"), 1); gl.uniform1f(U("u_hasPeople"), 1); gl.uniform4f(U("u_auxUV"), 1, 1, 0, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(0, 0, W, W);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const px = new Float32Array(W * W * 4); gl.readPixels(0, 0, W, W, gl.RGBA, gl.FLOAT, px);
      let max = 0, sum = 0, worst = -1, chg = 0;
      for (let i = 0; i < W * W; i++) for (let k = 0; k < 3; k++) {
        const g = Math.max(0, Math.min(1, toSrgb(Math.max(0, px[i*4+k]))));
        const d = Math.abs(g - cs.expected[i*3+k]);
        chg += Math.abs(g - Math.max(0, Math.min(1, toSrgb(S.src[i*4+k])))); sum += d; if (d > max) { max = d; worst = i; }
      }
      res[cs.name] = { maxDiff255: +(max * 255).toFixed(2), meanDiff255: +(sum / (W*W*3) * 255).toFixed(3), worstPixel: worst, ops: cs.count, changed255: +(chg / (W*W*3) * 255).toFixed(1) };
    }
    return JSON.stringify(res, null, 1);
  })()`;
  const r = await send("Runtime.evaluate", { expression: js, returnByValue: true });
  console.log(r.result?.result?.value ?? JSON.stringify(r.result ?? r));
} finally {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch {}
}
