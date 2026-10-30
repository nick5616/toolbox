/**
 * Ink (SPEC.md §6.7 #4): metaball ink in water, slow and soft. Blobs drift on
 * seeded Lissajous paths, swell with the vocals and are nudged by the kick.
 */
import { bgShader, commonParams, cumSignal, drive, fullscreenLayer, speedScale } from "./_bg/util";
import { registerLayer } from "./registry";

const MAX = 12;

const FS = bgShader(`
uniform vec4 u_a[12]; uniform vec4 u_b[12];
uniform float u_blobs; uniform float u_visc; uniform float u_swell; uniform float u_size; uniform float u_edge; uniform float u_flow;
uniform float u_bright; uniform float u_shift; uniform float u_kick; uniform float u_bass; uniform float u_voc;

void main() {
  vec2 p = (uv - 0.5) * vec2(u_aspect, 1.0);
  float t = u_flow;
  // organic, slowly moving wobble of the water
  vec2 wob = vec2(gfbm(p * 2.6 + vec2(t * 0.07, 0.0), 3), gfbm(p * 2.6 + vec2(4.0, -t * 0.06), 3)) - 0.5;
  vec2 pw = p + wob * (0.11 + 0.05 * u_bass);
  float F = 0.0;
  vec3 colSum = vec3(0.0);
  float wsum = 1e-4;
  for (int i = 0; i < 12; i++) {
    if (float(i) >= u_blobs) break;
    vec4 a = u_a[i]; vec4 b = u_b[i];
    vec2 c = vec2(sin(t * a.x + a.z) * 0.42 * u_aspect + 0.12 * sin(t * a.x * 0.41 + a.w * 3.0),
                  cos(t * a.y + a.w) * 0.34 + 0.08 * sin(t * a.y * 0.37 + a.z * 2.0));
    c *= 1.0 + 0.05 * u_kick;
    float r = b.x * u_size * (1.0 + u_swell * u_voc * (0.5 + 0.5 * b.z) + 0.1 * u_kick * b.w) * 2.3;
    vec2 dv = pw - c;
    float q = clamp(1.0 - dot(dv, dv) / (r * r), 0.0, 1.0);
    float w = q * q * q;
    F += w;
    colSum += palAt(b.y, u_shift) * w;
    wsum += w;
  }
  vec3 tone = colSum / wsum;
  F *= 0.78 + 0.5 * gfbm(pw * 5.5 + t * 0.12, 4);
  float iso = 0.3;
  float soft = 0.04 + 0.16 * u_visc;
  float inner = smoothstep(iso - soft, iso + soft, F);
  float depth = clamp((F - iso) / 0.7, 0.0, 1.0);
  float marble = gfbm(pw * 3.8 + F * 1.1 + t * 0.1, 4);
  vec3 ink = mix(tone, palAt(marble * 4.0, u_shift), 0.3 * smoothstep(0.2, 0.9, depth));
  vec3 body = ink * (0.10 + 0.6 * depth * (0.5 + 0.9 * marble));
  float rim = exp(-pow((F - iso) / (0.045 + 0.05 * u_visc), 2.0));
  vec3 rimCol = tone * 1.25 + u_accent * 0.1;
  float cloud = smoothstep(0.0, iso, F);
  float wisp = smoothstep(0.04, 0.3, F) * (1.0 - inner) * smoothstep(0.42, 0.75, gfbm(pw * 7.0 - t * 0.08 + F * 2.0, 4));
  vec3 col = body * inner + rimCol * rim * u_edge * 0.7 + tone * (cloud * cloud * 0.05 + wisp * 0.32);
  col *= u_bright * (1.0 + 0.3 * u_kick);
  col += u_bg;
  col *= 0.65 + 0.35 * smoothstep(1.3, 0.2, length(p * vec2(0.8, 1.0)));
  o = vec4(col * u_opacity, u_opacity);
}`);

registerLayer({
  type: "ink",
  label: "Ink",
  group: "background",
  icon: "droplets",
  params: {
    ...commonParams({ brightness: 0.8, speed: 0.8 }),
    blobs: { kind: "number", label: "Blobs", min: 4, max: 12, default: 8, step: 1 },
    viscosity: { kind: "number", label: "Viscosity", min: 0, max: 1, default: 0.5 },
    swell: { kind: "number", label: "Swell", min: 0, max: 1.5, default: 0.8 },
    size: { kind: "number", label: "Blob size", min: 0.5, max: 2, default: 1 },
    edge: { kind: "number", label: "Edge light", min: 0, max: 1.5, default: 0.7 },
  },
  create(ctx) {
    const rnd = ctx.rng("ink");
    const a = new Float32Array(MAX * 4);
    const b = new Float32Array(MAX * 4);
    for (let i = 0; i < MAX; i++) {
      a[i * 4] = 0.07 + rnd() * 0.12; // x frequency
      a[i * 4 + 1] = 0.06 + rnd() * 0.12; // y frequency
      a[i * 4 + 2] = rnd() * 6.283;
      a[i * 4 + 3] = rnd() * 6.283;
      b[i * 4] = 0.11 + rnd() * 0.08; // radius
      b[i * 4 + 1] = i * 0.9 + rnd() * 0.5; // palette position
      b[i * 4 + 2] = rnd(); // how much it swells
      b[i * 4 + 3] = rnd(); // how much the kick nudges it
    }
    return fullscreenLayer(ctx, FS, (p, f) => {
      const react = f.params.react as number;
      const d = drive(f, react);
      const visc = f.params.viscosity as number;
      const sp = (f.params.speed as number) * (1.15 - 0.8 * visc);
      const flow = f.motionSec * sp * 0.8 + cumSignal(f.signals, "mix.level", f.tMs) * speedScale(f) * sp * react * 0.5;
      p.gl.uniform4fv(p.loc("u_a"), a);
      p.gl.uniform4fv(p.loc("u_b"), b);
      p.f1("u_blobs", Math.round(f.params.blobs as number))
        .f1("u_visc", visc)
        .f1("u_swell", f.params.swell as number)
        .f1("u_size", f.params.size as number)
        .f1("u_edge", f.params.edge as number)
        .f1("u_flow", flow)
        .f1("u_bright", f.params.brightness as number)
        .f1("u_shift", f.params.colorShift as number)
        .f1("u_kick", d.kick)
        .f1("u_bass", d.bass)
        .f1("u_voc", d.vocals);
    });
  },
});
