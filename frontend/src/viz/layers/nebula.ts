/**
 * Nebula (SPEC.md §6.7 #2): domain-warped fBm clouds with star sparkle. Bass
 * deepens the warp, the kick breathes the exposure, hats make stars flare,
 * and the cloud flow speeds up with the loudness of the song.
 */
import { bgShader, commonParams, cumSignal, drive, fullscreenLayer, speedScale } from "./_bg/util";
import { registerLayer } from "./registry";

const FS = bgShader(`
uniform float u_warp; uniform float u_detail; uniform float u_sparkle; uniform float u_scale; uniform float u_flow;
uniform float u_bright; uniform float u_contrast; uniform float u_kick; uniform float u_bass; uniform float u_hats; uniform float u_drop;
uniform float u_shift; uniform float u_rot; uniform vec2 u_off; uniform float u_tw;

vec3 starLayer(vec2 sp, float cellPx, float off, float density, float tw) {
  vec2 g = sp * (u_res.y / cellPx) + off * 31.7;
  vec2 id = floor(g);
  float present = step(hash21(id + 7.3), density);
  vec2 h = hash22(id + off);
  vec2 pos = id + 0.2 + 0.6 * h;
  vec2 dv = (g - pos) * cellPx;
  float d = length(dv);
  float res = u_res.y / 720.0;
  float size = mix(0.6, 1.5, h.x * h.x) * res;
  float core = aaFill(d - size);
  float halo = exp(-d / (size * 3.0)) * 0.22;
  float twk = 0.6 + 0.4 * sin(u_t * (0.8 + 2.4 * h.y) + h.x * 40.0);
  float flare = tw * step(0.72, h.y);
  float spikes = (exp(-abs(dv.x) / (2.0 * res)) * exp(-abs(dv.y) / (14.0 * res)) + exp(-abs(dv.y) / (2.0 * res)) * exp(-abs(dv.x) / (14.0 * res))) * flare * h.x * 0.5;
  vec3 tint = mix(vec3(1.0), palAt(h.x * 4.0, u_shift), 0.4);
  return tint * (core + halo + spikes) * present * (0.35 + 0.65 * h.x) * (twk + flare * 1.6);
}

void main() {
  vec2 p = (uv - 0.5) * vec2(u_aspect, 1.0);
  vec2 sp = p;
  p = rot2(u_rot) * p * u_scale * 2.4 + u_off;
  float t = u_flow;
  float w = u_warp * (1.0 + 0.9 * u_bass + 0.5 * u_drop);
  vec2 q = vec2(gfbm(p + t * 0.11, 4), gfbm(p + vec2(5.2, 1.3) - t * 0.09, 4));
  vec2 r = vec2(gfbm(p + 3.0 * w * q + vec2(1.7, 9.2) + 0.15 * t, 4), gfbm(p + 3.0 * w * q + vec2(8.3, 2.8) + 0.126 * t, 4));
  float f = gfbm(p + 3.0 * w * r, int(u_detail));

  float d = clamp((f - 0.43) * (2.0 + u_contrast * 3.0), 0.0, 1.0);
  d = d * d * (3.0 - 2.0 * d); d = pow(d, 1.4);
  vec3 col = mix(palAt(0.0, u_shift), palAt(1.0, u_shift), smoothstep(0.3, 0.7, q.x));
  col = mix(col, palAt(2.0, u_shift), smoothstep(0.45, 0.75, r.y) * 0.8);
  float hot = pow(clamp((f - 0.45) * 2.2, 0.0, 1.0), 3.0);
  col = col * (0.55 + 0.9 * d) + palAt(3.0, u_shift) * hot * 0.7;
  float dust = 0.55 + 0.45 * smoothstep(0.3, 0.62, gnoise(p * 1.7 - r * 2.5 + 3.0));
  vec3 neb = col * d * dust * u_bright;
  neb += u_bg * 0.0 + palAt(1.5, u_shift) * 0.012 * (1.0 - d);

  vec3 st = starLayer(sp + vec2(u_t * 0.004, 0.0), 46.0, 0.0, 0.26, u_tw) + starLayer(sp * 1.0 + vec2(u_t * 0.009, u_t * 0.002), 21.0, 3.0, 0.24, u_tw) * 0.7;
  st *= u_sparkle * 1.25 * (1.0 - 0.75 * d);

  vec3 outc = u_bg + neb * (1.0 + 0.4 * u_kick + 0.35 * u_drop) + st;
  float vig = smoothstep(1.25, 0.25, length(sp * vec2(0.8, 1.0)));
  outc *= 0.55 + 0.45 * vig;
  o = vec4(outc * u_opacity, u_opacity);
}`);

registerLayer({
  type: "nebula",
  label: "Nebula",
  group: "background",
  icon: "cloud",
  params: {
    ...commonParams({ brightness: 0.44 }),
    warp: { kind: "number", label: "Warp", min: 0, max: 1.5, default: 0.6 },
    detail: { kind: "number", label: "Detail", min: 2, max: 7, default: 5, step: 1 },
    sparkle: { kind: "number", label: "Star sparkle", min: 0, max: 1.5, default: 0.6 },
    drift: { kind: "number", label: "Drift", min: 0, max: 2, default: 0.6 },
    contrast: { kind: "number", label: "Contrast", min: 0, max: 1, default: 0.5 },
    scale: { kind: "number", label: "Scale", min: 0.3, max: 3, default: 0.75 },
    x: { kind: "number", label: "Offset X", min: -2, max: 2, default: 0 },
    y: { kind: "number", label: "Offset Y", min: -2, max: 2, default: 0 },
    rotation: { kind: "number", label: "Rotation", min: -180, max: 180, default: 0 },
  },
  create(ctx) {
    return fullscreenLayer(ctx, FS, (p, f) => {
      const react = f.params.react as number;
      const d = drive(f, react);
      const drift = (f.params.drift as number) * (f.params.speed as number);
      const flow = f.motionSec * drift * 0.5 + cumSignal(f.signals, "mix.level", f.tMs) * speedScale(f) * drift * react * 0.9 + cumSignal(f.signals, "bass.level", f.tMs) * speedScale(f) * drift * react * 0.4;
      p.f1("u_warp", f.params.warp as number)
        .f1("u_detail", Math.round(f.params.detail as number))
        .f1("u_sparkle", f.params.sparkle as number)
        .f1("u_scale", f.params.scale as number)
        .f1("u_flow", flow)
        .f1("u_bright", f.params.brightness as number)
        .f1("u_contrast", f.params.contrast as number)
        .f1("u_kick", d.kick)
        .f1("u_bass", d.bass)
        .f1("u_hats", d.hats)
        .f1("u_drop", d.drop)
        .f1("u_tw", Math.min(1, d.hats * 1.2 + d.snare * 0.6))
        .f1("u_shift", f.params.colorShift as number)
        .f1("u_rot", ((f.params.rotation as number) * Math.PI) / 180)
        .f2("u_off", f.params.x as number, f.params.y as number);
    });
  },
});
