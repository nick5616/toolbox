/**
 * The text layer (SPEC.md §6.8). The engine calls `createTextLayer` once and
 * `render` per frame after the scenes and before the global post chain, with
 * the HDR target bound and premultiplied-alpha blending on.
 *
 * Lines are rasterised once into a shared atlas (atlas.ts), laid out
 * (layout.ts), and drawn as one quad per word with per-word transforms and
 * colours (animations.ts + shaders.ts). Everything is a pure function of the
 * frame time: no randomness, no clocks.
 */
import { Program, type Fullscreen } from "../gl/core";
import { QuadBatch, SHADE_DISC, SHADE_ROUND_BOX } from "../gl/quads";
import type { FrameInput } from "../layers/registry";
import { hexToLinear, type RGB } from "../palette";
import type { TextStyle } from "../types";
import {
  emphasisEnv,
  isSubtitle,
  NEXT_LOOKAHEAD_MS,
  promotion,
  riseOffset,
  selectLines,
  smoothstep,
  SPARKS_PER_WORD,
  sparkAt,
  titleCardAlpha,
  typewriterReveal,
  wordAnim,
  wordSeed,
  type WordTiming,
} from "./animations";
import { GlyphAtlas, PAGE_SIZE, type LineEntry, type RasterStyle } from "./atlas";
import { fontSizePx, maxTextWidth, NEXT_ALPHA, NEXT_GAP, NEXT_SIZE, placeBlock, rowBaseline, titleCardTops, LINE_HEIGHT } from "./layout";
import { WORD_FS, WORD_STRIDE_FLOATS, WORD_VS } from "./shaders";

export interface TextLayer {
  /** Draws the words at f.tMs into the bound HDR target. */
  render(f: FrameInput, style: TextStyle): void;
  resize(w: number, h: number): void;
  dispose(): void;
}

export interface TextLayerContext {
  gl: WebGL2RenderingContext;
  fullscreen: Fullscreen;
  w: number;
  h: number;
  /** True in a worker (OffscreenCanvas 2D for rasterising). */
  inWorker: boolean;
}

const OUTLINE_RGB: RGB = [0.003, 0.003, 0.006];

/** The style with colours resolved and the preset rules applied. */
interface Resolved {
  preset: TextStyle["preset"];
  subtitle: boolean;
  boxed: boolean;
  color: RGB;
  highlight: RGB;
  emphColor: RGB;
  emphScale: number;
  emphGlow: number;
  sparks: boolean;
  glow: number;
  outline: number;
  fontPx: number;
  position: TextStyle["position"];
  showNext: boolean;
}

function resolve(style: TextStyle, f: FrameInput): Resolved {
  const subtitle = isSubtitle(style.preset);
  const highlight = style.highlight === "mood" ? f.palette.accent : hexToLinear(style.highlight);
  return {
    preset: style.preset,
    subtitle,
    boxed: style.preset === "subtitle-boxed",
    color: hexToLinear(style.color),
    highlight,
    emphColor: style.emphasis.color === "mood" ? f.palette.accent : highlight,
    emphScale: subtitle ? 1 : Math.max(1, Math.min(2, style.emphasis.scale)),
    emphGlow: subtitle ? 0 : Math.max(0, style.emphasis.glow),
    sparks: style.emphasis.sparks && !subtitle,
    glow: Math.max(0, style.glow),
    outline: Math.max(0, Math.min(0.15, style.outline)),
    fontPx: fontSizePx(style.size, f.w, f.h),
    position: subtitle ? "lower" : style.position,
    showNext: style.showNext && !subtitle,
  };
}

const mix3 = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Index of the last line starting at or before tMs, or 0. */
function lastStarted(lines: ReadonlyArray<{ startMs: number }>, tMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let at = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((lines[mid] as { startMs: number }).startMs <= tMs) {
      at = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return at;
}

interface Emit {
  entry: LineEntry;
  /** Size multiplier (1 main, 0.8 next). */
  sm: number;
  top: number;
  alpha: number;
  /** Words with timings, or null for static text (the title card). */
  line: { startMs: number; words: Array<{ startMs: number; endMs: number; text: string; emphasis?: boolean }> } | null;
  lineIndex: number;
  base: RGB;
  hi: RGB;
  /** Extra vertical offset, px. */
  dy: number;
  /** React scale about the block centre. */
  rk: number;
  /** Nominal font px of this entry (for em-based offsets). */
  fontPx: number;
}

export function createTextLayer(ctx: TextLayerContext): TextLayer {
  const gl = ctx.gl;
  let w = ctx.w;
  let h = ctx.h;
  const atlas = new GlyphAtlas(gl);
  const prog = new Program(gl, WORD_VS, WORD_FS, { a_corner: 0, a_rect: 1, a_uv: 2, a_c0: 3, a_c1: 4, a_c2: 5, a_p: 6, a_q: 7 });
  const boxes = new QuadBatch(gl, SHADE_ROUND_BOX, 8);
  const sparkBatch = new QuadBatch(gl, SHADE_DISC, 64);

  const vao = gl.createVertexArray() as WebGLVertexArrayObject;
  const cornerBuf = gl.createBuffer() as WebGLBuffer;
  const instBuf = gl.createBuffer() as WebGLBuffer;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  for (let i = 0; i < 7; i++) {
    gl.enableVertexAttribArray(1 + i);
    gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, WORD_STRIDE_FLOATS * 4, i * 16);
    gl.vertexAttribDivisor(1 + i, 1);
  }
  gl.bindVertexArray(null);

  // per-page instance buckets, reused every frame
  const buckets: number[][] = [];

  const pushWord = (page: number, v: number[]): void => {
    (buckets[page] ??= []).push(...v);
  };

  const sparkPushes: Array<[number, number, number, number, RGB, number]> = [];

  function emitLine(R: Resolved, f: FrameInput, e: Emit, pivotY: number): void {
    const { entry, sm } = e;
    const lay = entry.layout;
    const t = f.tMs;
    const cx0 = w / 2;
    const rowH = lay.rowHeight * sm;
    const emphasised = (i: number): boolean => !!e.line?.words[i]?.emphasis && !R.subtitle && e.line !== null;

    if (R.boxed && e.line) {
      for (let r = 0; r < lay.rows.length; r++) {
        const row = lay.rows[r];
        if (!row) continue;
        const cy = e.top + (r + 0.5) * rowH + e.dy;
        const hw = (row.width * sm) / 2 + 0.45 * e.fontPx * lay.fit * sm;
        const hh = rowH / 2 + 0.04 * e.fontPx * sm;
        boxes.push(cx0, cy, hw, hh, 0, 0, 0, 0.55 * e.alpha, 0, 0.28 * e.fontPx * sm);
      }
    }

    for (const b of lay.boxes) {
      const cell = entry.cells[b.index];
      if (!cell) continue;
      const word = e.line?.words[b.index];
      const emph = emphasised(b.index);
      const timing: WordTiming | null = word ? { startMs: word.startMs, endMs: word.endMs, index: b.index, chars: word.text.length } : null;
      const anim = timing ? wordAnim(R.preset, t, timing) : { alpha: 1, scale: 1, dy: 0, progress: -1, typed: -1, flash: 0 };
      if (anim.alpha <= 0.003) continue;

      let reveal = 1;
      if (anim.typed >= 0) {
        if (anim.typed <= 0.001) continue;
        reveal = anim.typed >= cell.prefix.length - 1 ? 1 : typewriterReveal(cell.prefix, anim.typed) / Math.max(1, cell.gw);
      }

      const env = emph && timing ? emphasisEnv(t, timing.startMs) : 0;
      const dsc = lay.fit * sm * anim.scale * e.rk;
      let ax = cx0 + b.cx * sm;
      let ay = rowBaseline(e.top, b.row, rowH, e.fontPx * sm, lay.fit) + e.dy + anim.dy * e.fontPx * lay.fit * sm;
      if (e.rk !== 1) {
        ax = cx0 + (ax - cx0) * e.rk;
        ay = pivotY + (ay - pivotY) * e.rk;
      }
      const qw = cell.w * dsc;
      const qh = cell.h * dsc;
      let qcx = ax + (cell.w / 2 - (cell.ox + cell.gw / 2)) * dsc;
      let qcy = ay + (cell.h / 2 - cell.baseline) * dsc;
      if (Math.abs(dsc - 1) < 0.002) {
        qcx = Math.round(qcx - qw / 2) + qw / 2;
        qcy = Math.round(qcy - qh / 2) + qh / 2;
      }

      // colours
      const karaoke = anim.progress >= 0;
      let fill = e.base;
      let hi = e.hi;
      if (karaoke) {
        fill = [e.base[0] * 0.78, e.base[1] * 0.78, e.base[2] * 0.78];
        if (emph) hi = R.emphColor;
      } else {
        if (anim.flash > 0) fill = mix3(fill, hi, anim.flash);
        if (emph && timing) fill = mix3(fill, R.emphColor, smoothstep((t - timing.startMs) / 90));
      }
      const gain = R.glow * 0.75 + (emph ? R.emphGlow * env * 1.2 : 0);
      const hot = Math.min(0.5, 0.2 * gain);
      const edge = karaoke ? Math.max(0.1, Math.min(0.7, (0.35 * cell.px) / Math.max(1, cell.gw))) : 0.3;
      const opacity = e.alpha * anim.alpha;
      pushWord(cell.page, [
        qcx, qcy, qw / 2, qh / 2,
        cell.x / PAGE_SIZE, cell.y / PAGE_SIZE, (cell.x + cell.w) / PAGE_SIZE, (cell.y + cell.h) / PAGE_SIZE,
        fill[0], fill[1], fill[2], opacity,
        hi[0], hi[1], hi[2], karaoke ? anim.progress : -1,
        OUTLINE_RGB[0], OUTLINE_RGB[1], OUTLINE_RGB[2], R.outline > 0 ? 0.92 : 0,
        reveal, gain, 0, cell.ox / cell.w,
        (cell.ox + cell.gw) / cell.w, edge, hot, 0,
      ]);

      if (R.sparks && emph && timing && e.line) {
        const age = t - timing.startMs;
        const seed = wordSeed(e.lineIndex, b.index);
        const wordEm = (b.textW * lay.fit) / Math.max(1, e.fontPx * lay.fit);
        for (let k = 0; k < SPARKS_PER_WORD; k++) {
          const s = sparkAt(seed, k, age, wordEm * 0.8);
          if (!s) continue;
          const em = e.fontPx * lay.fit * sm;
          sparkPushes.push([ax + s.dx * em, ay + s.dy * em, Math.max(0.8, s.size * em), s.alpha * e.alpha, R.emphColor, e.rk]);
        }
      }
    }
  }

  function draw(): void {
    const res = [w, h] as const;
    gl.bindVertexArray(vao);
    prog.use().f2("u_res", res[0], res[1]);
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    for (let p = 0; p < buckets.length; p++) {
      const data = buckets[p];
      const tex = atlas.page(p);
      if (!data || data.length === 0 || !tex) continue;
      prog.tex("u_atlas", 0, tex);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, data.length / WORD_STRIDE_FLOATS);
    }
    gl.bindVertexArray(null);
  }

  return {
    render(f, style) {
      const lines = f.analysis.text?.lines;
      if (!lines || lines.length === 0) return;
      w = f.w;
      h = f.h;
      const R = resolve(style, f);
      const wantGlow = R.glow > 0 || R.emphGlow > 0;
      const rasterStyle: RasterStyle = { family: style.font, weight: style.weight, uppercase: style.uppercase, outline: R.outline, glow: wantGlow };
      atlas.configure([style.font, style.weight, style.uppercase, R.outline, wantGlow, R.emphScale, R.subtitle, R.fontPx.toFixed(1), w, h].join("|"));

      const t = f.tMs;
      const sel = selectLines(lines, t, R.preset, R.showNext);
      const cur = lastStarted(lines, t);
      const titleA = style.titleCard && (style.titleCard.title || style.titleCard.artist) ? titleCardAlpha(t, (lines[0] as { startMs: number }).startMs) : 0;

      // keep the lines around the playhead, evict the rest
      const keep = new Set<string>();
      for (let k = Math.max(0, cur - 2); k <= Math.min(lines.length - 1, cur + 3); k++) keep.add(`l${k}`);
      if (titleA > 0) {
        keep.add("t0");
        keep.add("t1");
      }
      atlas.retain(keep);

      for (const b of buckets) b.length = 0;
      boxes.begin();
      sparkBatch.begin();
      sparkPushes.length = 0;

      const maxW = maxTextWidth(w, h);
      const request = (index: number, fontPx: number) => {
        const line = lines[index] as (typeof lines)[number];
        return atlas.line(
          `l${index}`,
          {
            words: line.words.map((x) => x.text),
            emphasised: line.words.map((x) => !!x.emphasis && !R.subtitle),
            fontPx,
            emphasisScale: R.emphScale,
            maxWidth: maxW,
          },
          rasterStyle,
        );
      };
      const rk = style.react.signal ? Math.max(0.5, Math.min(2, 1 + style.react.amount * 0.12 * f.signals.value(style.react.signal, t))) : 1;

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      if (titleA > 0 && style.titleCard) {
        const card = style.titleCard;
        const mk = (key: string, text: string, mul: number) => {
          const px = R.fontPx * mul;
          return atlas.line(key, { words: text.split(/\s+/).filter((s) => s !== ""), emphasised: [], fontPx: px, emphasisScale: 1, maxWidth: maxW }, rasterStyle);
        };
        const title = mk("t0", card.title, 1.5);
        const artist = mk("t1", card.artist, 0.85);
        const gap = card.title && card.artist ? 0.45 * R.fontPx : 0;
        const tops = titleCardTops(h, card.title ? title.layout.height : 0, card.artist ? artist.layout.height : 0, gap);
        const base = { sm: 1, alpha: titleA, line: null, lineIndex: -1, dy: 0, rk: 1 };
        if (card.title) emitLine(R, f, { ...base, entry: title, top: tops.title, base: R.color, hi: R.highlight, fontPx: R.fontPx * 1.5 }, h / 2);
        if (card.artist) emitLine(R, f, { ...base, entry: artist, top: tops.artist, base: R.highlight, hi: R.highlight, fontPx: R.fontPx * 0.85 }, h / 2);
      }

      if (sel.main) {
        const i = sel.main.index;
        const line = lines[i] as (typeof lines)[number];
        const entry = request(i, R.fontPx);
        const below = R.showNext ? NEXT_GAP * R.fontPx + NEXT_SIZE * LINE_HEIGHT * R.fontPx * entry.layout.fit : 0;
        const mainTop = placeBlock(R.position, w, h, entry.layout.height, below);
        let top = mainTop;
        let sm = 1;
        let alpha = sel.main.alpha;
        const prev = lines[i - 1];
        if (R.showNext && prev && line.startMs - prev.endMs < NEXT_LOOKAHEAD_MS) {
          // the line glides from the "next" slot (smaller, dimmer) to the main slot
          const u = promotion(t, sel.main.timing);
          const slotTop = mainTop + entry.layout.height + NEXT_GAP * R.fontPx;
          top = slotTop + (mainTop - slotTop) * u;
          sm = NEXT_SIZE + (1 - NEXT_SIZE) * u;
          alpha *= NEXT_ALPHA + (1 - NEXT_ALPHA) * u;
        }
        const dy = R.preset === "rise" ? riseOffset(t, sel.main.timing) * h : 0;
        emitLine(R, f, { entry, sm, top, alpha, line, lineIndex: i, base: R.color, hi: R.highlight, dy, rk, fontPx: R.fontPx }, mainTop + entry.layout.height / 2);

        if (sel.next) {
          const ni = sel.next.index;
          const nentry = request(ni, R.fontPx);
          const ntop = mainTop + entry.layout.height + NEXT_GAP * R.fontPx;
          // while the main line is being promoted, the next one is still arriving: fade it in
          const arrive = line.startMs - (prev?.endMs ?? -1e9) < NEXT_LOOKAHEAD_MS ? smoothstep((t - sel.main.timing.showFromMs) / 220) : 1;
          emitLine(R, f, { entry: nentry, sm: NEXT_SIZE, top: ntop, alpha: sel.next.alpha * NEXT_ALPHA * arrive, line: null, lineIndex: ni, base: R.color, hi: R.highlight, dy: 0, rk: 1, fontPx: R.fontPx }, 0);
        }
      }

      for (const [x, y, r, a, c, k] of sparkPushes) {
        // HDR colour, low alpha: adds light for the bloom without hiding the text
        sparkBatch.push(x, y, r * k, r * k, c[0] * 6, c[1] * 6, c[2] * 6, 0.35 * a);
      }

      boxes.draw(w, h, 2, (p) => p.f1("u_glow", 0));
      draw();
      sparkBatch.draw(w, h, 2, (p) => p.f1("u_glow", 0));
    },
    resize(nw, nh) {
      w = nw;
      h = nh;
    },
    dispose() {
      atlas.dispose();
      prog.dispose();
      boxes.dispose();
      sparkBatch.dispose();
      gl.deleteVertexArray(vao);
      gl.deleteBuffer(cornerBuf);
      gl.deleteBuffer(instBuf);
    },
  };
}
