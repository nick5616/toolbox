/**
 * Kaleido (SPEC.md §6.7 #10, stateful): a kaleidoscope of a feedback buffer.
 * It folds the previous frame of the scene (which holds whatever the layers
 * beneath drew, plus this layer's own earlier output) into mirrored wedges,
 * zooms and swirls it a little every frame, and blends it back over the scene.
 * On its own it seeds the buffer with orbiting lights and kick rings so it
 * never shows black. Rates are per 1/60 s, so preview and export match.
 */
import { barPosition, bgShader, cumSignal, drive, fullscreenLayer, speedScale } from "./_bg/util";
import { registerLayer } from "./registry";

const FS = bgShader(`
uniform sampler2D u_prev;
uniform float u_segs; uniform float u_rot; uniform float u_zoomF; uniform float u_swirl; uniform float u_decay; uniform float u_mix; uniform float u_seed;
uniform float u_bright; uniform float u_shift; uniform float u_kick; uniform float u_bass; uniform float u_beat; uniform float u_snare; uniform float u_orbit;

void main() {
  vec2 p = (uv - 0.5) * vec2(u_aspect, 1.0);
  float r = length(p);
  float seg = 6.2831853 / u_segs;
  float a = atan(p.y, p.x) - u_rot;
  a = mod(a, seg);
  a = abs(a - seg * 0.5);
  a += u_rot + u_swirl * r;
  float rs = r * u_zoomF;
  vec2 q = rs * vec2(cos(a), sin(a));
  vec2 suv = q / vec2(u_aspect, 1.0) + 0.5;
  suv = 1.0 - abs(1.0 - mod(suv, 2.0));
  vec3 prev = texture(u_prev, suv).rgb * u_decay;

  // seeds: five lights on wandering orbits, drawn inside the folded wedge so they are mirrored at once
  vec3 inj = vec3(0.0);
  vec2 pf = r * vec2(cos(a), sin(a));
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float ang = u_orbit * (0.22 + 0.09 * fi) + fi * 1.9;
    float rad = 0.2 + 0.14 * sin(u_orbit * (0.31 + 0.11 * fi) + fi * 1.7) + 0.08 * u_bass;
    vec2 c = rad * vec2(cos(ang), sin(ang));
    vec2 dv = pf - c;
    float sz = 0.0007 + 0.0012 * fract(fi * 0.37) + 0.0015 * u_beat;
    inj += palAt(fi * 0.9 + 0.5, u_shift) * exp(-dot(dv, dv) / sz) * (0.45 + 0.6 * u_beat);
  }
  float ringR = 0.06 + 0.5 * (1.0 - u_kick);
  inj += palAt(2.0, u_shift) * exp(-pow((r - ringR) / 0.012, 2.0)) * u_kick * 0.5;
  inj += u_accent * exp(-pow((r - 0.35) / 0.01, 2.0)) * u_snare * 0.3;
  vec3 col = prev + inj * u_seed * u_bright;
  col = min(col, vec3(5.0));
  float al = u_mix * u_opacity;
  o = vec4(col * al, al);
}`);

registerLayer({
  type: "kaleido",
  label: "Kaleidoscope",
  group: "background",
  icon: "flower-2",
  stateful: true,
  params: {
    brightness: { kind: "number", label: "Brightness", min: 0, max: 2, default: 1 },
    react: { kind: "number", label: "Music reaction", min: 0, max: 2, default: 1 },
    speed: { kind: "number", label: "Speed", min: 0, max: 3, default: 1 },
    colorShift: { kind: "number", label: "Colour shift", min: 0, max: 4, default: 0 },
    segments: { kind: "number", label: "Segments", min: 4, max: 16, default: 8, step: 2 },
    spin: { kind: "number", label: "Spin", min: 0, max: 2, default: 0.6 },
    zoom: { kind: "number", label: "Zoom", min: 0, max: 1, default: 0.3 },
    swirl: { kind: "number", label: "Swirl", min: 0, max: 1, default: 0.25 },
    trail: { kind: "number", label: "Trail", min: 0, max: 1, default: 0.7 },
    seed: { kind: "number", label: "Own lights", min: 0, max: 2, default: 1 },
  },
  create(ctx) {
    return fullscreenLayer(ctx, FS, (p, f) => {
      const prev = ctx.previous();
      if (!prev) return false;
      const react = f.params.react as number;
      const d = drive(f, react);
      const sp = f.params.speed as number;
      const dt = f.dtMs / (1000 / 60);
      const segs = Math.max(4, Math.round((f.params.segments as number) / 2) * 2);
      const seg = (Math.PI * 2) / segs;
      const spin = f.params.spin as number;
      // one wedge per bar (smooth, and the picture repeats exactly at bar lines), plus slow drift and the drums
      const rot = spin * (barPosition(f) * seg * 0.5 + f.motionSec * 0.04 + cumSignal(f.signals, "drums.level", f.tMs) * speedScale(f) * 0.05 * react);
      const zoomRate = (f.params.zoom as number) * (0.006 + 0.018 * d.kick + 0.01 * d.drop) * sp;
      const trail = f.params.trail as number;
      const decay = Math.pow(0.996, dt);
      const persist = Math.pow(0.8 + 0.19 * trail, dt);
      p.tex("u_prev", 0, prev.tex)
        .f1("u_segs", segs)
        .f1("u_rot", rot)
        .f1("u_zoomF", Math.max(0.5, 1 - zoomRate * dt))
        .f1("u_swirl", (f.params.swirl as number) * (0.4 + 0.8 * d.bass) * 0.6)
        .f1("u_decay", decay)
        .f1("u_mix", persist)
        .f1("u_seed", (f.params.seed as number) * 0.2 * dt)
        .f1("u_bright", f.params.brightness as number)
        .f1("u_shift", f.params.colorShift as number)
        .f1("u_kick", d.kick)
        .f1("u_bass", d.bass)
        .f1("u_beat", d.beat)
        .f1("u_snare", d.snare)
        .f1("u_orbit", f.motionSec * sp * 0.6 + cumSignal(f.signals, "mix.level", f.tMs) * speedScale(f) * sp * react * 0.8);
    });
  },
});
