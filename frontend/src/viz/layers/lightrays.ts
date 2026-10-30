/**
 * Light rays (SPEC.md §6.7 #27): god rays fanning out of a point. Three
 * interleaved ray patterns drift through a noisy angular field, shafts widen
 * and fade with distance, shimmer travels along them, and the whole fan
 * swells with held vocal notes and pulses on the beat.
 */
import { FULLSCREEN_VS, Program } from "../gl/core";
import { GLSL_COMMON } from "../gl/glsl";
import { registerLayer } from "./registry";

const FS = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
${GLSL_COMMON}
uniform vec2 u_res, u_origin;
uniform float u_rays, u_len, u_spread, u_dir, u_t, u_energy, u_bright, u_opacity, u_sway, u_cum;
uniform vec3 u_c0, u_c1;
void main() {
  vec2 px = uv * u_res;
  float sh = min(u_res.x, u_res.y);
  vec2 d = px - u_origin;
  float dist = length(d) / sh;
  float a = atan(d.x, -d.y);
  float rel = a - u_dir;
  rel = mod(rel + 3.14159265, 6.2831853) - 3.14159265;
  float half_ = u_spread * 0.5;
  float mask = smoothstep(half_, half_ * 0.35, abs(rel));
  float t = u_t;
  float rays = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float freq = u_rays * (1.0 + 0.61 * fi);
    float warp = 1.4 * vnoise(vec2(rel * 2.5 + fi * 7.0, t * 0.17 + fi));
    float s = 0.5 + 0.5 * sin(rel * freq + t * (0.12 + 0.07 * fi) * (mod(fi, 2.0) < 0.5 ? 1.0 : -1.0) + fi * 2.1 + warp * u_sway * 2.0);
    rays += pow(s, 3.0 + 2.0 * fi) * (0.62 / (1.0 + 0.7 * fi));
  }
  float shimmer = 0.7 + 0.3 * vnoise(vec2(rel * u_rays * 0.6, dist * 5.0 - u_cum * 1.4));
  float fall = exp(-dist / max(u_len, 0.05)) * smoothstep(0.0, 0.06, dist);
  float source = exp(-dist * 8.0) * 0.9 + exp(-dist * 2.2) * 0.12;
  float k = rays * shimmer * fall * mask * (0.5 + u_energy);
  vec3 tint = mix(u_c1, u_c0, smoothstep(0.0, 0.9, dist));
  vec3 col = (mix(tint, vec3(1.0), 0.3) * k + mix(u_c1, vec3(1.0), 0.6) * source * (0.5 + u_energy)) * u_bright * u_opacity;
  o = vec4(col, min(1.0, max(col.r, max(col.g, col.b))));
}`;

registerLayer({
  type: "lightrays",
  label: "Light rays",
  group: "accent",
  icon: "sun",
  params: {
    rays: { kind: "number", label: "Rays", min: 3, max: 40, default: 14, step: 1 },
    length: { kind: "number", label: "Length", min: 0.2, max: 2, default: 0.95 },
    spread: { kind: "number", label: "Spread (degrees)", min: 20, max: 360, default: 110 },
    rotation: { kind: "number", label: "Direction (degrees)", min: -180, max: 180, default: 0 },
    x: { kind: "number", label: "Origin x", min: 0, max: 1, default: 0.5 },
    y: { kind: "number", label: "Origin y", min: -0.2, max: 1.3, default: 1.1 },
    sway: { kind: "number", label: "Sway", min: 0, max: 1, default: 0.5 },
    brightness: { kind: "number", label: "Brightness", min: 0, max: 4, default: 1.2 },
    held: { kind: "number", label: "Swell with held notes", min: 0, max: 1, default: 0.7 },
    pulse: { kind: "number", label: "Pulse on the beat", min: 0, max: 1, default: 0.5 },
  },
  create(ctx) {
    const prog = new Program(ctx.gl, FULLSCREEN_VS, FS);
    return {
      render(f) {
        const held = f.signals.value("vocals.held", f.tMs, 60, 500);
        const beat = f.signals.value("beat.pulse", f.tMs);
        const energy = Math.min(1, 0.15 + (f.params.held as number) * held * 0.9 + (f.params.pulse as number) * beat * 0.45 + 0.25 * f.signals.value("mix.level", f.tMs));
        prog
          .use()
          .f2("u_res", f.w, f.h)
          .f2("u_origin", f.w * (f.params.x as number), f.h * (f.params.y as number))
          .f1("u_rays", f.params.rays as number)
          .f1("u_len", f.params.length as number)
          .f1("u_spread", ((f.params.spread as number) * Math.PI) / 180)
          .f1("u_dir", ((f.params.rotation as number) * Math.PI) / 180 + (f.params.sway as number) * 0.18 * Math.sin(f.motionSec * 0.35))
          .f1("u_t", f.motionSec)
          .f1("u_cum", f.analysis.cum("mix.level", f.tMs))
          .f1("u_energy", energy)
          .f1("u_sway", f.params.sway as number)
          .f1("u_bright", f.params.brightness as number)
          .f1("u_opacity", f.opacity)
          .f3("u_c0", f.palette.colors[0])
          .f3("u_c1", f.palette.accent);
        ctx.fullscreen.draw();
      },
      dispose() {
        prog.dispose();
      },
    };
  },
});
