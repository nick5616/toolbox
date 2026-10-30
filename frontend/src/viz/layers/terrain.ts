/**
 * Terrain (SPEC.md §6.7 #8): the spectrogram as scrolling mountain lines in
 * perspective under a sky. Each row is the spectrum of a moment in the past
 * (quantised to the row rate so rows glide towards you without changing);
 * the newest row rises out of the ground at the front. Hidden-line removal
 * is done per pixel in the shader, back to front.
 */
import { FULLSCREEN_VS, Program } from "../gl/core";
import { bgShader, drive, speedScale } from "./_bg/util";
import { registerLayer, setPaletteUniforms } from "./registry";

const MAX_ROWS = 64;
const COLS = 64;

const FS = bgShader(`
uniform sampler2D u_rows;
uniform float u_nrows; uniform float u_frac; uniform float u_base; uniform float u_horizon; uniform float u_tall; uniform float u_bright; uniform float u_shift;
uniform float u_kick; uniform float u_beat; uniform float u_bass; uniform float u_drop; uniform float u_hi; uniform float u_mirror; uniform float u_fill;

float rowH(float j, float xw) {
  float xt = u_mirror > 0.5 ? clamp(abs(xw), 0.0, 1.0) : clamp(xw * 0.5 + 0.5, 0.0, 1.0);
  return texture(u_rows, vec2(xt * (1.0 - 1.0 / 64.0) + 0.5 / 64.0, (j + 0.5) / 64.0)).r;
}

void main() {
  float hz = u_horizon;
  float H = u_res.y;
  float px = 1.0 / H;
  vec3 col;
  // sky
  float sh = max(uv.y - hz, 0.0);
  vec3 hzCol = mix(palAt(1.0, u_shift), palAt(2.0, u_shift), 0.5);
  col = mix(hzCol * 0.16, u_bg, pow(smoothstep(0.0, 0.85, sh), 0.6));
  vec2 sp = (uv - vec2(0.5, hz + 0.1)) * vec2(u_aspect, 1.0);
  col += palAt(0.0, u_shift) * 0.1 * exp(-length(sp * vec2(0.7, 1.4)) * 5.0) * (1.0 + 0.5 * u_kick + 0.6 * u_drop);
  {
    vec2 g = vec2((uv.x - 0.5) * u_aspect, uv.y) * (H / 56.0); vec2 id = floor(g); vec2 hh = hash22(id);
    float d = length((g - id - 0.2 - 0.6 * hh) * 56.0);
    float star = step(0.86, hash21(id + 5.0)) * aaFill(d - 0.7 * H / 720.0) * (0.5 + 0.5 * sin(u_t * (1.0 + 2.0 * hh.x) + hh.y * 30.0));
    col += vec3(star) * smoothstep(0.1, 0.5, sh) * (0.45 + 0.8 * u_hi);
  }

  if (uv.y < hz + 0.45) {
    float rows = u_nrows;
    for (int ji = 63; ji >= 0; ji--) {
      float j = float(ji);
      if (j >= rows) continue;
      float d = j + u_frac;
      float q = 1.0 / (1.0 + d * (9.0 / rows) * 0.34);
      float yb = hz - (hz + 0.16) * pow(q, 0.95);
      float xw = (uv.x - 0.5) * u_aspect / (q * 1.05);
      float amp = smoothstep(0.0, 1.0, d) * (1.0 - smoothstep(rows - 8.0, rows, d));
      float absRow = u_base - j;
      float roll = 0.08 * (gnoise(vec2(xw * 2.2, absRow * 0.23)) - 0.35);
      float hs = rowH(j, xw);
      float hl = rowH(j, xw - px / q * u_aspect);
      float hr = rowH(j, xw + px / q * u_aspect);
      float hgt = (hs * u_tall * (0.75 + 0.5 * u_bass) + roll) * amp;
      float hgtL = (hl * u_tall * (0.75 + 0.5 * u_bass) + roll) * amp;
      float hgtR = (hr * u_tall * (0.75 + 0.5 * u_bass) + roll) * amp;
      float scale = 0.42 * pow(q, 1.05);
      float yl = yb + hgt * scale;
      float slope = (hgtR - hgtL) * scale * H * 0.5;
      float distPx = (yl - uv.y) * H / sqrt(1.0 + slope * slope);
      float fog = 1.0 - smoothstep(rows * 0.35, rows, d);
      float cover = clamp(0.5 + distPx, 0.0, 1.0);
      float hn = clamp(hs * 1.4, 0.0, 1.0);
      vec3 lineCol = mix(palAt(0.0, u_shift), palAt(1.0 + hn, u_shift), hn);
      float thick = mix(0.7, 1.5, q) * H / 720.0;
      float core = aaFill(abs(distPx) - thick);
      float glow = exp(-abs(distPx) / (3.0 * q * H / 720.0 + 1.0)) * 0.22;
      vec3 body = mix(u_bg, hzCol, 0.0) * 0.55 + lineCol * 0.07 * u_fill * exp(-max(distPx, 0.0) / (22.0 * q * H / 720.0 + 4.0)) * (0.5 + hn);
      vec3 lc = lineCol * (0.55 + 1.5 * hn + 0.5 * u_beat) * (0.35 + 0.65 * fog) * amp;
      col = mix(col, mix(body, hzCol * 0.1 * fog, 1.0 - fog) , cover * (1.0 - 0.0));
      col += lc * (core + glow * (1.0 - cover * 0.5)) * fog * fog;
    }
  }
  col *= u_bright;
  col *= 0.7 + 0.3 * smoothstep(1.4, 0.3, length((uv - 0.5) * vec2(u_aspect * 0.8, 1.0)));
  o = vec4(col * u_opacity, u_opacity);
}`);

registerLayer({
  type: "terrain",
  label: "Terrain",
  group: "background",
  icon: "mountain",
  params: {
    brightness: { kind: "number", label: "Brightness", min: 0, max: 2, default: 0.9 },
    react: { kind: "number", label: "Music reaction", min: 0, max: 2, default: 1 },
    speed: { kind: "number", label: "Scroll speed", min: 0.2, max: 3, default: 1 },
    colorShift: { kind: "number", label: "Colour shift", min: 0, max: 4, default: 0 },
    rows: { kind: "number", label: "Rows", min: 24, max: 64, default: 44, step: 1 },
    height: { kind: "number", label: "Height", min: 0, max: 2, default: 1 },
    horizon: { kind: "number", label: "Horizon", min: 0.3, max: 0.8, default: 0.6 },
    fill: { kind: "number", label: "Surface glow", min: 0, max: 2, default: 1 },
    mirror: { kind: "bool", label: "Mirror", default: true },
  },
  create(ctx) {
    const gl = ctx.gl;
    const prog = new Program(gl, FULLSCREEN_VS, FS);
    const tex = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, COLS, MAX_ROWS, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const vec = new Float32Array(COLS);
    const bytes = new Uint8Array(COLS * MAX_ROWS);
    return {
      render(f) {
        const react = f.params.react as number;
        const d = drive(f, react);
        const rows = Math.round(f.params.rows as number);
        const rate = 6 * (f.params.speed as number); // rows per motion second
        const sScale = speedScale(f);
        const tau = f.motionSec * rate;
        const base = Math.floor(tau);
        const frac = tau - base;
        for (let j = 0; j < rows; j++) {
          // content time of row j: the sampled time is pinned to the grid so the row never changes while it glides
          const tj = Math.max(0, (((base - j) / rate) * 1000) / sScale);
          f.analysis.vector("spectrum", tj, vec);
          for (let i = 0; i < COLS; i++) bytes[j * COLS + i] = Math.round(Math.min(1, (vec[i] ?? 0) * (0.35 + 0.65 * react + 0.0)) * 255);
        }
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, COLS, MAX_ROWS, gl.RED, gl.UNSIGNED_BYTE, bytes);
        prog.use().f1("u_t", f.motionSec).f1("u_opacity", f.opacity).f1("u_aspect", f.w / f.h).f2("u_res", f.w, f.h);
        setPaletteUniforms(prog, f.palette);
        prog
          .tex("u_rows", 0, tex)
          .f1("u_nrows", rows)
          .f1("u_frac", frac)
          .f1("u_base", base)
          .f1("u_horizon", f.params.horizon as number)
          .f1("u_tall", f.params.height as number)
          .f1("u_bright", f.params.brightness as number)
          .f1("u_shift", f.params.colorShift as number)
          .f1("u_kick", d.kick)
          .f1("u_beat", d.beat)
          .f1("u_bass", d.bass)
          .f1("u_drop", d.drop)
          .f1("u_hi", d.hi)
          .f1("u_mirror", f.params.mirror ? 1 : 0)
          .f1("u_fill", f.params.fill as number);
        ctx.fullscreen.draw();
      },
      dispose() {
        prog.dispose();
        gl.deleteTexture(tex);
      },
    };
  },
});
