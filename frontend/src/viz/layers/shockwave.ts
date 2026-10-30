/**
 * Shockwave (SPEC.md §6.7 #25): on drops and downbeats a luminous pressure
 * ring races outward with a colour-fringed front, a trailing wake and a flash.
 * It is purely additive light (no previous-frame read), a closed form of the
 * age of the (up to four) most recent events.
 */
import { FULLSCREEN_VS, Program } from "../gl/core";
import { GLSL_COMMON } from "../gl/glsl";
import { TRIGGER_OPTIONS, eventsIn, triggerList } from "./_triggers";
import { registerLayer } from "./registry";

const FS = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
${GLSL_COMMON}
uniform vec2 u_res;
uniform vec4 u_w[4]; // origin px, age s, strength
uniform float u_reach, u_width, u_strength, u_flash, u_bright, u_life, u_opacity, u_short, u_diag;
uniform vec3 u_ring, u_wake;
float front(float d, float R, float w) {
  float x = (d - R) / w;
  float lead = exp(-x * x * 3.5);
  return x > 0.0 ? lead : max(lead, 0.6 * exp(0.6 * x) * smoothstep(0.0, 0.35, d / max(R, 1.0)));
}
void main() {
  vec2 px = uv * u_res;
  vec3 col = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    vec4 w = u_w[i];
    float s = w.w;
    if (s <= 0.0) continue;
    float q = w.z / u_life;
    if (q < 0.0 || q >= 1.0) continue;
    float d = length(px - w.xy);
    float ease = 1.0 - pow(1.0 - q, 3.0);
    float R = u_reach * (0.45 + 0.55 * s) * ease;
    float wpx = u_width * (0.55 + 1.6 * q);
    float disp = 0.022 * (0.5 + q);
    vec3 pr = vec3(front(d, R * (1.0 + disp), wpx), front(d, R, wpx), front(d, R * (1.0 - disp), wpx));
    float fade = pow(1.0 - q, 1.3) * smoothstep(0.0, 0.02, q);
    col += mix(u_ring, vec3(1.0), 0.45) * pr * fade * s * u_strength;
    float inner = exp(-max(R - d, 0.0) / (wpx * 3.5)) * step(d, R) * (1.0 - q);
    col += u_wake * inner * 0.05 * s * u_strength;
    float fl = exp(-w.z / 0.15) * s * s * u_flash;
    float rad = 1.0 - clamp(d / (u_diag * 0.65), 0.0, 1.0);
    col += mix(u_ring, vec3(1.0), 0.55) * fl * (0.25 + 0.75 * rad * rad);
  }
  col *= u_bright * u_opacity;
  o = vec4(col, min(1.0, max(col.r, max(col.g, col.b))));
}`;

registerLayer({
  type: "shockwave",
  label: "Shockwave",
  group: "accent",
  icon: "radio",
  params: {
    trigger: { kind: "enum", label: "Trigger", options: ["drop+downbeat", ...TRIGGER_OPTIONS], default: "drop+downbeat" },
    every: { kind: "number", label: "Every nth event", min: 1, max: 8, default: 1, step: 1 },
    strength: { kind: "number", label: "Strength", min: 0, max: 2, default: 1 },
    flash: { kind: "number", label: "Flash", min: 0, max: 2, default: 0.5 },
    reach: { kind: "number", label: "Reach", min: 0.2, max: 2, default: 1 },
    width: { kind: "number", label: "Thickness", min: 0.005, max: 0.15, default: 0.03 },
    life: { kind: "number", label: "Lifetime (s)", min: 0.4, max: 3, default: 1.5 },
    x: { kind: "number", label: "Centre x", min: 0, max: 1, default: 0.5 },
    y: { kind: "number", label: "Centre y", min: 0, max: 1, default: 0.5 },
    brightness: { kind: "number", label: "Brightness", min: 0, max: 4, default: 2.6 },
  },
  create(ctx) {
    const prog = new Program(ctx.gl, FULLSCREEN_VS, FS);
    const arr = new Float32Array(16);
    return {
      render(f) {
        const life = f.params.life as number;
        const short = Math.min(f.w, f.h);
        const list = triggerList(f.analysis, f.params.trigger as string, Math.round(f.params.every as number));
        const evs = eventsIn(list, f.tMs - life * 1000, f.tMs);
        arr.fill(0);
        const ox = f.w * (f.params.x as number);
        const oy = f.h * (f.params.y as number);
        for (let k = 0; k < 4; k++) {
          const e = evs[evs.length - 1 - k];
          if (!e) break;
          arr[k * 4] = ox;
          arr[k * 4 + 1] = oy;
          arr[k * 4 + 2] = (f.tMs - e[0]) / 1000;
          arr[k * 4 + 3] = e[1] / 255;
        }
        prog.use().f2("u_res", f.w, f.h);
        for (let k = 0; k < 4; k++) prog.f4(`u_w[${k}]`, arr[k * 4] ?? 0, arr[k * 4 + 1] ?? 0, arr[k * 4 + 2] ?? 0, arr[k * 4 + 3] ?? 0);
        prog
          .f1("u_reach", (f.params.reach as number) * Math.hypot(f.w, f.h) * 0.5)
          .f1("u_width", (f.params.width as number) * short)
          .f1("u_strength", f.params.strength as number)
          .f1("u_flash", f.params.flash as number)
          .f1("u_bright", f.params.brightness as number)
          .f1("u_life", life)
          .f1("u_opacity", f.opacity)
          .f1("u_short", short)
          .f1("u_diag", Math.hypot(f.w, f.h))
          .f3("u_ring", f.palette.accent)
          .f3("u_wake", f.palette.glow);
        ctx.fullscreen.draw();
      },
      dispose() {
        prog.dispose();
      },
    };
  },
});
