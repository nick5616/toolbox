/** VHS (FX2): scanlines, chroma bleed, line wobble and noise. Time-varying looks come from tMs and the seed. */
import { simplePass } from "./pass";
import { vhsBucket } from "./fx2math";
import { registerPost } from "./registry";

const SRC = `
uniform float u_amt; uniform float u_scan; uniform float u_bleed; uniform float u_wob; uniform float u_noise;
uniform float u_t; uniform float u_seed; uniform float u_bucket; uniform float u_period;
void main() {
  if (u_amt <= 0.0) { o = texture(u_src, uv); return; }
  float row = floor(uv.y * u_res.y);
  float jitter = hash21(vec2(row, u_bucket + u_seed * 3.1));
  float band = vnoise(vec2(uv.y * 6.0, u_t * 0.0015 + u_seed));
  float off = ((band - 0.5) * 2.0 * u_wob * 0.012 + (jitter - 0.5) * u_wob * 0.002) * u_amt;
  vec2 p = vec2(uv.x + off, uv.y);
  vec4 c = texture(u_src, p);
  float bl = u_bleed * u_amt * 0.012;
  vec4 sm = vec4(0.0);
  for (int i = 0; i < 6; i++) sm += texture(u_src, vec2(p.x - bl * float(i) / 5.0, p.y));
  sm /= 6.0;
  vec3 rgb = max(vec3(luma(c.rgb)) + (sm.rgb - vec3(luma(sm.rgb))), 0.0);
  rgb *= 1.0 - u_scan * u_amt * 0.3 * (0.5 + 0.5 * cos(6.2831853 * row / u_period));
  float n = hash21(gl_FragCoord.xy + vec2(u_bucket * 17.0, u_seed)) - 0.5;
  rgb += n * u_noise * u_amt * 0.15 * c.a;
  o = vec4(max(rgb, 0.0), c.a);
}`;

registerPost({
  type: "vhs",
  label: "VHS",
  kind: "pass",
  params: {
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 0 },
    scanlines: { kind: "number", label: "Scanlines", min: 0, max: 1, default: 0.5 },
    bleed: { kind: "number", label: "Colour bleed", min: 0, max: 1, default: 0.5 },
    wobble: { kind: "number", label: "Wobble", min: 0, max: 1, default: 0.3 },
    noise: { kind: "number", label: "Noise", min: 0, max: 1, default: 0.3 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f, _w, h) => {
      p.f1("u_amt", f.params.amount as number)
        .f1("u_scan", f.params.scanlines as number)
        .f1("u_bleed", f.params.bleed as number)
        .f1("u_wob", f.params.wobble as number)
        .f1("u_noise", f.params.noise as number)
        .f1("u_t", f.tMs)
        .f1("u_seed", f.seed % 1024)
        .f1("u_bucket", vhsBucket(f.tMs))
        .f1("u_period", Math.max(2, h / 240));
    });
  },
});
