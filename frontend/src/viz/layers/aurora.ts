/**
 * Aurora (SPEC.md §6.7 #3): curtains or bands of light. The left half follows
 * the left channel and the right half the right one (from the stereo balance);
 * the outer edges tint blue on the left and red on the right with the level.
 */
import { bgShader, commonParams, cumSignal, drive, fullscreenLayer, speedScale } from "./_bg/util";
import { registerLayer } from "./registry";

const FS = bgShader(`
uniform float u_bands; uniform float u_height; uniform float u_tint; uniform float u_curtain; uniform float u_scale; uniform float u_flow;
uniform float u_bright; uniform float u_shift; uniform float u_L; uniform float u_R; uniform float u_mid; uniform float u_kick; uniform float u_snare; uniform float u_hi;

float stars(vec2 sp) {
  vec2 g = sp * (u_res.y / 38.0);
  vec2 id = floor(g);
  vec2 h = hash22(id);
  float on = step(0.82, hash21(id + 3.1));
  float d = length((g - id - 0.2 - 0.6 * h) * 38.0);
  float tw = 0.55 + 0.45 * sin(u_t * (0.7 + 2.0 * h.y) + h.x * 30.0);
  return on * (aaFill(d - 0.7 * u_res.y / 720.0) + exp(-d / 4.0) * 0.15) * tw * (0.3 + 0.7 * h.x);
}

void main() {
  vec2 p = vec2(uv.x * u_aspect, uv.y);
  float lvl = mix(u_L, u_R, smoothstep(0.25, 0.75, uv.x));
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    if (float(i) >= u_bands) break;
    float fi = float(i);
    float k = fi / max(u_bands - 1.0, 1.0);
    float hv = hash11(fi + 3.0);
    float baseY = 0.1 + 0.42 * k + 0.05 * sin(fi * 2.7);
    float xs = p.x * u_scale;
    float ph = fi * 2.1;
    float wave = 0.085 * sin(xs * 1.4 + u_flow * 0.5 + ph) + 0.05 * sin(xs * 2.9 - u_flow * 0.7 + ph * 2.0) + 0.02 * sin(xs * 6.3 + u_flow * 1.3 + fi * 1.7)
               + 0.09 * (gnoise(vec2(xs * 0.7 + fi * 9.0, u_flow * 0.12)) - 0.5);
    float d = uv.y - (baseY + wave);
    float H = u_height * (0.03 + 0.07 * (0.3 + lvl + 0.5 * u_mid)) * (0.75 + 0.5 * hv);
    float inten;
    if (u_curtain > 0.5) {
      float prof = d >= 0.0 ? exp(-d / H) : exp(d * 48.0);
      float ray = gnoise(vec2(xs * 20.0 + fi * 5.0, u_flow * 0.35 + d * 1.5));
      ray = 0.3 + 1.0 * smoothstep(0.22, 0.8, ray);
      float fine = 0.75 + 0.25 * gnoise(vec2(xs * 70.0 + fi * 13.0, u_flow * 0.8));
      float edge = exp(-abs(d) * 110.0) * 0.3;
      inten = (prof * ray * fine + edge) * (0.55 + 0.9 * lvl);
    } else {
      float z = d / (H * 0.45);
      float amp = 0.55 + 0.7 * gnoise(vec2(xs * 0.9 + fi * 4.0, u_flow * 0.2));
      inten = exp(-z * z) * amp * (0.55 + 0.9 * lvl) + exp(-abs(d) * 160.0) * 0.12;
    }
    float up = clamp(d / max(H, 0.001), 0.0, 2.0);
    vec3 c = palAt(fi * 0.8 + up * 0.7, u_shift);
    acc += c * inten * (0.5 + 0.4 * hv);
  }
  // blue on the left edge, red on the right, scaled by each channel's level
  float eL = smoothstep(0.42, 0.0, uv.x), eR = smoothstep(0.58, 1.0, uv.x);
  vec3 tintCol = vec3(0.1, 0.35, 1.0) * eL * u_L + vec3(1.0, 0.18, 0.22) * eR * u_R;
  float accL = luma(acc);
  acc = acc * (1.0 - 0.45 * u_tint * (eL + eR)) + tintCol * u_tint * (0.25 + accL * 1.4);
  acc /= 1.0 + 0.7 * acc;
  vec3 sky = u_bg + palAt(2.0, u_shift) * 0.018 * smoothstep(0.7, 0.0, uv.y) + vec3(stars(p + vec2(u_t * 0.003, 0.0))) * (0.5 + 0.5 * u_hi) * smoothstep(0.1, 0.5, uv.y) * 0.9;
  vec3 col = sky + acc * u_bright * (1.0 + 0.35 * u_kick + 0.25 * u_snare);
  col *= 0.6 + 0.4 * smoothstep(1.3, 0.3, length((uv - 0.5) * vec2(u_aspect * 0.8, 1.1)));
  o = vec4(col * u_opacity, u_opacity);
}`);

registerLayer({
  type: "aurora",
  label: "Aurora",
  group: "background",
  icon: "sparkles",
  params: {
    ...commonParams({ brightness: 0.3 }),
    bands: { kind: "number", label: "Bands", min: 3, max: 8, default: 5, step: 1 },
    height: { kind: "number", label: "Height", min: 0.2, max: 2, default: 1 },
    tint: { kind: "number", label: "Left/right tint", min: 0, max: 1, default: 0.35 },
    style: { kind: "enum", label: "Style", options: ["curtains", "bands"], default: "curtains" },
    scale: { kind: "number", label: "Scale", min: 0.4, max: 3, default: 1 },
  },
  create(ctx) {
    return fullscreenLayer(ctx, FS, (p, f) => {
      const react = f.params.react as number;
      const d = drive(f, react);
      const sp = f.params.speed as number;
      const flow = f.motionSec * sp * 0.6 + cumSignal(f.signals, "mix.mid", f.tMs) * speedScale(f) * sp * react * 0.5;
      const base = 0.3;
      const L = Math.max(0, Math.min(1.2, base + d.level * (1 - 0.9 * d.balance)));
      const R = Math.max(0, Math.min(1.2, base + d.level * (1 + 0.9 * d.balance)));
      p.f1("u_bands", Math.round(f.params.bands as number))
        .f1("u_height", f.params.height as number)
        .f1("u_tint", f.params.tint as number)
        .f1("u_curtain", f.params.style === "bands" ? 0 : 1)
        .f1("u_scale", f.params.scale as number)
        .f1("u_flow", flow)
        .f1("u_bright", f.params.brightness as number)
        .f1("u_shift", f.params.colorShift as number)
        .f1("u_L", L)
        .f1("u_R", R)
        .f1("u_mid", d.mid)
        .f1("u_kick", d.kick)
        .f1("u_snare", d.snare)
        .f1("u_hi", d.hi);
    });
  },
});
