/**
 * Word-quad shader (SPEC.md §6.8). One instanced quad per word, sampling the
 * glyph atlas (R fill, G outline, B glow mask) and shading it per instance.
 *
 * Per-instance attributes (all vec4):
 *   a_rect  cx, cy, halfW, halfH          quad in output px (y down)
 *   a_uv    u0, v0, u1, v1                the word's cell in the atlas page
 *   a_c0    fill rgb (linear), opacity
 *   a_c1    highlight rgb, karaoke progress (< 0: none)
 *   a_c2    outline rgb, outline opacity
 *   a_p     reveal (glyph-box fraction, ≥ 1: all), glow gain, unused, glyph box left (cell fraction)
 *   a_q     glyph box right (cell fraction), karaoke edge softness, hot (brightness gain), unused
 */
export const WORD_STRIDE_FLOATS = 28;

export const WORD_VS = `#version 300 es
in vec2 a_corner;
in vec4 a_rect;
in vec4 a_uv;
in vec4 a_c0;
in vec4 a_c1;
in vec4 a_c2;
in vec4 a_p;
in vec4 a_q;
uniform vec2 u_res;
out vec2 v_uv;
out float v_x;
out vec4 v_c0;
out vec4 v_c1;
out vec4 v_c2;
out vec4 v_p;
out vec4 v_q;
void main() {
  vec2 world = a_rect.xy + a_corner * a_rect.zw;
  vec2 t = a_corner * 0.5 + 0.5;
  v_uv = mix(a_uv.xy, a_uv.zw, t);
  v_x = t.x;
  v_c0 = a_c0; v_c1 = a_c1; v_c2 = a_c2; v_p = a_p; v_q = a_q;
  vec2 clip = world / u_res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

export const WORD_FS = `#version 300 es
precision highp float;
uniform sampler2D u_atlas;
in vec2 v_uv;
in float v_x;
in vec4 v_c0;
in vec4 v_c1;
in vec4 v_c2;
in vec4 v_p;
in vec4 v_q;
out vec4 o;
void main() {
  vec3 m = texture(u_atlas, v_uv).rgb;
  float gw = max(v_q.x - v_p.w, 1e-4);
  float fx = (v_x - v_p.w) / gw;
  float vis = v_p.x >= 1.0 ? 1.0 : 1.0 - smoothstep(v_p.x - 0.012, v_p.x, fx);
  vec3 col = v_c0.rgb;
  float band = 0.0;
  float prog = v_c1.w;
  if (prog >= 0.0) {
    float edge = max(v_q.y, 1e-3);
    float pp = prog * (1.0 + edge);
    float km = 1.0 - smoothstep(pp - edge, pp, fx);
    col = mix(v_c0.rgb, v_c1.rgb, km);
    if (prog > 0.0 && prog < 1.0) {
      float d = (fx - (pp - edge * 0.5)) / (edge * 0.9);
      band = exp(-d * d);
    }
  }
  col *= 1.0 + v_q.z;
  col += col * band * 0.9;
  float fill = m.r * vis;
  float stroke = m.g * vis * v_c2.w;
  vec3 rgb = col * fill + v_c2.rgb * stroke * (1.0 - fill);
  float a = fill + stroke * (1.0 - fill);
  // glow is light only (alpha 0): added into the HDR target for the bloom to pick up
  vec3 glow = col * (m.b * v_p.y * (1.0 - fill) * vis);
  o = vec4((rgb + glow) * v_c0.a, a * v_c0.a);
}`;
