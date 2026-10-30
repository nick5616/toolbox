/**
 * Tunnel (SPEC.md §6.7 #6): a polar tunnel of rings. A new ring is born in the
 * distance on every beat and flies towards you; the walls twist with the bass
 * and the whole thing speeds up with the drums. Cells in the walls light up on
 * hi-hats.
 */
import { bgShader, beatPosition, commonParams, cumSignal, drive, fullscreenLayer, speedScale } from "./_bg/util";
import { registerLayer } from "./registry";

const FS = bgShader(`
uniform float u_travel; uniform float u_dens; uniform float u_segs; uniform float u_twist; uniform float u_spin; uniform float u_bright; uniform float u_shift;
uniform float u_kick; uniform float u_beat; uniform float u_bass; uniform float u_hats; uniform float u_drop; uniform float u_snare;
uniform vec2 u_off; uniform float u_rot;

void main() {
  vec2 p = (uv - 0.5) * vec2(u_aspect, 1.0) - u_off;
  p = rot2(u_rot) * p;
  float r = length(p);
  float a = atan(p.y, p.x);
  float z = 1.0 / pow(r + 0.015, 0.9);
  float g = z * u_dens - u_travel;
  float ringId = floor(g);
  float tw = u_twist * (0.25 + 0.9 * u_bass) * z * 0.12;
  float ac = (a / 6.2831853 + 0.5) * u_segs + (tw + u_spin) * u_segs / 6.2831853;
  float cell = floor(ac);
  vec2 cid = vec2(mod(cell, u_segs), ringId);
  float ch = hash21(cid + 3.7);

  float px = 1.0 / u_res.y;
  float fwG = 0.9 * u_dens * z / (r + 0.015) * px;
  float distG = abs(fract(g - 0.5) - 0.5);
  float ringLine = (1.0 - smoothstep(0.4 * 1.6 * fwG, 1.6 * fwG + 1e-5, distG)) * (1.0 - smoothstep(0.2, 0.5, fwG));
  float ringGlow = exp(-distG / (fwG * 6.0 + 0.004)) * (1.0 - smoothstep(0.15, 0.45, fwG));
  float fwA = u_segs / (6.2831853 * max(r, 1e-3)) * px;
  float distA = abs(fract(ac - 0.5) - 0.5);
  float segLine = (1.0 - smoothstep(0.4 * 1.4 * fwA, 1.4 * fwA + 1e-5, distA)) * (1.0 - smoothstep(0.15, 0.4, fwA));

  vec3 cRing = palAt(ringId * 0.6, u_shift);
  vec3 cSeg = palAt(ringId * 0.6 + 1.0, u_shift);
  float fillShade = 0.012 + 0.03 * (1.0 - fract(g));
  float litOn = step(0.95 - 0.35 * u_hats, ch);
  float lit = litOn * (0.1 + 0.55 * u_hats + 0.2 * u_snare) * (0.35 + 0.65 * fract(g)) * smoothstep(0.85, 0.15, r);
  vec3 col = cRing * (fillShade + lit);
  col += cRing * (ringLine * (0.9 + 1.0 * u_beat) + ringGlow * (0.16 + 0.2 * u_beat));
  col += cSeg * segLine * (0.2 + 0.3 * u_bass);
  float fade = smoothstep(0.0, 0.3, r);
  col *= fade;
  col += u_accent * exp(-r * 9.0) * (0.12 + 0.35 * u_drop + 0.2 * u_kick) + palAt(1.0, u_shift) * exp(-r * 3.5) * 0.05;
  col *= u_bright * (1.0 + 0.35 * u_kick);
  col += u_bg;
  col *= 0.7 + 0.3 * smoothstep(1.5, 0.4, r);
  o = vec4(col * u_opacity, u_opacity);
}`);

registerLayer({
  type: "tunnel",
  label: "Tunnel",
  group: "background",
  icon: "circle-dot",
  params: {
    ...commonParams({ brightness: 0.9 }),
    ringsPerBeat: { kind: "number", label: "Rings per beat", min: 0.25, max: 4, default: 1 },
    twist: { kind: "number", label: "Twist", min: 0, max: 3, default: 1 },
    density: { kind: "number", label: "Ring density", min: 0.2, max: 3, default: 1.8 },
    segments: { kind: "number", label: "Segments", min: 4, max: 24, default: 12, step: 1 },
    x: { kind: "number", label: "Centre X", min: -0.5, max: 0.5, default: 0 },
    y: { kind: "number", label: "Centre Y", min: -0.5, max: 0.5, default: 0 },
    rotation: { kind: "number", label: "Rotation", min: -180, max: 180, default: 0 },
  },
  create(ctx) {
    return fullscreenLayer(ctx, FS, (p, f) => {
      const react = f.params.react as number;
      const d = drive(f, react);
      const sp = f.params.speed as number;
      const rpb = f.params.ringsPerBeat as number;
      const travel = beatPosition(f, 0.65) * rpb * sp + cumSignal(f.signals, "drums.level", f.tMs) * speedScale(f) * react * sp * 1.4 + cumSignal(f.signals, "drop.pulse", f.tMs) * speedScale(f) * react * 2.5;
      const sway = f.motionSec * 0.25;
      p.f1("u_travel", travel)
        .f1("u_dens", f.params.density as number)
        .f1("u_segs", Math.round(f.params.segments as number))
        .f1("u_twist", f.params.twist as number)
        .f1("u_spin", f.motionSec * 0.08 * sp + cumSignal(f.signals, "bass.level", f.tMs) * speedScale(f) * react * 0.12)
        .f1("u_bright", f.params.brightness as number)
        .f1("u_shift", f.params.colorShift as number)
        .f1("u_kick", d.kick)
        .f1("u_beat", d.beat)
        .f1("u_bass", d.bass)
        .f1("u_hats", d.hats)
        .f1("u_snare", d.snare)
        .f1("u_drop", d.drop)
        .f2("u_off", (f.params.x as number) + Math.sin(sway) * 0.015 * (1 + d.bass), (f.params.y as number) + Math.cos(sway * 0.8) * 0.012)
        .f1("u_rot", ((f.params.rotation as number) * Math.PI) / 180);
    });
  },
});
