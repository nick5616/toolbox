/**
 * GLSL of the Edit Studio compositor (Phase 9 SPEC §8.5). Everything works in
 * linear light with premultiplied alpha, like the rest of the engine: video
 * and photos are uploaded as sRGB8_ALPHA8 (sampled linear), colours come from
 * hexToLinear, and the output pass converts back to sRGB.
 *
 * Coordinates: "box px" are pixels of the clip's drawn rect with the origin at
 * its top-left, y down. Textures are uploaded top row first (no flip), so a
 * source texture's v is also y down; render targets have uv.y up.
 */

const PRECISION = `#version 300 es
precision highp float;
precision highp int;
in vec2 uv; out vec4 o;
`;

/** Mask coverage over box px (≤ 4 masks; paths are polygons of ≤ 32 points each in u_pts). */
export const GLSL_MASKS = `
uniform int u_mcount;
uniform vec4 u_mA[4]; // centre px (xy), half size px (zw)
uniform vec4 u_mB[4]; // rotation rad, feather px, invert, op (0 add, 1 subtract, 2 intersect)
uniform vec4 u_mC[4]; // shape (0 rect, 1 ellipse, 2 path), first point, point count
uniform vec2 u_pts[128];
vec2 rot2(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
float pathSD(vec2 p, int off, int n) {
  float d = 1e9;
  float s = 1.0;
  for (int i = 0; i < 32; i++) {
    if (i >= n) break;
    vec2 a = u_pts[off + i];
    vec2 b = u_pts[off + (i + 1 < n ? i + 1 : 0)];
    vec2 e = b - a;
    vec2 w = p - a;
    vec2 q = w - e * clamp(dot(w, e) / max(dot(e, e), 1e-6), 0.0, 1.0);
    d = min(d, dot(q, q));
    bool c1 = p.y >= a.y, c2 = p.y < b.y, c3 = e.x * w.y > e.y * w.x;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * sqrt(d);
}
float maskAlpha(vec2 p) {
  if (u_mcount == 0) return 1.0;
  float acc = u_mB[0].w < 0.5 ? 0.0 : 1.0;
  for (int i = 0; i < 4; i++) {
    if (i >= u_mcount) break;
    vec4 A = u_mA[i], B = u_mB[i], C = u_mC[i];
    float d;
    if (C.x < 0.5) {
      vec2 q = abs(rot2(p - A.xy, -B.x)) - A.zw;
      d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    } else if (C.x < 1.5) {
      vec2 q = rot2(p - A.xy, -B.x);
      vec2 h = max(A.zw, vec2(0.5));
      d = (length(q / h) - 1.0) * min(h.x, h.y);
    } else {
      d = pathSD(p, int(C.y), int(C.z));
    }
    float m = clamp(0.5 - d / max(B.y, 1.0), 0.0, 1.0);
    if (B.z > 0.5) m = 1.0 - m;
    if (B.w < 0.5) acc = acc + m - acc * m;
    else if (B.w < 1.5) acc = acc * (1.0 - m);
    else acc = acc * m;
  }
  return acc;
}
`;

/** Draws one source (or a colour) into a clip target: fit, transform, flip, matte, stroke/glow, masks, opacity. */
export const CLIP_FS = `${PRECISION}
uniform sampler2D u_src; uniform sampler2D u_src2;
uniform sampler2D u_matte; uniform sampler2D u_matte2;
uniform sampler2D u_bg;
uniform vec2 u_frame;     // output size px
uniform vec2 u_box;       // drawn rect px
uniform vec2 u_img;       // image rect px inside the box
uniform vec2 u_off;       // offset px (x right, y down)
uniform float u_scale; uniform float u_rot; uniform float u_opacity; uniform float u_flip;
uniform int u_kind;       // 0 sampled image, 1 colour
uniform vec3 u_color;
uniform int u_fit;        // 0 none, 1 transparent bars, 2 colour bars, 3 blurred bars
uniform vec3 u_fitColor;
uniform float u_blend;    // weight of u_src2
uniform int u_hasMatte; uniform float u_mblend; uniform float u_minv; uniform float u_cutout;
uniform vec2 u_featherUV; uniform vec2 u_strokeUV; uniform vec2 u_glowUV;
uniform float u_strokeOn; uniform vec3 u_strokeColor; uniform float u_glowAmt; uniform vec3 u_glowColor;
uniform int u_part;       // 0 whole, 1 subject only, 2 background only
uniform float u_decor;    // stroke and glow wanted
uniform int u_gen;        // 1: the source is a generated target (premultiplied, bottom-up)
uniform int u_edges;      // 1: mirror the picture past its edges (motion tile)
${GLSL_MASKS}
vec2 mirrorUV(vec2 t) { return 1.0 - abs(mod(t, 2.0) - 1.0); }
float edgeAA(vec2 pos, vec2 size) { vec2 m = min(pos, size - pos); return clamp(min(m.x, m.y) * u_scale + 0.5, 0.0, 1.0); }
float subj(vec2 st) {
  float m = mix(texture(u_matte, st).r, texture(u_matte2, st).r, u_mblend);
  return u_minv > 0.5 ? 1.0 - m : m;
}
vec2 dir(int i, int n) { float a = 6.2831853 * float(i) / float(n); return vec2(cos(a), sin(a)); }
float feathered(vec2 st) {
  float s = subj(st);
  if (u_featherUV.x <= 0.0) return s;
  for (int i = 0; i < 8; i++) s += subj(st + dir(i, 8) * u_featherUV);
  return s / 9.0;
}
void main() {
  vec2 p = vec2(uv.x * u_frame.x, (1.0 - uv.y) * u_frame.y);
  vec2 d = p - u_frame * 0.5 - u_off;
  float cs = cos(u_rot), sn = sin(u_rot);
  d = vec2(cs * d.x + sn * d.y, -sn * d.x + cs * d.y) / u_scale;
  vec2 rb = d + u_box * 0.5;
  float inBox = u_edges == 1 ? 1.0 : edgeAA(rb, u_box);
  vec4 col = vec4(0.0);
  if (u_kind == 1) {
    col = vec4(u_color, 1.0) * inBox;
    col *= maskAlpha(rb) * u_opacity;
    o = col;
    return;
  }
  vec2 ri = d / u_img + 0.5;
  float inImg = u_edges == 1 ? 1.0 : edgeAA(ri * u_img, u_img);
  if (u_edges == 1) ri = mirrorUV(ri);
  vec2 st = vec2(u_flip > 0.5 ? 1.0 - ri.x : ri.x, u_gen == 1 ? 1.0 - ri.y : ri.y);
  vec4 s = mix(texture(u_src, st), texture(u_src2, st), u_blend);
  if (u_gen == 0) s.rgb *= s.a;
  vec4 img = s * inImg;
  float a = 1.0;
  if (u_hasMatte == 1) a = feathered(st);
  vec4 bars = vec4(0.0);
  if (u_cutout < 0.5) {
    if (u_fit == 2) bars = vec4(u_fitColor, 1.0) * inBox;
    else if (u_fit == 3) bars = texture(u_bg, vec2(rb.x / u_box.x, 1.0 - rb.y / u_box.y)) * inBox;
  }
  float A = a * img.a;
  vec4 subject = img * a;
  vec4 back = u_cutout > 0.5 ? vec4(0.0) : img * (1.0 - a) + bars * (1.0 - img.a);
  vec4 decor = vec4(0.0);
  if (u_decor > 0.5 && u_hasMatte == 1) {
    vec4 S = vec4(0.0);
    if (u_strokeOn > 0.5) {
      float dil = 0.0;
      for (int i = 0; i < 16; i++) dil = max(dil, subj(st + dir(i, 16) * u_strokeUV));
      S = vec4(u_strokeColor, 1.0) * clamp(dil - a, 0.0, 1.0);
    }
    vec4 G = vec4(0.0);
    if (u_glowAmt > 0.0) {
      float g = 0.0;
      for (int i = 0; i < 8; i++) {
        vec2 dv = dir(i, 8);
        g += subj(st + dv * u_glowUV) + subj(st + dv * u_glowUV * 0.66) + subj(st + dv * u_glowUV * 0.33);
      }
      G = vec4(u_glowColor, 1.0) * clamp(g / 24.0 * 1.5, 0.0, 1.0) * u_glowAmt;
    }
    decor = (S + (1.0 - S.a) * G) * (1.0 - A);
  }
  vec4 under = decor + (1.0 - decor.a) * back;
  if (u_part == 1) col = subject + decor;
  else if (u_part == 2) col = back;
  else col = subject + under;
  col *= maskAlpha(rb) * u_opacity;
  o = col;
}`;

/** The cover-scaled copy of a frame under a fit-blur clip (drawn at half size, then blurred). */
export const FITBG_FS = `${PRECISION}
uniform sampler2D u_src; uniform sampler2D u_src2; uniform float u_blend; uniform float u_flip;
uniform vec2 u_frame; uniform vec2 u_cover;
void main() {
  vec2 p = vec2(uv.x * u_frame.x, (1.0 - uv.y) * u_frame.y);
  vec2 ri = (p - u_frame * 0.5) / u_cover + 0.5;
  vec2 st = vec2(u_flip > 0.5 ? 1.0 - ri.x : ri.x, ri.y);
  vec4 s = mix(texture(u_src, st), texture(u_src2, st), u_blend);
  o = vec4(s.rgb * s.a, s.a);
}`;

/** Separable gaussian (9 taps) over a premultiplied target. */
export const BLUR_FS = `${PRECISION}
uniform sampler2D u_src; uniform vec2 u_step;
void main() {
  vec4 c = texture(u_src, uv) * 0.2270270270;
  c += (texture(u_src, uv + u_step * 1.3846153846) + texture(u_src, uv - u_step * 1.3846153846)) * 0.3162162162;
  c += (texture(u_src, uv + u_step * 3.2307692308) + texture(u_src, uv - u_step * 3.2307692308)) * 0.0702702703;
  o = c;
}`;

/** Copy (blend state decides how it lands). */
export const BLIT_FS = `${PRECISION}
uniform sampler2D u_src;
void main() { o = texture(u_src, uv); }`;

/** Adjustment clips: mix the processed frame over the original by amount × mask (frame-sized box). */
export const MIX_FS = `${PRECISION}
uniform sampler2D u_a; uniform sampler2D u_b; uniform float u_amount; uniform vec2 u_frame;
${GLSL_MASKS}
void main() {
  vec2 p = vec2(uv.x * u_frame.x, (1.0 - uv.y) * u_frame.y);
  o = mix(texture(u_a, uv), texture(u_b, uv), clamp(u_amount * maskAlpha(p), 0.0, 1.0));
}`;

/** Bloom prefilter, down and up: as gl/output.ts (the edit output pass has its own final stage without tone mapping). */
export const BLOOM_PRE_FS = `${PRECISION}
uniform sampler2D u_src; uniform vec2 u_texel; uniform float u_threshold; uniform float u_knee;
void main() {
  vec3 c = vec3(0.0);
  c += texture(u_src, uv + u_texel * vec2(-1.0, -1.0)).rgb;
  c += texture(u_src, uv + u_texel * vec2(1.0, -1.0)).rgb;
  c += texture(u_src, uv + u_texel * vec2(-1.0, 1.0)).rgb;
  c += texture(u_src, uv + u_texel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - u_threshold + u_knee, 0.0, 2.0 * u_knee);
  soft = soft * soft / (4.0 * u_knee + 1e-4);
  float contrib = max(soft, br - u_threshold) / max(br, 1e-4);
  o = vec4(c * contrib, 1.0);
}`;

export const BLOOM_DOWN_FS = `${PRECISION}
uniform sampler2D u_src; uniform vec2 u_texel;
void main() {
  vec3 c = texture(u_src, uv).rgb * 4.0;
  c += texture(u_src, uv + u_texel * vec2(-1.0, -1.0)).rgb;
  c += texture(u_src, uv + u_texel * vec2(1.0, -1.0)).rgb;
  c += texture(u_src, uv + u_texel * vec2(-1.0, 1.0)).rgb;
  c += texture(u_src, uv + u_texel * vec2(1.0, 1.0)).rgb;
  o = vec4(c / 8.0, 1.0);
}`;

export const BLOOM_UP_FS = `${PRECISION}
uniform sampler2D u_src; uniform vec2 u_texel;
void main() {
  vec3 c = vec3(0.0);
  c += texture(u_src, uv + u_texel * vec2(-2.0, 0.0)).rgb;
  c += texture(u_src, uv + u_texel * vec2(2.0, 0.0)).rgb;
  c += texture(u_src, uv + u_texel * vec2(0.0, -2.0)).rgb;
  c += texture(u_src, uv + u_texel * vec2(0.0, 2.0)).rgb;
  c += texture(u_src, uv + u_texel * vec2(-1.0, -1.0)).rgb * 2.0;
  c += texture(u_src, uv + u_texel * vec2(1.0, -1.0)).rgb * 2.0;
  c += texture(u_src, uv + u_texel * vec2(-1.0, 1.0)).rgb * 2.0;
  c += texture(u_src, uv + u_texel * vec2(1.0, 1.0)).rgb * 2.0;
  o = vec4(c / 12.0, 1.0);
}`;

/**
 * The edit's final pass: bloom, vignette and grain over the linear frame, then
 * sRGB and a dither. No tone mapping (the Visualizer's ACES curve would dim
 * video: white 1.0 maps to 0.80), so an edit with an empty Look is a straight
 * linear → sRGB round trip.
 */
export const EDIT_FINAL_FS = `${PRECISION}
uniform sampler2D u_scene; uniform sampler2D u_bloom;
uniform float u_bloomAmt; uniform float u_vignette; uniform float u_grain; uniform float u_time; uniform vec2 u_size;
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec3 hdr = texture(u_scene, uv).rgb + texture(u_bloom, uv).rgb * u_bloomAmt;
  vec2 q = uv - 0.5;
  hdr *= mix(1.0, smoothstep(0.85, 0.2, length(q * vec2(u_size.x / u_size.y, 1.0)) * 0.9), u_vignette);
  float n = ign(gl_FragCoord.xy + fract(u_time * 7.13) * 97.0);
  vec3 c = clamp(hdr + (n - 0.5) * u_grain * 0.08, 0.0, 1.0);
  c = toSrgb(c);
  c += (n - 0.5) / 255.0;
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

/**
 * Part B: blend modes GL's blend equations can't do. Premultiplied source over
 * premultiplied destination (W3C compositing: separable modes on unpremultiplied
 * colours clamped to 0..1, then source-over).
 * u_mode: 0 overlay, 1 softlight, 2 hardlight, 3 difference, 4 exclusion, 5 lighten, 6 darken, 7 colordodge.
 */
export const BLEND_FS = `${PRECISION}
uniform sampler2D u_src; uniform sampler2D u_dst; uniform int u_mode;
vec3 hardlight(vec3 b, vec3 s) { return mix(b * 2.0 * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, s)); }
vec3 softlight(vec3 b, vec3 s) {
  vec3 d = mix(sqrt(b), ((16.0 * b - 12.0) * b + 4.0) * b, step(b, vec3(0.25)));
  return mix(b - (1.0 - 2.0 * s) * b * (1.0 - b), b + (2.0 * s - 1.0) * (d - b), step(0.5, s));
}
vec3 blendOf(vec3 b, vec3 s) {
  if (u_mode == 0) return hardlight(s, b);
  if (u_mode == 1) return softlight(b, s);
  if (u_mode == 2) return hardlight(b, s);
  if (u_mode == 3) return abs(b - s);
  if (u_mode == 4) return b + s - 2.0 * b * s;
  if (u_mode == 5) return max(b, s);
  if (u_mode == 6) return min(b, s);
  return min(vec3(1.0), b / max(vec3(1e-4), 1.0 - s));
}
void main() {
  vec4 S = texture(u_src, uv);
  vec4 D = texture(u_dst, uv);
  vec3 cs = S.a > 1e-5 ? clamp(S.rgb / S.a, 0.0, 1.0) : vec3(0.0);
  vec3 cb = D.a > 1e-5 ? clamp(D.rgb / D.a, 0.0, 1.0) : vec3(0.0);
  vec3 rgb = (1.0 - S.a) * D.rgb + (1.0 - D.a) * S.rgb + S.a * D.a * blendOf(cb, cs);
  o = vec4(rgb, S.a + D.a - S.a * D.a);
}`;

/**
 * Part B: a track matte. Keeps u_src where the matte (premultiplied) is
 * opaque (alpha) or bright (luma, Rec. 709 of the premultiplied colour).
 * u_mode: 0 alpha, 1 alpha inverted, 2 luma, 3 luma inverted.
 */
export const TRACKMATTE_FS = `${PRECISION}
uniform sampler2D u_src; uniform sampler2D u_matte; uniform int u_mode;
void main() {
  vec4 m = texture(u_matte, uv);
  float a = m.a;
  if (u_mode >= 2) a = clamp(dot(m.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  if (u_mode == 1 || u_mode == 3) a = 1.0 - a;
  o = texture(u_src, uv) * a;
}`;
