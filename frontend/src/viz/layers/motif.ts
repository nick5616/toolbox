/**
 * Motif (SPEC.md §6.7 #30): one of 12 lyric motifs drawn as a particle and
 * overlay effect: fire, rain, snow, stars, ocean, flowers, hearts, city, sun,
 * night, storm, smoke. Each has natural colours (softly tinted by the
 * palette). The director adds the layer where lyrics evoke a motif and drives
 * `amount` from line.active; on its own the layer draws at the amount given.
 * Night also darkens the picture under a normal blend; under an additive blend
 * only its lights show.
 */
import { FULLSCREEN_VS, Program } from "../gl/core";
import { GLSL_COMMON } from "../gl/glsl";
import { MOTIFS, type Motif } from "../types";
import { NATURAL, drawMotifParticles, tinted, type MotifFrame } from "./_motifs";
import { SpriteBatch } from "./_particles";
import { registerLayer } from "./registry";

const FS = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
${GLSL_COMMON}
uniform vec2 u_res;
uniform float u_motif, u_time, u_cum, u_amt, u_int, u_lvl, u_pulse, u_flash, u_size, u_wind, u_opacity;
uniform vec3 u_col, u_col2;

vec3 flameRamp(float h) {
  vec3 deep = u_col * u_col * vec3(0.75, 0.25, 0.1);
  vec3 hot = mix(u_col, u_col2, 0.85);
  vec3 c = mix(vec3(0.0), deep, smoothstep(0.04, 0.34, h));
  c = mix(c, u_col, smoothstep(0.3, 0.62, h));
  c = mix(c, hot, smoothstep(0.72, 1.1, h));
  return mix(c, vec3(1.15, 1.05, 0.9), smoothstep(1.12, 1.7, h));
}

vec4 fire(vec2 q) {
  float t = u_time;
  float tongue = 0.5 + 0.95 * vnoise(vec2(q.x * 5.5 + 3.0, t * 0.5)) + 0.3 * vnoise(vec2(q.x * 14.0, t * 1.2));
  float H = (0.2 + 0.22 * u_lvl + 0.1 * u_pulse) * u_amt * u_size * tongue;
  float yy = q.y / max(H, 0.01);
  float sway = (fbm(vec2(q.x * 2.5, q.y * 1.8 - t * 0.9), 3) - 0.5) * 0.22 * smoothstep(0.0, 1.0, yy);
  float n3 = fbm(vec2((q.x + sway) * 7.0, q.y * 3.2 - t * 2.0), 5);
  float heat = clamp(1.0 - yy * (0.3 + 1.25 * n3), 0.0, 1.0);
  heat = pow(heat, 1.5) * (0.85 + 0.35 * n3) * smoothstep(1.35, 0.85, yy);
  float n4 = fbm(vec2((q.x - sway) * 4.0 + 9.0, q.y * 2.0 - t * 1.2), 4);
  float back = clamp(1.0 - yy * (0.15 + 0.9 * n4) * 0.7, 0.0, 1.0);
  back = pow(back, 2.0) * 0.5 * smoothstep(1.7, 1.0, yy);
  vec3 c = flameRamp(heat) * smoothstep(0.02, 0.18, heat) + flameRamp(back * 0.8) * smoothstep(0.02, 0.2, back) * 0.7;
  c += u_col * 0.08 * exp(-q.y * 3.0) * u_amt * (0.6 + u_lvl);
  return vec4(c, 1.0);
}

vec4 ocean(vec2 q) {
  float t = u_time;
  float amp = (0.5 + 1.1 * u_lvl + 0.5 * u_pulse) * u_amt;
  float hor = 0.36 * u_size;
  vec3 acc = vec3(0.0);
  vec3 deepc = u_col * vec3(0.25, 0.5, 0.9);
  for (int k = 0; k < 7; k++) {
    float fk = float(k) / 6.0;
    float base = hor - 0.34 * u_size * pow(fk, 0.85);
    float A = (0.005 + 0.03 * fk) * amp;
    float f = 6.5 - 3.5 * fk;
    float sp = 0.5 + 0.9 * fk;
    float yk = base + A * (sin(q.x * f + t * sp + float(k) * 1.7 + u_cum * 1.4) + 0.5 * sin(q.x * f * 2.3 - t * sp * 1.3 + float(k) * 2.9));
    float dist = q.y - yk;
    float fill = smoothstep(0.0, -0.3, dist) * step(dist, 0.0);
    acc += mix(deepc, u_col, 0.5 + 0.5 * fk) * fill * 0.1 * u_amt;
    float th = 0.0035 + 0.0045 * fk;
    float line = exp(-abs(dist) / th) * (0.35 + 0.65 * fk);
    float foam = 0.5 + 0.9 * pow(vnoise(vec2(q.x * 10.0 - t * 0.4 * (1.0 + fk), float(k) * 7.0)), 2.0);
    acc += mix(u_col, u_col2, 0.6) * line * foam * 0.7 * u_amt;
    float g = pow(vnoise(vec2(q.x * 9.0 + float(k) * 13.0 + t * 0.35, q.y * 85.0 + t * 1.6 + sin(q.x * 3.0) * 2.0)), 6.0);
    acc += u_col2 * g * 0.9 * step(dist, 0.0) * smoothstep(-0.07, 0.0, dist) * (0.4 + fk) * u_amt;
  }
  acc += u_col2 * 0.07 * exp(-abs(q.y - hor) * 22.0) * u_amt;
  return vec4(acc, 1.0);
}

vec4 sun(vec2 q, float asp) {
  vec2 sp = vec2(0.68 * asp, 0.7);
  vec2 d = q - sp;
  float r = length(d) / u_size;
  float ang = atan(d.y, d.x);
  float bump = 1.0 + 0.18 * u_pulse + 0.1 * u_lvl;
  float core = exp(-r * r * 520.0) * 2.4;
  float glow = exp(-r * 7.0) * 0.6 + exp(-r * 2.2) * 0.2;
  float rays = pow(0.5 + 0.5 * sin(ang * 9.0 + u_time * 0.18 + 1.6 * vnoise(vec2(ang * 3.0, u_time * 0.08))), 5.0) * exp(-r * 1.7);
  rays += 0.6 * pow(0.5 + 0.5 * sin(ang * 17.0 - u_time * 0.12 + 2.0), 6.0) * exp(-r * 2.6);
  vec3 c = mix(u_col, vec3(1.1, 1.0, 0.9), 0.4) * core + u_col * glow + mix(u_col, u_col2, 0.4) * rays * 0.36;
  vec2 ctr = vec2(0.5 * asp, 0.5);
  for (int j = 1; j < 4; j++) {
    float fj = float(j);
    vec2 gp = sp + (ctr - sp) * (0.55 * fj + 0.1);
    float rj = (0.025 + 0.03 * fj) * u_size;
    float dd = length(q - gp);
    float ring = exp(-pow((dd - rj) / 0.006, 2.0)) * 0.22;
    float disc = smoothstep(rj, rj * 0.2, dd) * 0.06;
    c += mix(u_col2, u_col, fj * 0.3) * (ring + disc);
  }
  return vec4(c * u_amt * bump, 1.0);
}

vec4 night(vec2 q, float asp) {
  float t = u_time;
  vec2 mp = vec2(0.78 * asp, 0.74);
  vec2 d = q - mp;
  float R = 0.075 * u_size;
  float dm = length(d);
  float disc = smoothstep(R + 0.002, R - 0.002, dm);
  float cres = smoothstep(R + 0.002, R - 0.002, length(d + vec2(0.032 * u_size, 0.012)));
  float lit = disc * (1.0 - cres * 0.92);
  float crater = 0.8 + 0.3 * fbm(d / R * 3.0 + 2.0, 4);
  float cloud = smoothstep(0.5, 0.85, fbm(vec2(q.x * 1.8 - t * 0.025, q.y * 4.5 + 2.0), 5));
  float halo = exp(-max(dm - R, 0.0) / (0.1 * u_size)) * 0.32 + exp(-max(dm - R, 0.0) / (0.4 * u_size)) * 0.08;
  vec3 c = u_col * (lit * crater * 1.9 * (1.0 - cloud * 0.55) + halo * (1.0 - cloud * 0.4));
  c += u_col * 0.1 * cloud * exp(-dm * 2.0) * smoothstep(0.3, 0.8, q.y);
  c += vec3(0.05, 0.08, 0.2) * smoothstep(0.0, 0.8, q.y) * 0.03;
  c *= u_amt;
  float g = (0.28 + 0.14 * q.y) * u_amt;
  vec3 grade = u_col2 * g * 0.15;
  return vec4(c + grade, clamp(max(max(c.r, max(c.g, c.b)), g), 0.0, 1.0));
}

vec4 storm(vec2 q) {
  float t = u_time;
  float cl = fbm(vec2(q.x * 2.2 - t * 0.05, q.y * 3.5 + 3.0), 5);
  float mask = smoothstep(0.38, 0.85, q.y) * smoothstep(0.32, 0.72, cl);
  vec3 c = u_col2 * u_flash * mask * 0.6 + u_col * mask * 0.035 * u_amt;
  c += u_col * u_flash * 0.12 * (0.4 + 0.6 * q.y);
  return vec4(c, 1.0);
}

vec4 smoke(vec2 q) {
  float t = u_time * 0.3 + u_cum * 0.25;
  vec3 c = vec3(0.0);
  float a = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    vec2 p = q * (1.4 + fi * 0.9) / u_size + vec2(u_wind * t * 0.4 + fi * 3.0, -t * (0.25 + 0.12 * fi));
    vec2 w = vec2(fbm(p + vec2(0.0, t * 0.2), 3), fbm(p + vec2(5.2, 1.3), 3));
    float n = fbm(p + 1.6 * w, 4);
    float dn = smoothstep(0.38, 0.85, n) * (0.55 + 0.45 * smoothstep(0.0, 0.6, 1.0 - q.y + 0.2 * fi));
    c += mix(u_col, u_col2, 0.25 + 0.35 * w.x + 0.2 * u_pulse) * dn * (0.2 - 0.04 * fi);
  }
  float lit = exp(-length(q - vec2(0.5 * u_res.x / u_res.y, 0.05)) * 1.3);
  c *= (0.55 + 0.9 * lit) * (0.8 + 0.5 * u_lvl);
  return vec4(c * u_amt * 0.7, 1.0);
}

vec4 haze(vec2 q, float k) {
  // Soft ground light for the particle motifs: k 0 rain mist, 1 snow ground, 2 hearts bloom, 3 city horizon, 4 stars dust, 5 flowers light
  vec3 c = vec3(0.0);
  if (k < 0.5) {
    float m = fbm(vec2(q.x * 2.0 - u_time * 0.05, q.y * 5.0), 4);
    c = u_col2 * exp(-q.y * 5.0) * (0.12 + 0.3 * m) * u_amt;
  } else if (k < 1.5) {
    c = u_col * exp(-q.y * 6.0) * 0.16 * u_amt * (0.7 + 0.5 * fbm(vec2(q.x * 3.0 + u_time * 0.03, q.y * 8.0), 3));
  } else if (k < 2.5) {
    c = u_col * exp(-length(q - vec2(0.5 * u_res.x / u_res.y, -0.1)) * 1.7) * (0.14 + 0.16 * u_pulse) * u_amt;
  } else if (k < 3.5) {
    c = mix(u_col, u_col2, smoothstep(0.1, 0.5, q.x / (u_res.x / u_res.y))) * exp(-abs(q.y - 0.3) * 4.5) * 0.16 * u_amt * (0.7 + 0.5 * u_lvl);
  } else if (k < 4.5) {
    float ang = 0.55;
    vec2 r = vec2(cos(ang) * q.x + sin(ang) * q.y, -sin(ang) * q.x + cos(ang) * q.y);
    float band = exp(-pow((r.y - 0.45) / 0.18, 2.0));
    c = mix(u_col2, u_col, 0.35) * band * smoothstep(0.3, 0.85, fbm(vec2(r.x * 3.0, r.y * 6.0), 5)) * 0.09 * u_amt;
  } else {
    c = u_col2 * exp(-length(q - vec2(0.5 * u_res.x / u_res.y, 0.9)) * 1.4) * 0.1 * u_amt;
  }
  return vec4(c, 1.0);
}

void main() {
  float asp = u_res.x / u_res.y;
  vec2 q = vec2(uv.x * asp, uv.y);
  vec4 r;
  if (u_motif < 0.5) r = fire(q);
  else if (u_motif < 1.5) r = haze(q, 0.0);
  else if (u_motif < 2.5) r = haze(q, 1.0);
  else if (u_motif < 3.5) r = haze(q, 4.0);
  else if (u_motif < 4.5) r = ocean(q);
  else if (u_motif < 5.5) r = haze(q, 5.0);
  else if (u_motif < 6.5) r = haze(q, 2.0);
  else if (u_motif < 7.5) r = haze(q, 3.0);
  else if (u_motif < 8.5) r = sun(q, asp);
  else if (u_motif < 9.5) r = night(q, asp);
  else if (u_motif < 10.5) r = storm(q);
  else r = smoke(q);
  vec3 c = r.rgb * u_int * u_opacity;
  float a = u_motif > 8.5 && u_motif < 9.5 ? r.a * u_opacity : clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0);
  o = vec4(c, a);
}`;

registerLayer({
  type: "motif",
  label: "Motif",
  group: "motif",
  icon: "wand-sparkles",
  params: {
    motif: { kind: "enum", label: "Motif", options: MOTIFS, default: "fire" },
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0.9 },
    intensity: { kind: "number", label: "Intensity", min: 0, max: 3, default: 1.1 },
    speed: { kind: "number", label: "Speed", min: 0.2, max: 3, default: 1 },
    size: { kind: "number", label: "Size", min: 0.4, max: 2.5, default: 1 },
    density: { kind: "number", label: "Density", min: 0.2, max: 1.5, default: 1 },
    wind: { kind: "number", label: "Wind", min: -1, max: 1, default: 0.2 },
    tint: { kind: "number", label: "Palette tint", min: 0, max: 1, default: 0.2 },
  },
  create(ctx) {
    const prog = new Program(ctx.gl, FULLSCREEN_VS, FS);
    const batch = new SpriteBatch(ctx.gl, 700);
    return {
      render(f) {
        const motif = f.params.motif as Motif;
        const idx = Math.max(0, MOTIFS.indexOf(motif));
        const amt = f.params.amount as number;
        if (amt < 0.01) return;
        const speed = f.params.speed as number;
        const nat = NATURAL[motif];
        const tint = f.params.tint as number;
        const m: MotifFrame = {
          w: f.w,
          h: f.h,
          seed: f.seed,
          tMs: f.tMs,
          t: f.motionSec * speed,
          amt,
          size: f.params.size as number,
          wind: f.params.wind as number,
          density: (f.params.density as number) * (motif === "night" ? 0.45 : 1),
          sc: f.h / 720,
          lvl: f.signals.value("mix.level", f.tMs),
          beat: f.signals.value("beat.pulse", f.tMs),
          kick: f.signals.value("kick", f.tMs),
          cum: f.analysis.cum("mix.level", f.tMs),
          draft: f.quality === "draft",
          bright: (f.params.intensity as number) * 1.0,
          palette: f.palette,
          tint,
          col: tinted(nat[0], f.palette, tint, 0.15),
          col2: tinted(nat[1], f.palette, tint, 0.6),
          flash: 0,
          analysis: f.analysis,
        };
        batch.begin(f.opacity);
        const flash = drawMotifParticles(motif, batch, m);
        prog
          .use()
          .f2("u_res", f.w, f.h)
          .f1("u_motif", idx)
          .f1("u_time", m.t)
          .f1("u_cum", m.cum)
          .f1("u_amt", amt)
          .f1("u_int", f.params.intensity as number)
          .f1("u_lvl", m.lvl)
          .f1("u_pulse", Math.max(m.beat * 0.6, m.kick))
          .f1("u_flash", flash)
          .f1("u_size", m.size)
          .f1("u_wind", m.wind)
          .f1("u_opacity", f.opacity)
          .f3("u_col", m.col)
          .f3("u_col2", m.col2);
        ctx.fullscreen.draw();
        const glowK = motif === "fire" ? 0.8 : motif === "storm" ? 0.9 : motif === "stars" || motif === "night" ? 0.5 : 0.3;
        batch.draw(f.w, f.h, glowK);
      },
      dispose() {
        prog.dispose();
        batch.dispose();
      },
    };
  },
});
