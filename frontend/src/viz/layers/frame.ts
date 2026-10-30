/**
 * Frame (SPEC.md §6.7 #28): a glowing rounded border around the picture, for
 * videos. The line breathes with the beat, a bright highlight runs around the
 * perimeter at a pace set by the song's cumulative energy, and an inner haze
 * lights the edges. Optionally only the four corners are drawn.
 */
import { FULLSCREEN_VS, Program } from "../gl/core";
import { GLSL_COMMON } from "../gl/glsl";
import { registerLayer } from "./registry";

const FS = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
${GLSL_COMMON}
uniform vec2 u_res;
uniform float u_th, u_inset, u_radius, u_glow, u_bright, u_corners, u_cornerLen, u_phase, u_haze, u_opacity, u_run;
uniform vec3 u_c0, u_c1, u_c2;
void main() {
  vec2 c = uv * u_res - 0.5 * u_res;
  vec2 hb = 0.5 * u_res - u_inset;
  float r = min(u_radius, min(hb.x, hb.y));
  float d = sdRoundBox(c, hb, r);
  float band = abs(d) - u_th * 0.5;
  float line = aaFill(band);
  float g = exp(-max(band, 0.0) / max(u_glow, 0.5)) * (1.0 - line) * 0.55;
  float inner = d < 0.0 ? exp(d / max(u_glow * 4.0, 1.0)) * u_haze : 0.0;
  float dx = hb.x - abs(c.x);
  float dy = hb.y - abs(c.y);
  float along = dx < dy ? hb.y - abs(c.y) : hb.x - abs(c.x);
  float cl = u_cornerLen * min(u_res.x, u_res.y);
  float bracket = 1.0 - smoothstep(cl * 0.7, cl, along);
  float mask = mix(1.0, bracket, u_corners);
  float ang = atan(c.y, c.x);
  float grad = 0.5 + 0.5 * sin(ang * 2.0 + u_phase * 0.6);
  vec3 base = mix(u_c0, u_c1, grad);
  float run = pow(0.5 + 0.5 * cos(ang - u_phase), 7.0) * u_run + pow(0.5 + 0.5 * cos(ang + 3.14159 - u_phase), 7.0) * u_run * 0.6;
  vec3 col = base * (0.7 + 0.3 * grad) + u_c2 * run * 1.2;
  float k = (line + g) * mask + inner * mask * 0.5;
  col = mix(col, vec3(1.0), line * mask * 0.25) * k * u_bright * u_opacity;
  o = vec4(col, min(1.0, max(col.r, max(col.g, col.b))));
}`;

registerLayer({
  type: "frame",
  label: "Glowing frame",
  group: "accent",
  icon: "frame",
  params: {
    thickness: { kind: "number", label: "Thickness", min: 1, max: 40, default: 5 },
    inset: { kind: "number", label: "Inset", min: 0, max: 0.1, default: 0.025 },
    radius: { kind: "number", label: "Corner radius", min: 0, max: 0.25, default: 0.04 },
    glow: { kind: "number", label: "Glow", min: 0, max: 1, default: 0.6 },
    brightness: { kind: "number", label: "Brightness", min: 0, max: 4, default: 1.5 },
    cornersOnly: { kind: "bool", label: "Corners only", default: false },
    cornerLength: { kind: "number", label: "Corner length", min: 0.03, max: 0.5, default: 0.14 },
    chase: { kind: "number", label: "Running highlight", min: 0, max: 2, default: 0.8 },
    haze: { kind: "number", label: "Inner haze", min: 0, max: 1, default: 0.35 },
    pulse: { kind: "number", label: "Pulse on the beat", min: 0, max: 1, default: 0.8 },
  },
  create(ctx) {
    const prog = new Program(ctx.gl, FULLSCREEN_VS, FS);
    return {
      render(f) {
        const scale = f.h / 1080;
        const beat = f.signals.value("beat.pulse", f.tMs);
        const pulse = f.params.pulse as number;
        const chase = f.params.chase as number;
        const short = Math.min(f.w, f.h);
        prog
          .use()
          .f2("u_res", f.w, f.h)
          .f1("u_th", (f.params.thickness as number) * scale * (1 + 1.1 * pulse * beat))
          .f1("u_inset", (f.params.inset as number) * short)
          .f1("u_radius", (f.params.radius as number) * short)
          .f1("u_glow", (f.params.glow as number) * short * 0.014)
          .f1("u_bright", (f.params.brightness as number) * (1 + 0.7 * pulse * beat))
          .f1("u_corners", f.params.cornersOnly ? 1 : 0)
          .f1("u_cornerLen", f.params.cornerLength as number)
          .f1("u_phase", chase * (f.analysis.cum("mix.level", f.tMs) * 2.2 + f.motionSec * 0.35))
          .f1("u_haze", (f.params.haze as number) * (0.5 + 0.7 * f.signals.value("mix.level", f.tMs)))
          .f1("u_run", chase > 0 ? 1 : 0)
          .f1("u_opacity", f.opacity)
          .f3("u_c0", f.palette.colors[0])
          .f3("u_c1", f.palette.colors[1])
          .f3("u_c2", f.palette.accent);
        ctx.fullscreen.draw();
      },
      dispose() {
        prog.dispose();
      },
    };
  },
});
