// GLSL for the WebGL2 backend. The maths mirrors dabmath.ts (dab alpha) and
// blend.ts (compositing); the CPU backend is the reference for both.

export const DAB_VS = `#version 300 es
precision highp float;
layout(location=0) in vec4 a0; // x y size angle
layout(location=1) in vec4 a1; // roundness alpha r g
layout(location=2) in vec4 a2; // b grainX grainY dualAngle
layout(location=3) in vec4 a3; // dualScale wet pullX pullY
uniform vec2 u_origin;
flat out vec4 f0;
flat out vec4 f1;
flat out vec4 f2;
flat out vec4 f3;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  float hw = a0.z * 0.5;
  float hh = max(hw * max(a1.x, 0.0001), 0.5);
  vec2 local = corner * (vec2(hw, hh) + 1.5);
  float c = cos(a0.w);
  float s = sin(a0.w);
  vec2 world = a0.xy + vec2(local.x * c - local.y * s, local.x * s + local.y * c);
  vec2 p = world - u_origin;
  gl_Position = vec4(p / 256.0 - 1.0, 0.0, 1.0);
  f0 = a0; f1 = a1; f2 = a2; f3 = a3;
}`;

export const DAB_FS = `#version 300 es
precision highp float;
flat in vec4 f0;
flat in vec4 f1;
flat in vec4 f2;
flat in vec4 f3;
uniform vec2 u_origin;
uniform sampler2D u_tip;
uniform sampler2D u_dual;
uniform sampler2D u_grain;
uniform sampler2D u_src;
uniform int u_tipShape;
uniform int u_dualShape;
uniform vec2 u_hard;
uniform ivec2 u_invert;
uniform int u_aa;
uniform int u_hasDual;
uniform int u_hasGrain;
uniform int u_texturised;
uniform int u_hasSrc;
uniform int u_coverageOnly;
uniform int u_rendering;
uniform float u_dualRound;
uniform float u_grainScale;
uniform float u_grainDepth;
uniform float u_grainContrast;
uniform vec2 u_grainTex;
out vec4 outColor;

// px = the size of one pixel in the tip's normalised coordinates (1/hw, 1/hh): an
// edge is smoothed over one pixel on every side, however thin the tip is.
float analytic(int shape, vec2 n, float hard, vec2 px) {
  float d;
  float g;
  if (shape == 1) {
    vec2 a = abs(n);
    d = max(a.x, a.y);
    g = a.x > a.y ? px.x : px.y;
  } else {
    d = length(n);
    g = length(n * px) / max(d, 0.0001);
  }
  if (u_aa == 0) return d <= 1.0 ? 1.0 : 0.0;
  float w = max(1.0 - hard, g);
  float t = clamp((1.0 - d) / w, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

float tipCov(int shape, sampler2D tex, vec2 n, float hard, int inv, vec2 aaw) {
  if (shape == 2) {
    if (abs(n.x) > 1.0 || abs(n.y) > 1.0) return 0.0;
    float c = textureLod(tex, n * 0.5 + 0.5, 0.0).r;
    return inv == 1 ? 1.0 - c : c;
  }
  float c = analytic(shape, n, hard, aaw);
  return inv == 1 ? 1.0 - c : c;
}

void main() {
  float hw = f0.z * 0.5;
  float hh = max(hw * max(f1.x, 0.0001), 0.5);
  float c = cos(f0.w);
  float s = sin(f0.w);
  vec2 wp = u_origin + gl_FragCoord.xy;
  vec2 fp = wp - f0.xy;
  vec2 l = vec2(fp.x * c + fp.y * s, -fp.x * s + fp.y * c);
  vec2 aaw = vec2(1.0 / hw, 1.0 / hh);
  float cov = tipCov(u_tipShape, u_tip, vec2(l.x / hw, l.y / hh), u_hard.x, u_invert.x, aaw);
  if (u_hasDual == 1) {
    float dc = cos(f2.w);
    float ds = sin(f2.w);
    vec2 e = vec2(l.x * dc + l.y * ds, -l.x * ds + l.y * dc);
    float dr = max(u_dualRound, 0.0001);
    cov *= tipCov(u_dualShape, u_dual, vec2(e.x / (hw * f3.x), e.y / (hw * f3.x * dr)), u_hard.y, u_invert.y, vec2(1.0 / hw) / vec2(f3.x, f3.x * dr));
  }
  float a = cov * f1.y;
  if (u_hasGrain == 1) {
    vec2 gp = u_texturised == 1 ? wp : l + f2.yz;
    float g = textureLod(u_grain, gp / (u_grainTex * u_grainScale), 0.0).r;
    float g2 = clamp((g - 0.5) * u_grainContrast + 0.5, 0.0, 1.0);
    a *= 1.0 - u_grainDepth * (1.0 - g2);
  }
  a = clamp(a, 0.0, 1.0);
  if (u_rendering == 2) a = 1.0 - (1.0 - a) * (1.0 - a);
  if (a <= 0.0) discard;
  vec3 col = vec3(f1.z, f1.w, f2.x);
  if (u_coverageOnly == 1) {
    col = vec3(0.0);
  } else if (u_hasSrc == 1 && f3.y > 0.0) {
    ivec2 sp = clamp(ivec2(floor(gl_FragCoord.xy + f3.zw)), ivec2(0), ivec2(511));
    vec4 sc = texelFetch(u_src, sp, 0);
    if (sc.a > 0.0) col = mix(col, sc.rgb / sc.a, f3.y * sc.a);
  }
  outColor = vec4(col * a, a);
}`;

export const FULL_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const BLEND_FS = `#version 300 es
precision highp float;
uniform sampler2D u_dst;
uniform sampler2D u_src;
uniform sampler2D u_sel;
uniform sampler2D u_ref;
uniform int u_mode;
uniform int u_op;      // 0 over, 1 atop, 2 erase, 3 revert
uniform int u_merge;   // 1: u_src is a stroke scratch (straight colour, edges, impasto, selection)
uniform float u_opacity;
uniform float u_wetEdges;
uniform float u_impasto;
uniform int u_hasSel;
uniform int u_hasRef;
out vec4 o;

float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / (l - n);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / (x - l);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  if (mx > mn) return (c - mn) * s / (mx - mn);
  return vec3(0.0);
}
float hardLight1(float cb, float cs) { return cs <= 0.5 ? cb * 2.0 * cs : cb + (2.0 * cs - 1.0) - cb * (2.0 * cs - 1.0); }
float softLight1(float cb, float cs) {
  if (cs <= 0.5) return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb);
  float d = cb <= 0.25 ? ((16.0 * cb - 12.0) * cb + 4.0) * cb : sqrt(cb);
  return cb + (2.0 * cs - 1.0) * (d - cb);
}
float sep(int m, float cb, float cs) {
  if (m == 1) return cb * cs;
  if (m == 2) return cb + cs - cb * cs;
  if (m == 3) return hardLight1(cs, cb);
  if (m == 4) return min(1.0, cb + cs);
  if (m == 5) return min(cb, cs);
  if (m == 6) return max(cb, cs);
  if (m == 7) return cb == 0.0 ? 0.0 : (cs >= 1.0 ? 1.0 : min(1.0, cb / (1.0 - cs)));
  if (m == 8) return cb >= 1.0 ? 1.0 : (cs <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - cb) / cs));
  if (m == 9) return softLight1(cb, cs);
  if (m == 10) return hardLight1(cb, cs);
  if (m == 11) return abs(cb - cs);
  return cs;
}
vec3 blendRGB(int m, vec3 cb, vec3 cs) {
  if (m < 12) return vec3(sep(m, cb.r, cs.r), sep(m, cb.g, cs.g), sep(m, cb.b, cs.b));
  if (m == 12) return setLum(setSat(cs, sat(cb)), lum(cb));
  if (m == 13) return setLum(setSat(cb, sat(cs)), lum(cb));
  if (m == 14) return setLum(cs, lum(cb));
  return setLum(cb, lum(cs));
}
vec4 comp(vec4 dst, vec4 sp, int mode, bool atop) {
  float sa = sp.a;
  if (sa <= 0.0) return dst;
  float da = dst.a;
  if (mode == 0 && !atop) return sp + dst * (1.0 - sa);
  vec3 cs = sp.rgb / sa;
  if (da <= 0.0) return atop ? dst : sp;
  vec3 cb = dst.rgb / da;
  vec3 bl = blendRGB(mode, cb, cs);
  float ao = atop ? da : sa + da * (1.0 - sa);
  float k0 = atop ? 0.0 : sa * (1.0 - da);
  float k1 = sa * da;
  float k2 = (1.0 - sa) * da;
  return vec4(k0 * cs + k1 * bl + k2 * cb, ao);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 dst = texelFetch(u_dst, p, 0);
  vec4 sc = texelFetch(u_src, p, 0);
  if (u_merge == 0) {
    float o2 = u_opacity;
    o = comp(dst, vec4(sc.rgb * o2, sc.a * o2), u_mode, u_op == 1);
    return;
  }
  float a = sc.a;
  if (a <= 0.0) { o = dst; return; }
  float selA = 1.0;
  if (u_hasSel == 1) {
    selA = texelFetch(u_sel, p, 0).a;
    if (selA <= 0.0) { o = dst; return; }
  }
  vec3 c = sc.rgb / a;
  if (u_wetEdges > 0.0) a = clamp(a * (1.0 - 0.4 * u_wetEdges) + u_wetEdges * 1.6 * a * (1.0 - a), 0.0, 1.0);
  if (u_impasto > 0.0) {
    int xl = p.x > 0 ? p.x - 1 : p.x;
    int xr = p.x < 511 ? p.x + 1 : p.x;
    int yu = p.y > 0 ? p.y - 1 : p.y;
    int yd = p.y < 511 ? p.y + 1 : p.y;
    float gx = (texelFetch(u_src, ivec2(xr, p.y), 0).a - texelFetch(u_src, ivec2(xl, p.y), 0).a) / float(max(1, xr - xl));
    float gy = (texelFetch(u_src, ivec2(p.x, yd), 0).a - texelFetch(u_src, ivec2(p.x, yu), 0).a) / float(max(1, yd - yu));
    float shade = (gx * -0.5 + gy * -0.5) * 6.0 * u_impasto;
    c = clamp(c + shade, 0.0, 1.0);
  }
  float eff = a * u_opacity * selA;
  if (eff <= 0.0) { o = dst; return; }
  if (u_op == 2) { o = dst * (1.0 - eff); return; }
  if (u_op == 3) {
    vec4 r = u_hasRef == 1 ? texelFetch(u_ref, p, 0) : vec4(0.0);
    o = dst + (r - dst) * eff;
    return;
  }
  o = comp(dst, vec4(c * eff, eff), u_mode, u_op == 1);
}`;

export const PRESENT_VS = `#version 300 es
precision highp float;
uniform vec2 u_doc;
uniform vec2 u_css;
uniform vec3 u_m0; // a c e
uniform vec3 u_m1; // b d f
out vec2 v_canvas;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 cp = corner * u_doc;
  vec2 s = vec2(u_m0.x * cp.x + u_m0.y * cp.y + u_m0.z, u_m1.x * cp.x + u_m1.y * cp.y + u_m1.z);
  gl_Position = vec4(s.x / u_css.x * 2.0 - 1.0, 1.0 - s.y / u_css.y * 2.0, 0.0, 1.0);
  v_canvas = cp;
}`;

export const PRESENT_FS = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_doc;
uniform int u_checker;
uniform float u_cell;
in vec2 v_canvas;
out vec4 o;
void main() {
  if (u_checker == 1) {
    vec2 q = floor(v_canvas / u_cell);
    float v = mod(q.x + q.y, 2.0) < 1.0 ? 0.86 : 0.74;
    o = vec4(vec3(v), 1.0);
    return;
  }
  o = textureLod(u_tex, v_canvas / u_doc, 0.0);
}`;
