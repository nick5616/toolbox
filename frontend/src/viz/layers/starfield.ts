/**
 * Starfield (SPEC.md §6.7 #7): 3D stars flying past with streaks. Speed rises
 * with the drums, the kick pushes it, and a drop punches into warp speed with
 * long streaks. Every star's depth is a closed-form function of the cumulative
 * travel, so any frame can be drawn on its own.
 */
import { FULLSCREEN_VS, Program } from "../gl/core";
import { QuadBatch } from "../gl/quads";
import { bgShader, cumSignal, drive, speedScale } from "./_bg/util";
import { registerLayer, setPaletteUniforms } from "./registry";

const MAX_STARS = 1600;
const Z_FAR = 8;
const Z_NEAR = 0.16;

const SHADE_STREAK = `
uniform float u_glow;
vec4 shade(vec2 p, vec2 h, vec4 color, vec4 extra) {
  float L = max(h.x - h.y, 0.0);
  float tt = L > 0.001 ? clamp((p.x + L) / (2.0 * L), 0.0, 1.0) : 1.0;
  float rad = h.y * mix(0.3, 1.0, tt);
  vec2 q = vec2(clamp(p.x, -L, L), 0.0);
  float d = length(p - q) - rad;
  float body = aaFill(d) * mix(0.12, 1.0, tt * tt);
  float halo = exp(-max(d, 0.0) / (h.y * 1.6 + 0.4)) * 0.25 * (0.2 + 0.8 * tt) * (1.0 - aaFill(d)) * (1.0 - smoothstep(0.0, 8.0, d));
  float a = (body + halo) * color.a;
  return vec4(color.rgb * a, 0.0);
}`;

const HAZE = bgShader(`
uniform float u_speed; uniform float u_flow; uniform float u_bright; uniform float u_shift; uniform float u_drop; uniform float u_kick;
void main() {
  vec2 p = (uv - 0.5) * vec2(u_aspect, 1.0);
  float r = length(p);
  float cloud = gfbm(p * 1.8 + vec2(u_flow * 0.02, 3.0), 4);
  cloud = smoothstep(0.35, 0.85, cloud);
  vec3 col = palAt(0.5 + cloud * 2.0, u_shift) * cloud * 0.07 * u_bright;
  col += palAt(1.0, u_shift) * exp(-r * 4.0) * (0.02 + 0.06 * u_speed + 0.12 * u_drop) * u_bright;
  col += u_accent * exp(-r * 12.0) * (0.03 + 0.25 * u_drop + 0.08 * u_kick) * u_bright;
  col += u_bg;
  col *= 0.7 + 0.3 * smoothstep(1.4, 0.3, r);
  o = vec4(col * u_opacity, u_opacity);
}`);

registerLayer({
  type: "starfield",
  label: "Starfield",
  group: "background",
  icon: "star",
  params: {
    density: { kind: "number", label: "Density", min: 0.1, max: 1, default: 0.6 },
    speed: { kind: "number", label: "Speed", min: 0, max: 3, default: 1 },
    warp: { kind: "number", label: "Warp", min: 0, max: 2, default: 1 },
    brightness: { kind: "number", label: "Brightness", min: 0, max: 2, default: 1 },
    react: { kind: "number", label: "Music reaction", min: 0, max: 2, default: 1 },
    size: { kind: "number", label: "Star size", min: 0.4, max: 3, default: 1 },
    colorShift: { kind: "number", label: "Colour shift", min: 0, max: 4, default: 0 },
  },
  create(ctx) {
    const gl = ctx.gl;
    const rnd = ctx.rng("starfield");
    const hazeProg = new Program(gl, FULLSCREEN_VS, HAZE);
    const batch = new QuadBatch(gl, SHADE_STREAK, MAX_STARS);
    // per star: phase, radius, angle, hue, size, brightness
    const stars = new Float32Array(MAX_STARS * 6);
    for (let i = 0; i < MAX_STARS; i++) {
      stars[i * 6] = rnd();
      stars[i * 6 + 1] = 0.36 + Math.sqrt(rnd()) * 1.4;
      stars[i * 6 + 2] = rnd() * Math.PI * 2;
      stars[i * 6 + 3] = rnd() * 4;
      stars[i * 6 + 4] = 0.6 + rnd() * rnd() * 1.6;
      stars[i * 6 + 5] = 0.35 + rnd() * 0.65;
    }
    return {
      render(f) {
        const react = f.params.react as number;
        const d = drive(f, react);
        const sp = f.params.speed as number;
        const warp = f.params.warp as number;
        const bright = f.params.brightness as number;
        const sScale = speedScale(f);
        // travel in whole fly-throughs; the instantaneous speed sets the streak length
        const cyc = 0.035 * sp * f.motionSec + 0.11 * sp * react * cumSignal(f.signals, "drums.level", f.tMs) * sScale + 0.5 * warp * react * sp * cumSignal(f.signals, "drop.pulse", f.tMs) * sScale + 0.04 * sp * react * cumSignal(f.signals, "kick", f.tMs) * sScale;
        const vNow = 0.035 * sp + 0.11 * sp * d.drums + 0.5 * warp * sp * d.drop + 0.35 * sp * d.kick * 0.2 + 0.25 * warp * sp * d.lift;
        const streakCyc = vNow * 0.09 * (0.6 + warp * 0.8);

        const haze = hazeProg.use();
        haze.f1("u_t", f.motionSec).f1("u_opacity", f.opacity).f1("u_aspect", f.w / f.h).f2("u_res", f.w, f.h);
        haze.f1("u_speed", Math.min(1, vNow * 8)).f1("u_flow", f.motionSec + cyc * 40).f1("u_bright", bright).f1("u_shift", f.params.colorShift as number).f1("u_drop", d.drop).f1("u_kick", d.kick);
        setPaletteUniforms(haze, f.palette);
        ctx.fullscreen.draw();

        const count = Math.round(MAX_STARS * (f.params.density as number) * (f.quality === "draft" ? 0.5 : 1));
        const cx = f.w / 2;
        const cy = f.h / 2;
        const half = f.h * 0.5;
        const res = f.h / 720;
        const sizeK = f.params.size as number;
        const shift = f.params.colorShift as number;
        batch.begin();
        const pulse = 1 + 0.5 * d.beat;
        for (let i = 0; i < count; i++) {
          const phase = stars[i * 6] as number;
          const rho = stars[i * 6 + 1] as number;
          const ang = stars[i * 6 + 2] as number;
          const hue = stars[i * 6 + 3] as number;
          const sz = stars[i * 6 + 4] as number;
          const br = stars[i * 6 + 5] as number;
          const fr = (((phase - cyc) % 1) + 1) % 1; // 0 near .. 1 far
          const Z = Z_NEAR + (Z_FAR - Z_NEAR) * fr;
          const Zt = Z + streakCyc * (Z_FAR - Z_NEAR);
          const rh = (rho * half) / Z;
          const rt = (rho * half) / Zt;
          const ca = Math.cos(ang);
          const sa = Math.sin(ang);
          const hx = cx + ca * rh;
          const hy = cy + sa * rh;
          if (Math.abs(hx - cx) > f.w * 0.65 || Math.abs(hy - cy) > f.h * 0.65) continue;
          const tx = cx + ca * rt;
          const ty = cy + sa * rt;
          const near = 1 - fr; // 0 far, 1 near
          const radius = (0.5 + near * 0.9 * sz) * res * sizeK;
          const len = Math.hypot(hx - tx, hy - ty);
          const fadeIn = Math.min(1, (1 - fr) * 6);
          const b = br * (0.35 + 0.9 * near) * fadeIn * bright * f.opacity * 1.5 * pulse;
          const col = tint(f.palette.colors, hue + shift);
          const mx = (hx + tx) / 2;
          const my = (hy + ty) / 2;
          batch.push(mx, my, len / 2 + radius, radius, col[0] * b, col[1] * b, col[2] * b, 1, Math.atan2(hy - ty, hx - tx));
        }
        batch.draw(f.w, f.h, 8, (q) => q.f1("u_glow", 0));
      },
      dispose() {
        hazeProg.dispose();
        batch.dispose();
      },
    };
  },
});

/** A star colour: mostly white, tinted towards the palette. */
function tint(colors: ReadonlyArray<readonly [number, number, number]>, h: number): [number, number, number] {
  const k = ((h % 4) + 4) % 4;
  const i = Math.floor(k);
  const a = colors[i % 4] as readonly [number, number, number];
  const b = colors[(i + 1) % 4] as readonly [number, number, number];
  const t = k - i;
  const m = (j: 0 | 1 | 2) => a[j] + (b[j] - a[j]) * t;
  const w = 0.35;
  return [w + (1 - w) * m(0), w + (1 - w) * m(1), w + (1 - w) * m(2)];
}
