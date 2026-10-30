/**
 * Sweep (SPEC.md §6.7 #26): golden-hour's flush, a band of light that crosses
 * the picture left to right on section starts (or any trigger). The band has
 * a hot core, a long trailing glow, fine streak texture and a slight colour
 * fringe. A closed form of the age of up to three events.
 */
import { FULLSCREEN_VS, Program } from "../gl/core";
import { GLSL_COMMON } from "../gl/glsl";
import { COLOR_OPTIONS, pickColor, rnd } from "./_particles";
import { TRIGGER_OPTIONS, eventsIn, triggerList } from "./_triggers";
import { registerLayer } from "./registry";

const FS = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
${GLSL_COMMON}
uniform vec2 u_res;
uniform vec4 u_e[3]; // age s, strength, seed, unused
uniform vec2 u_n; // sweep normal
uniform float u_width, u_life, u_bright, u_opacity, u_streak, u_fringe;
uniform vec3 u_col;
float prof(float x, float bw) {
  float core = exp(-x * x * 2.4 / (bw * bw));
  float halo = exp(-abs(x) / (bw * (x < 0.0 ? 3.2 : 1.6)));
  return core + 0.15 * halo;
}
void main() {
  vec2 px = uv * u_res;
  vec2 c = px - 0.5 * u_res;
  float ext = 0.5 * (abs(u_n.x) * u_res.x + abs(u_n.y) * u_res.y);
  float s = dot(c, u_n) / ext;
  float tt = dot(c, vec2(-u_n.y, u_n.x));
  float sh = min(u_res.x, u_res.y);
  vec3 col = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    vec4 e = u_e[i];
    if (e.y <= 0.0) continue;
    float q = e.x / u_life;
    if (q < 0.0 || q > 1.0) continue;
    float eq = q < 0.5 ? 2.0 * q * q : 1.0 - 2.0 * (1.0 - q) * (1.0 - q);
    float pos = mix(-1.0 - u_width * 2.5, 1.0 + u_width * 2.0, mix(q, eq, 0.45));
    float x = s - pos;
    float fr = u_fringe * u_width;
    vec3 pr = vec3(prof(x + fr, u_width), prof(x, u_width), prof(x - fr, u_width));
    float tex = (0.72 + 0.28 * vnoise(vec2(tt / (sh * 0.03), e.z * 31.0))) * (0.86 + 0.14 * vnoise(vec2(tt / (sh * 0.005), e.z * 17.0 + x * 4.0)));
    tex = mix(1.0, tex, u_streak);
    float cover = 0.75 + 0.25 * (1.0 - abs(uv.y - 0.5) * 1.1);
    col += mix(u_col, vec3(1.0), 0.28) * pr * tex * cover * e.y;
  }
  col *= u_bright * u_opacity;
  o = vec4(col, min(1.0, max(col.r, max(col.g, col.b))));
}`;

registerLayer({
  type: "sweep",
  label: "Light sweep",
  group: "accent",
  icon: "scan-line",
  params: {
    trigger: { kind: "enum", label: "Trigger", options: TRIGGER_OPTIONS, default: "section" },
    every: { kind: "number", label: "Every nth event", min: 1, max: 8, default: 1, step: 1 },
    width: { kind: "number", label: "Width", min: 0.03, max: 0.6, default: 0.16 },
    angle: { kind: "number", label: "Slant (degrees)", min: -45, max: 45, default: 14 },
    life: { kind: "number", label: "Duration (s)", min: 0.6, max: 4, default: 1.8 },
    streak: { kind: "number", label: "Streak texture", min: 0, max: 1, default: 0.6 },
    fringe: { kind: "number", label: "Colour fringe", min: 0, max: 1, default: 0.25 },
    brightness: { kind: "number", label: "Brightness", min: 0, max: 4, default: 1.8 },
    color: { kind: "enum", label: "Colour", options: COLOR_OPTIONS, default: "accent" },
  },
  create(ctx) {
    const prog = new Program(ctx.gl, FULLSCREEN_VS, FS);
    return {
      render(f) {
        const life = f.params.life as number;
        const list = triggerList(f.analysis, f.params.trigger as string, Math.round(f.params.every as number));
        const evs = eventsIn(list, f.tMs - life * 1000, f.tMs);
        const ang = ((f.params.angle as number) * Math.PI) / 180;
        prog.use().f2("u_res", f.w, f.h);
        for (let k = 0; k < 3; k++) {
          const e = evs[evs.length - 1 - k];
          if (e) prog.f4(`u_e[${k}]`, (f.tMs - e[0]) / 1000, 0.55 + 0.45 * (e[1] / 255), rnd(f.seed, Math.round(e[0]), 1), 0);
          else prog.f4(`u_e[${k}]`, 0, 0, 0, 0);
        }
        prog
          .f2("u_n", Math.cos(ang), Math.sin(ang))
          .f1("u_width", f.params.width as number)
          .f1("u_life", life)
          .f1("u_bright", f.params.brightness as number)
          .f1("u_opacity", f.opacity)
          .f1("u_streak", f.params.streak as number)
          .f1("u_fringe", f.params.fringe as number)
          .f3("u_col", pickColor(f.palette, f.params.color as string, 0));
        ctx.fullscreen.draw();
      },
      dispose() {
        prog.dispose();
      },
    };
  },
});
