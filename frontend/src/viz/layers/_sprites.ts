/**
 * The generated sprite atlas (SPEC.md §6.5), done in the fragment shader so it
 * needs no DOM, no canvas and no texture upload: it works unchanged in the
 * export worker. One instanced quad = one sprite; `extra.y` selects the shape.
 *
 * Per-sprite floats (QuadBatch extra): x = rotation, y = kind, z = aux
 * (softness / thickness), w = hotness (ember core, petal gloss).
 *
 * The halo uniform `u_glow` is a factor of the sprite size.
 */

export const Sprite = {
  /** Soft disc (dust, motes, snow bokeh). aux = edge softness 0..1. */
  disc: 0,
  /** Ember: gaussian blob with a white-hot core. hot = core strength. */
  ember: 1,
  /** Six-armed snowflake (soft disc when tiny). */
  snowflake: 2,
  /** Streak tapering to a bright head at +x (rain, sparks, headlights). Half height is the radius. */
  streak: 3,
  /** Petal, base at -x, tip at +x. hot = gloss. */
  petal: 4,
  /** Four-point sparkle star. */
  star: 5,
  /** Heart. aux = edge softness 0..1 (blurred hearts are bokeh). */
  heart: 6,
  /** Bokeh disc with a brighter rim. aux = softness. */
  bokeh: 7,
  /** Squashed ring (splashes, ripples seen at an angle). aux = thickness fraction of the radius. */
  ring: 8,
  /** Glowing line segment along x (lightning). Half height is the core radius. */
  bolt: 9,
} as const;
export type SpriteKind = (typeof Sprite)[keyof typeof Sprite];

/** A QuadBatch fragment body: `shade` for every sprite kind. */
export const SHADE_SPRITES = `
uniform float u_glow;
float sdHeart(vec2 p) {
  p.x = abs(p.x);
  if (p.y + p.x > 1.0) { vec2 q = p - vec2(0.25, 0.75); return sqrt(dot(q, q)) - 0.35355339; }
  vec2 a = p - vec2(0.0, 1.0);
  vec2 b = p - 0.5 * max(p.x + p.y, 0.0);
  return sqrt(min(dot(a, a), dot(b, b))) * sign(p.x - p.y);
}
float halo(float d, float radius, float k) { return radius <= 0.0 ? 0.0 : exp(-max(d, 0.0) / radius) * (1.0 - aaFill(d)) * k; }
vec4 shade(vec2 p, vec2 h, vec4 color, vec4 extra) {
  float kind = extra.y;
  float R = (kind > 2.5 && kind < 3.5) || kind > 8.5 ? h.y : min(h.x, h.y);
  float hr = u_glow * R;
  float len = length(p);
  vec3 c = color.rgb;
  float a = 0.0;
  if (kind < 0.5) {
    float soft = max(extra.z * R, 1.0);
    a = clamp((R - len) / soft, 0.0, 1.0);
    a = a * a * (3.0 - 2.0 * a);
    a += halo(len - R, hr, 0.5);
  } else if (kind < 1.5) {
    float x = len / R;
    float core = exp(-x * x * 3.4);
    float hot = exp(-x * x * 16.0) * extra.w;
    a = core + exp(-max(x - 0.6, 0.0) * 2.2 / (0.4 + u_glow)) * 0.4 * u_glow * (1.0 - smoothstep(1.0, 3.0, x));
    c = mix(c, vec3(1.0, 0.93, 0.78) * (1.0 + 0.6 * luma(c)), clamp(hot, 0.0, 1.0));
  } else if (kind < 2.5) {
    if (R < 3.5) {
      a = aaFill(len - R * 0.7) * 0.9 + halo(len - R * 0.7, hr, 0.35);
    } else {
      float an = atan(p.y, p.x);
      float sec = 1.0471976;
      an = mod(an + sec * 0.5, sec) - sec * 0.5;
      vec2 q = len * vec2(cos(an), abs(sin(an)));
      float th = max(0.65, R * 0.065);
      float d = sdSegment(q, vec2(0.0), vec2(R * 0.96, 0.0));
      vec2 dir = vec2(0.5, 0.8660254);
      d = min(d, sdSegment(q, vec2(R * 0.40, 0.0), vec2(R * 0.40, 0.0) + dir * R * 0.30));
      d = min(d, sdSegment(q, vec2(R * 0.66, 0.0), vec2(R * 0.66, 0.0) + dir * R * 0.22));
      d = min(d, len - R * 0.13);
      d -= th;
      a = aaFill(d) + halo(d, hr, 0.3);
    }
  } else if (kind < 3.5) {
    float L = h.x;
    float t = smoothstep(-L, L, p.x);
    vec2 q = vec2(p.x - clamp(p.x, -L, L - R), p.y);
    float w = mix(0.12, 1.0, t);
    float d = length(q) - R * w;
    a = aaFill(d) * (0.22 + 0.78 * t) + halo(d, hr, 0.45) * (0.3 + 0.7 * t);
  } else if (kind < 4.5) {
    vec2 u = p / h;
    float x = u.x;
    float w = 0.9 * pow(max(sin(3.14159265 * (x * 0.5 + 0.5)), 0.0), 0.65);
    float d = (abs(u.y) - w) * h.y;
    float edge = smoothstep(0.35, 1.0, abs(u.y) / max(w, 0.02));
    c *= mix(1.1, 0.72, smoothstep(-1.0, 0.7, x)) * (1.0 + 0.45 * edge);
    c += vec3(1.0) * extra.w * 0.35 * smoothstep(0.1, 0.0, abs(u.y + 0.25 * w) ) * smoothstep(-0.4, 0.5, x);
    a = aaFill(d);
  } else if (kind < 5.5) {
    float core = exp(-pow(len / (R * 0.2), 2.0));
    float ax = exp(-abs(p.y) / (R * 0.03 + 0.55)) * pow(1.0 - smoothstep(0.0, R, abs(p.x)), 2.0);
    float ay = exp(-abs(p.x) / (R * 0.03 + 0.55)) * pow(1.0 - smoothstep(0.0, R, abs(p.y)), 2.0);
    vec2 r = vec2(p.x + p.y, p.x - p.y) * 0.7071;
    float dx = exp(-abs(r.y) / (R * 0.025 + 0.5)) * pow(1.0 - smoothstep(0.0, R * 0.5, abs(r.x)), 2.0);
    float dy = exp(-abs(r.x) / (R * 0.025 + 0.5)) * pow(1.0 - smoothstep(0.0, R * 0.5, abs(r.y)), 2.0);
    a = core + ax + ay + 0.35 * (dx + dy) + exp(-len / (R * 0.45)) * 0.16 * u_glow;
    c = mix(c, vec3(1.0), clamp(core * 0.7, 0.0, 1.0));
  } else if (kind < 6.5) {
    vec2 u = p / R;
    vec2 q = vec2(u.x, -u.y) * 0.8 + vec2(0.0, 0.55);
    float d = sdHeart(q) / 0.8 * R;
    float soft = extra.z * R * 0.5;
    a = 1.0 - smoothstep(-soft, soft + 0.75, d);
    c *= 0.82 + 0.4 * clamp(0.5 + u.y * -0.35 - u.x * 0.15, 0.0, 1.0);
    c += vec3(1.0) * 0.22 * exp(-dot(u - vec2(-0.28, -0.3), u - vec2(-0.28, -0.3)) * 22.0) * (1.0 - extra.z);
    a += halo(d, hr, 0.35);
  } else if (kind < 7.5) {
    float x = len / R;
    float edge = 1.0 - smoothstep(0.93 - extra.z * 0.7, 1.0, x);
    float rim = smoothstep(0.62, 0.96, x);
    a = (0.5 + 0.9 * rim * (1.0 - extra.z)) * edge;
    a *= 0.85 + 0.3 * vnoise(p / max(R * 0.35, 1.0) + 3.0);
  } else if (kind < 8.5) {
    vec2 u = p / h;
    float d = (abs(length(u) - 1.0) - extra.z) * min(h.x, h.y);
    a = aaFill(d) + halo(d, hr, 0.3);
  } else {
    float L = h.x;
    float d = sdSegment(p, vec2(-L + R, 0.0), vec2(L - R, 0.0)) - R;
    float core = aaFill(d);
    a = core + halo(d, hr, 0.55);
    c = mix(c, vec3(1.0), core * 0.75);
  }
  a = clamp(a, 0.0, 4.0);
  return vec4(c * a * color.a, min(a, 1.0) * color.a);
}`;
