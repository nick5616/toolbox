/**
 * Image (SPEC.md §6.7 #9): cover art or the user's own picture as a
 * background: fill and crop (or contain over a blurred copy), blur, a slow Ken
 * Burns drift and a breathing zoom that follows the bass. With no picture it
 * falls back to a soft palette gradient so a design never looks broken.
 */
import { bgShader, commonParams, cumSignal, drive, fullscreenLayer, speedScale } from "./_bg/util";
import { registerLayer } from "./registry";

const FS = bgShader(`
uniform sampler2D u_tex;
uniform float u_has; uniform float u_texAspect; uniform float u_contain;
uniform float u_zoom; uniform vec2 u_pan; uniform float u_blur; uniform float u_dark; uniform float u_bright; uniform float u_sat; uniform float u_tint;
uniform float u_shift; uniform float u_kick; uniform float u_flow; uniform float u_flash;

vec3 blurSample(vec2 st, float radiusUV, float lod) {
  vec3 acc = textureLod(u_tex, st, lod).rgb;
  if (radiusUV <= 0.0) return acc;
  for (int i = 0; i < 8; i++) {
    float r = sqrt((float(i) + 0.5) / 8.0) * radiusUV;
    float a = float(i) * 2.39996;
    acc += textureLod(u_tex, st + r * vec2(cos(a), sin(a)), lod).rgb;
  }
  return acc / 9.0;
}

// image-space coordinates for a screen uv; fit 0 = cover (fill + crop), 1 = contain
vec2 imgCoord(vec2 p01, float contain, float zoom) {
  float A = u_aspect, Ti = u_texAspect;
  vec2 s = contain < 0.5 ? (A > Ti ? vec2(1.0, Ti / A) : vec2(A / Ti, 1.0)) : (A > Ti ? vec2(A / Ti, 1.0) : vec2(1.0, Ti / A));
  vec2 c = (p01 - 0.5) * s / zoom + 0.5 + u_pan * (contain < 0.5 ? 1.0 : 0.0);
  return vec2(c.x, 1.0 - c.y);
}

vec3 fetch(vec2 st, float blurPx, float spanY, float zoom) {
  vec2 ts = vec2(textureSize(u_tex, 0));
  float texelsPerPx = ts.y * spanY / (zoom * u_res.y);
  float rTexels = blurPx * u_res.y / 720.0 * texelsPerPx;
  float lod = max(log2(max(texelsPerPx, 1.0)), log2(max(rTexels * 0.6, 1.0)));
  float radiusUV = blurPx * u_res.y / 720.0 / u_res.y * spanY / zoom;
  return blurSample(st, radiusUV * 0.8, lod);
}

void main() {
  vec2 p = (uv - 0.5) * vec2(u_aspect, 1.0);
  float vig = smoothstep(0.25, 1.05, length(p));
  vec3 col;
  if (u_has > 0.5) {
    float A = u_aspect, Ti = u_texAspect;
    float spanCover = A > Ti ? Ti / A : 1.0;
    // backdrop: always the cover fit, blurred more when the image itself is contained
    vec3 back = fetch(imgCoord(uv, 0.0, u_zoom), max(u_blur, u_contain > 0.5 ? 26.0 : 0.0), spanCover, u_zoom);
    col = back;
    if (u_contain > 0.5) {
      vec2 st = imgCoord(uv, 1.0, u_zoom);
      float inside = step(0.0, st.x) * step(st.x, 1.0) * step(0.0, st.y) * step(st.y, 1.0);
      float spanContain = A > Ti ? 1.0 : Ti / A;
      vec3 fg = fetch(clamp(st, 0.0, 1.0), u_blur, spanContain, u_zoom);
      float edge = smoothstep(0.0, 0.004, min(min(st.x, 1.0 - st.x), min(st.y, 1.0 - st.y)));
      col = mix(back * 0.55, fg, inside * edge);
    }
    float l = luma(col);
    col = mix(vec3(l), col, u_sat);
    col = mix(col, l * palAt(l * 3.0, u_shift) * 1.6, u_tint);
    col *= u_bright * (1.0 - u_dark * (0.35 + 0.65 * vig)) * (1.0 + 0.25 * u_kick + 0.3 * u_flash);
    col += u_bg * 0.5;
  } else {
    // no picture: a soft, slowly moving palette gradient
    vec2 q = vec2(uv.x * u_aspect, uv.y);
    vec3 acc = vec3(0.0); float ws = 0.0;
    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      vec2 c = vec2(0.5 * u_aspect, 0.5) + vec2(sin(u_flow * (0.11 + fi * 0.03) + fi * 1.7), cos(u_flow * (0.09 + fi * 0.04) + fi * 2.3)) * vec2(0.4 * u_aspect, 0.4);
      float w = 1.0 / pow(0.03 + dot(q - c, q - c), 1.6);
      acc += palAt(fi, u_shift) * w; ws += w;
    }
    col = acc / ws * 0.2 * u_bright * (1.0 + 0.3 * u_kick);
    col *= 0.8 + 0.4 * gfbm(q * 2.5 + u_flow * 0.05, 3);
    col = mix(col, vec3(luma(col)), 0.0) * (1.0 - u_dark * 0.5 * vig) + u_bg;
  }
  o = vec4(col * u_opacity, u_opacity);
}`);

registerLayer({
  type: "image",
  label: "Image",
  group: "background",
  icon: "image",
  params: {
    ...commonParams({ brightness: 0.75, speed: 1 }),
    source: { kind: "enum", label: "Picture", options: ["auto", "cover", "image"], default: "auto" },
    fit: { kind: "enum", label: "Fit", options: ["fill", "contain"], default: "fill" },
    blur: { kind: "number", label: "Blur", min: 0, max: 40, default: 4 },
    zoom: { kind: "number", label: "Zoom", min: 1, max: 2, default: 1.04 },
    breathe: { kind: "number", label: "Breathing zoom", min: 0, max: 0.2, default: 0.05 },
    kenBurns: { kind: "number", label: "Ken Burns", min: 0, max: 2, default: 0.6 },
    darken: { kind: "number", label: "Darken", min: 0, max: 1, default: 0.35 },
    saturation: { kind: "number", label: "Saturation", min: 0, max: 2, default: 1.05 },
    tint: { kind: "number", label: "Palette tint", min: 0, max: 1, default: 0.1 },
  },
  create(ctx) {
    const gl = ctx.gl;
    const dummy = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, dummy);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return fullscreenLayer(
      ctx,
      FS,
      (p, f) => {
        const react = f.params.react as number;
        const d = drive(f, react);
        const t = ctx.textures;
        const order = f.params.source === "cover" ? (["cover", "image"] as const) : (["image", "cover"] as const);
        let tex: WebGLTexture | null = null;
        let aspect = 1;
        for (const k of order) {
          const cand = k === "cover" ? t.cover : t.image;
          if (cand) {
            tex = cand;
            aspect = k === "cover" ? t.coverAspect : t.imageAspect;
            break;
          }
        }
        const sp = f.params.speed as number;
        const kb = f.params.kenBurns as number;
        // Ken Burns: a slow triangle-wave zoom and a lissajous pan (about 50 s per cycle)
        const ph = (f.motionSec * sp) / 50;
        const tri = 1 - Math.abs(2 * (ph - Math.floor(ph)) - 1);
        const ease = tri * tri * (3 - 2 * tri);
        const breath = 1 + (f.params.breathe as number) * (0.65 * d.bass + 0.35 * d.kick);
        const zoom = ((f.params.zoom as number) + 0.1 * kb * ease) * breath;
        const pan = 0.025 * kb;
        p.tex("u_tex", 0, tex ?? dummy)
          .f1("u_has", tex ? 1 : 0)
          .f1("u_texAspect", aspect)
          .f1("u_contain", f.params.fit === "contain" ? 1 : 0)
          .f1("u_zoom", zoom)
          .f2("u_pan", Math.sin(f.motionSec * sp * 0.063) * pan, Math.cos(f.motionSec * sp * 0.047) * pan)
          .f1("u_blur", f.params.blur as number)
          .f1("u_dark", f.params.darken as number)
          .f1("u_bright", f.params.brightness as number)
          .f1("u_sat", f.params.saturation as number)
          .f1("u_tint", f.params.tint as number)
          .f1("u_shift", f.params.colorShift as number)
          .f1("u_kick", d.kick)
          .f1("u_flash", d.drop)
          .f1("u_flow", f.motionSec * sp * 0.5 + cumSignal(f.signals, "mix.level", f.tMs) * speedScale(f) * sp * react * 0.3);
      },
      () => gl.deleteTexture(dummy),
    );
  },
});
