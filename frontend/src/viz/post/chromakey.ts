/**
 * Chroma key (Phase 21 §B4): a green or blue screen goes transparent. The
 * math is `keymath.ts` (the tested reference); this is its GLSL mirror.
 * Distance in the BT.709 CbCr plane plus 0.25 of the luma difference,
 * smoothstep alpha, spill clamp, one 3 × 3 erode/dilate pass for choke.
 * `amount` 0 is an exact identity; the output is premultiplied.
 */
import { paletteRef } from "../layers/registry";
import { hexToLinear } from "../palette";
import { simplePass } from "./pass";
import { registerPost } from "./registry";

const SRC = `
uniform float u_amount; uniform vec3 u_key; uniform float u_sim; uniform float u_smooth;
uniform float u_spill; uniform float u_choke; uniform int u_view;
vec3 enc(vec3 c) { return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2)); }
vec3 ycc(vec3 c) {
  vec3 e = enc(c);
  float y = dot(e, vec3(0.2126, 0.7152, 0.0722));
  return vec3(y, (e.b - y) / 1.8556, (e.r - y) / 1.5748);
}
float keyAlpha(vec3 s) {
  vec3 a = ycc(s); vec3 k = ycc(u_key);
  float d = length(vec3(a.y - k.y, a.z - k.z, 0.25 * (a.x - k.x)));
  return smoothstep(u_sim, u_sim + max(u_smooth, 1e-4), d);
}
vec3 straight(vec4 c) { return c.a > 1e-5 ? c.rgb / c.a : vec3(0.0); }
void main() {
  vec4 c = texture(u_src, uv);
  if (u_amount <= 0.0 || u_view == 2) { o = c; return; }
  vec3 s = straight(c);
  float k = keyAlpha(s);
  if (u_choke != 0.0) {
    vec2 t = 1.0 / u_res;
    float ext = k;
    for (int i = -1; i <= 1; i++) {
      for (int j = -1; j <= 1; j++) {
        if (i == 0 && j == 0) continue;
        vec4 n = texture(u_src, uv + vec2(float(i), float(j)) * t);
        float ka = keyAlpha(straight(n));
        ext = u_choke < 0.0 ? min(ext, ka) : max(ext, ka);
      }
    }
    k = mix(k, ext, min(1.0, abs(u_choke)));
  }
  float oa = c.a * k;
  int dom = (u_key.g >= u_key.r && u_key.g >= u_key.b) ? 1 : ((u_key.b > u_key.r && u_key.b > u_key.g) ? 2 : 0);
  vec3 clean = s;
  float o1 = dom == 0 ? s.g : (dom == 1 ? s.b : s.r);
  float o2 = dom == 0 ? s.b : (dom == 1 ? s.r : s.g);
  float dv = dom == 0 ? s.r : (dom == 1 ? s.g : s.b);
  float nv = mix(dv, min(dv, max(o1, o2)), clamp(u_spill, 0.0, 1.0));
  if (dom == 0) clean.r = nv; else if (dom == 1) clean.g = nv; else clean.b = nv;
  vec4 keyed = u_view == 1 ? vec4(vec3(oa), c.a) : vec4(clean * oa, oa);
  o = mix(c, keyed, clamp(u_amount, 0.0, 1.0));
}`;

registerPost({
  type: "chromakey",
  label: "Chroma key",
  kind: "pass",
  params: {
    color: { kind: "color", label: "Key colour", default: "#00b140" },
    similarity: { kind: "number", label: "Similarity", min: 0, max: 1, default: 0.18 },
    smoothness: { kind: "number", label: "Smoothness", min: 0, max: 1, default: 0.08 },
    spill: { kind: "number", label: "Spill removal", min: 0, max: 1, default: 0.5 },
    choke: { kind: "number", label: "Choke", min: -1, max: 1, default: 0 },
    view: { kind: "enum", label: "View", options: ["composite", "matte", "source"], default: "composite" },
    amount: { kind: "number", label: "Amount", min: 0, max: 1, default: 1 },
  },
  create(ctx) {
    return simplePass(ctx, SRC, (p, f) => {
      const view = f.params.view === "matte" ? 1 : f.params.view === "source" ? 2 : 0;
      p.f1("u_amount", f.params.amount as number)
        .f3("u_key", paletteRef(f.palette, f.params.color as string, hexToLinear))
        .f1("u_sim", f.params.similarity as number)
        .f1("u_smooth", f.params.smoothness as number)
        .f1("u_spill", f.params.spill as number)
        .f1("u_choke", f.params.choke as number)
        .i1("u_view", view);
    });
  },
});
