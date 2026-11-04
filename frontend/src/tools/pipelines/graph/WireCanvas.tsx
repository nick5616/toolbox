import { useEffect, useRef } from "react";
import { wireBezier, type Pt, type View, type WireKind } from "../graphModel";
import { glSupported, WireGL, type WireDraw } from "./wireGL";
import { isAnimated, readPalette, wireLook, type WireLook, type WirePalette, type WireVisualState } from "./wireStyle";
import styles from "./WireCanvas.module.css";

export interface WireSpec {
  id: string;
  /** World coordinates of the output port and the input port. */
  a: Pt;
  b: Pt;
  kind: WireKind;
  state: WireVisualState;
}

export interface WireCanvasProps {
  wires: readonly WireSpec[];
  view: View;
  width: number;
  height: number;
  /** Tells the parent whether the GL layer is drawing (else it draws SVG strokes itself). */
  onGL: (active: boolean) => void;
}

function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

const reducedMotion = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The glowing wires. Draws only when something changed, and keeps a
 * requestAnimationFrame loop going only while a wire animates (shimmer or
 * flow) and the page is visible.
 */
export function WireCanvas({ wires, view, width, height, onGL }: WireCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<WireGL | null>(null);
  const latest = useRef({ wires, view, width, height });
  const palette = useRef<{ at: number; p: WirePalette } | null>(null);
  const raf = useRef(0);
  const schedule = useRef<() => void>(() => undefined);

  latest.current = { wires, view, width, height };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !glSupported()) return;
    let gl: WireGL;
    try {
      gl = new WireGL(canvas);
    } catch {
      return; // no usable WebGL2: the SVG strokes stay visible
    }
    glRef.current = gl;
    onGL(true);
    const t0 = performance.now();

    const render = (now: number): boolean => {
      const { wires: ws, view: v, width: w, height: h } = latest.current;
      const dpr = window.devicePixelRatio || 1;
      if (!palette.current || now - palette.current.at > 1000) palette.current = { at: now, p: readPalette(canvas) };
      const pal = palette.current.p;
      const reduced = reducedMotion();
      const zf = Math.max(0.6, Math.min(1.5, v.zoom));
      const looks: WireLook[] = [];
      const draws: WireDraw[] = ws.map((s) => {
        const look = wireLook(s.state, reduced);
        looks.push(look);
        const c = wireBezier(s.a, s.b).map((q) => ({ x: q.x * v.zoom + v.x, y: q.y * v.zoom + v.y })) as [Pt, Pt, Pt, Pt];
        return {
          p: c,
          color: look.danger ? pal.danger : pal.kinds[s.kind],
          bright: look.bright * (pal.dark ? 1 : 0.9),
          glow: look.glow * zf,
          halo: look.halo * (pal.dark ? 1 : 0.45),
          core: look.core * zf,
          shimmer: look.shimmer,
          flow: look.flow,
          seed: seedOf(s.id),
        };
      });
      gl.resize(w, h, dpr);
      gl.draw(draws, { width: w, height: h, dpr, time: (now - t0) / 1000, additive: pal.dark });
      return isAnimated(looks);
    };

    const tick = (now: number) => {
      raf.current = 0;
      const animated = render(now);
      if (animated && document.visibilityState === "visible") raf.current = requestAnimationFrame(tick);
    };
    schedule.current = () => {
      if (raf.current === 0) raf.current = requestAnimationFrame(tick);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") schedule.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    schedule.current();

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      cancelAnimationFrame(raf.current);
      raf.current = 0;
      schedule.current = () => undefined;
      glRef.current = null;
      gl.dispose();
      onGL(false);
    };
    // Created once per mount; `latest` carries the props.
  }, []);

  useEffect(() => {
    schedule.current();
  }, [wires, view, width, height]);

  return <canvas ref={canvasRef} className={styles.canvas} style={{ width, height }} aria-hidden="true" />;
}
