/**
 * Synthgrid (SPEC.md §6.7 #5): a horizon sun with scanline cuts, a perspective
 * grid floor that surges forward on every beat, and mountains shaped by the
 * live spectrum. The sun swells with the kick.
 */
import { bgShader, beatPosition, commonParams, drive, fullscreenLayer } from "./_bg/util";
import { registerLayer } from "./registry";

const FS = bgShader(`
uniform float u_spec[64];
uniform float u_horizon; uniform float u_sunR; uniform float u_sunPulse; uniform float u_mount; uniform float u_scroll; uniform float u_dens;
uniform float u_bright; uniform float u_shift; uniform float u_kick; uniform float u_beat; uniform float u_bass; uniform float u_hi; uniform float u_drop;

float specAt(float x) {
  float fx = clamp(x, 0.0, 1.0) * 63.0;
  int i = int(floor(fx));
  float f = fx - float(i);
  f = f * f * (3.0 - 2.0 * f);
  return mix(u_spec[i], u_spec[min(i + 1, 63)], f);
}

float ridge(float x) { return gfbm(vec2(x * 3.0, 1.7), 4) * 0.8 + 0.2 * gnoise(vec2(x * 8.0, 4.0)) * 0.5; }

// a line of constant pixel width (about 1.6 px) that fades out where cells shrink below a few pixels
float gridLine(float g, float width, out float fw, out float dist) {
  fw = max(fwidth(g), 1e-5);
  dist = abs(fract(g - 0.5) - 0.5);
  float a = 1.0 - smoothstep(0.35 * width * fw, 1.0 * width * fw + 1e-5, dist);
  return a * (1.0 - smoothstep(0.18, 0.5, fw));
}

void main() {
  float hz = u_horizon;
  vec2 p = vec2((uv.x - 0.5) * u_aspect, uv.y);
  float px = 1.0 / u_res.y;
  vec3 col;
  float R = u_sunR * (1.0 + u_sunPulse * (0.07 * u_kick + 0.05 * u_drop));
  vec2 sc = vec2(0.0, hz + R * 0.2);

  // mountains: height at this x from the mirrored spectrum (bass on the outside)
  float xm = abs(uv.x - 0.5) * 2.0;
  float sp = specAt(1.0 - xm);
  float win = smoothstep(0.08, 0.55, xm);
  float mh = u_mount * (0.03 + 0.2 * ridge(p.x) * (0.35 + 1.5 * sp * (0.6 + 0.7 * u_bass))) * win;
  float aboveHz = uv.y - hz;

  if (uv.y >= hz) {
    // sky
    float h = aboveHz;
    vec3 hzCol = mix(palAt(2.0, u_shift), palAt(1.0, u_shift), 0.5);
    col = mix(hzCol * 0.2, u_bg, pow(smoothstep(0.0, 0.75, h), 0.55));
    col += palAt(0.0, u_shift) * 0.05 * smoothstep(0.5, 0.0, h);
    // stars
    vec2 g = p * (u_res.y / 52.0); vec2 id = floor(g); vec2 hh = hash22(id);
    float d = length((g - id - 0.2 - 0.6 * hh) * 52.0);
    float star = step(0.8, hash21(id + 2.0)) * aaFill(d - 0.7 * u_res.y / 720.0) * (0.4 + 0.6 * sin(u_t * (1.0 + 2.0 * hh.x) + hh.y * 30.0) * 0.5 + 0.3) * smoothstep(0.2, 0.7, h);
    col += vec3(star) * (0.5 + u_hi);
    // sun
    vec2 dv = p - sc;
    float dd = length(dv);
    float disc = aaFill((dd - R) / px);
    float sy = (sc.y - uv.y) / R; // 0 at the sun centre, 1 at its bottom
    float freq = 7.0;
    float s = sy * freq - u_t * 0.35;
    float cell = fract(s);
    float gap = clamp(sy * 1.0 + 0.2, 0.0, 0.9);
    float fwS = fwidth(s) * 1.2;
    float stripe = sy > -0.15 ? smoothstep(gap - fwS, gap + fwS, cell) : 1.0;
    float t = clamp((uv.y - hz) / (2.0 * R * 0.7 + 0.0001), 0.0, 1.0);
    vec3 sunCol = mix(palAt(1.0, u_shift), palAt(3.0, u_shift), smoothstep(0.0, 1.0, t));
    sunCol = mix(sunCol, palAt(0.0, u_shift), 0.35 * (1.0 - t));
    vec3 sun = sunCol * 0.8 * (1.0 + 0.25 * u_sunPulse * u_kick) * disc * stripe;
    float halo = exp(-max(dd - R, 0.0) * 5.5) * (1.0 - disc);
    col += sun + palAt(1.0, u_shift) * halo * (0.28 + 0.4 * u_sunPulse * u_kick) * 0.8;
    // mountains cover the sun and the sky behind them
    float edge = (aboveHz - mh);
    float fm = max(fwidth(mh) * 0.5, px);
    float cover = 1.0 - smoothstep(-1.0 * px, 1.0 * px + fm, edge);
    vec3 mtn = u_bg * 0.5 + palAt(0.0, u_shift) * 0.07 * exp(min(edge, 0.0) / 0.06) * (0.6 + sp);
    float rim = exp(-abs(edge) / (2.2 * px)) * step(0.001, mh);
    col = mix(col, mtn, cover);
    col += palAt(0.0, u_shift) * rim * (0.55 + 0.9 * sp + 0.5 * u_beat) * win * 0.9;
  } else {
    // floor
    float v = hz - uv.y;
    float zz = 0.16 / max(v, 1e-3);
    float gx = p.x * zz * u_dens * 1.5;
    float gz = zz * u_dens * 1.2 - u_scroll;
    float fwx, fwz, dx, dz;
    float lx = gridLine(gx, 1.7, fwx, dx);
    float lz = gridLine(gz, 1.7, fwz, dz);
    float fade = smoothstep(0.0, 0.1, v);
    float lines = max(lx, lz) * fade;
    float haloL = max(exp(-dx / (fwx * 5.0)) * (1.0 - smoothstep(0.18, 0.5, fwx)), exp(-dz / (fwz * 5.0)) * (1.0 - smoothstep(0.18, 0.5, fwz))) * fade;
    vec3 gcol = mix(palAt(1.0, u_shift), palAt(2.0, u_shift), clamp(v * 1.4, 0.0, 0.55));
    float lit = 0.8 + 0.9 * u_beat + 0.4 * u_bass;
    col = u_bg * 1.2;
    col += palAt(1.0, u_shift) * 0.06 * exp(-v * 9.0) * (1.0 + u_kick * u_sunPulse);
    // sun reflection streak
    col += palAt(3.0, u_shift) * 0.12 * exp(-pow(p.x / (R * 1.1), 2.0)) * exp(-v * 5.0);
    col += gcol * (lines * 0.95 + haloL * 0.24) * lit;
    col += gcol * exp(-v * 55.0) * 0.5;
  }
  col *= u_bright;
  col *= 0.72 + 0.28 * smoothstep(1.4, 0.3, length(p * vec2(0.7, 1.0) - vec2(0.0, 0.25)));
  o = vec4(col * u_opacity, u_opacity);
}`);

registerLayer({
  type: "synthgrid",
  label: "Synth grid",
  group: "background",
  icon: "grid-3x3",
  params: {
    ...commonParams({ brightness: 0.85 }),
    gridSpeed: { kind: "number", label: "Grid speed", min: 0, max: 4, default: 1 },
    gridDensity: { kind: "number", label: "Grid density", min: 0.4, max: 3, default: 1 },
    sunPulse: { kind: "number", label: "Sun pulse", min: 0, max: 1, default: 0.7 },
    sunSize: { kind: "number", label: "Sun size", min: 0.08, max: 0.5, default: 0.22 },
    mountains: { kind: "number", label: "Mountains", min: 0, max: 2, default: 1 },
    horizon: { kind: "number", label: "Horizon", min: 0.25, max: 0.7, default: 0.44 },
  },
  create(ctx) {
    const spec = new Float32Array(64);
    const smoothed = new Float32Array(64);
    return fullscreenLayer(ctx, FS, (p, f) => {
      const react = f.params.react as number;
      const d = drive(f, react);
      f.analysis.vector("spectrum", f.tMs, spec);
      // a touch of smoothing across bands so the ridge line is silky
      for (let i = 0; i < 64; i++) {
        const a = spec[Math.max(0, i - 1)] ?? 0;
        const b = spec[i] ?? 0;
        const c = spec[Math.min(63, i + 1)] ?? 0;
        smoothed[i] = (a * 0.25 + b * 0.5 + c * 0.25) * react;
      }
      p.fv("u_spec", smoothed);
      const sp = f.params.speed as number;
      const scroll = beatPosition(f, 0.8) * 0.5 * (f.params.gridSpeed as number) * sp;
      p.f1("u_horizon", f.params.horizon as number)
        .f1("u_sunR", f.params.sunSize as number)
        .f1("u_sunPulse", f.params.sunPulse as number)
        .f1("u_mount", f.params.mountains as number)
        .f1("u_dens", f.params.gridDensity as number)
        .f1("u_scroll", scroll)
        .f1("u_bright", f.params.brightness as number)
        .f1("u_shift", f.params.colorShift as number)
        .f1("u_kick", d.kick)
        .f1("u_beat", d.beat)
        .f1("u_bass", d.bass)
        .f1("u_hi", d.hi)
        .f1("u_drop", d.drop);
    });
  },
});
