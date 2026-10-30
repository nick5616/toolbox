/** Gradient (SPEC.md §6.7 #1): a slow mesh gradient of the palette's four colours. */
import { FULLSCREEN_VS, Program } from "../gl/core";
import { GLSL_COMMON, GLSL_PALETTE } from "../gl/glsl";
import { registerLayer, setPaletteUniforms } from "./registry";

const FS = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
${GLSL_COMMON}
${GLSL_PALETTE}
uniform float u_t; uniform float u_contrast; uniform float u_drift; uniform float u_intensity; uniform float u_brightness; uniform float u_opacity; uniform float u_aspect;
void main() {
  vec2 p = vec2(uv.x * u_aspect, uv.y);
  vec3 col = vec3(0.0); float wsum = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    vec2 c = vec2(0.5 * u_aspect, 0.5) + vec2(sin(u_t * (0.11 + fi * 0.03) + fi * 1.7), cos(u_t * (0.09 + fi * 0.04) + fi * 2.3)) * vec2(0.45 * u_aspect, 0.45) * (0.6 + u_drift);
    float w = 1.0 / pow(0.02 + dot(p - c, p - c), 1.0 + u_contrast * 1.5);
    col += paletteColor(fi) * w; wsum += w;
  }
  col /= wsum;
  col = mix(u_bg, col * u_brightness, u_intensity);
  col *= 0.85 + 0.3 * fbm(p * 3.0 + u_t * 0.05, 3);
  o = vec4(col * u_opacity, u_opacity);
}`;

registerLayer({
  type: "gradient",
  label: "Gradient",
  group: "background",
  icon: "palette",
  params: {
    speed: { kind: "number", label: "Speed", min: 0, max: 2, default: 0.5 },
    contrast: { kind: "number", label: "Contrast", min: 0, max: 1, default: 0.4 },
    drift: { kind: "number", label: "Drift", min: 0, max: 1, default: 0.3 },
    intensity: { kind: "number", label: "Colour amount", min: 0, max: 1, default: 0.6 },
    brightness: { kind: "number", label: "Brightness", min: 0, max: 1.5, default: 0.08 },
  },
  create(ctx) {
    const prog = new Program(ctx.gl, FULLSCREEN_VS, FS);
    return {
      render(f) {
        prog
          .use()
          .f1("u_t", f.motionSec * (f.params.speed as number))
          .f1("u_contrast", f.params.contrast as number)
          .f1("u_drift", f.params.drift as number)
          .f1("u_intensity", f.params.intensity as number)
          .f1("u_brightness", f.params.brightness as number)
          .f1("u_opacity", f.opacity)
          .f1("u_aspect", f.w / f.h);
        setPaletteUniforms(prog, f.palette);
        ctx.fullscreen.draw();
      },
      dispose() {
        prog.dispose();
      },
    };
  },
});
