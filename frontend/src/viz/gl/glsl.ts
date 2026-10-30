/** Shared GLSL chunks for layers and passes (prepend to a fragment shader). */

/** Hashes, value noise, fBm, and a little colour/SDF toolkit. */
export const GLSL_COMMON = `
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p, int oct) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 8; i++) { if (i >= oct) break; v += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float sdCircle(vec2 p, float r) { return length(p) - r; }
float sdRoundBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float sdSegment(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
/** Anti-aliased fill from a signed distance in pixels. */
float aaFill(float d) { return clamp(0.5 - d, 0.0, 1.0); }
/** A soft glow falloff outside a shape (d in pixels, radius in pixels). */
float glowFalloff(float d, float radius) { return radius <= 0.0 ? 0.0 : exp(-max(d, 0.0) / radius) * (1.0 - aaFill(d)); }
`;

/** The resolved palette as uniforms (linear RGB). Set with setPaletteUniforms. */
export const GLSL_PALETTE = `
uniform vec3 u_bg;
uniform vec3 u_c0;
uniform vec3 u_c1;
uniform vec3 u_c2;
uniform vec3 u_c3;
uniform vec3 u_accent;
uniform vec3 u_glow;
vec3 paletteColor(float i) {
  float k = mod(i, 4.0);
  return k < 1.0 ? mix(u_c0, u_c1, k) : k < 2.0 ? mix(u_c1, u_c2, k - 1.0) : k < 3.0 ? mix(u_c2, u_c3, k - 2.0) : mix(u_c3, u_c0, k - 3.0);
}
`;
