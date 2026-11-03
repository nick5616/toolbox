/**
 * One tooltip layer for the whole window (mounted once per window). Any
 * element gets a tooltip by having:
 *  - `data-tip` (preferred; `data-tip-kbd` adds a shortcut, `data-tip-side` = top | bottom | right | left), or
 *  - a `title` (moved to `data-tip` on first hover so the browser's own tooltip doesn't double it), or
 *  - for controls with no visible text (icon buttons, sliders, canvases…), its `aria-label`.
 * Tooltips show after a short hover or on keyboard focus, never get clipped
 * (they're portaled and placed in the viewport), and hide on click, scroll or Escape.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Kbd } from "./Kbd";
import styles from "./Tooltip.module.css";

const DELAY_MS = 450;
/** After a tooltip was open, moving to the next control shows its tooltip at once. */
const WARM_MS = 700;
const GAP = 6;
const INTERACTIVE = "button,a[href],input,select,textarea,canvas,[role=button],[role=switch],[role=slider],[role=tab],[role=menuitem],[role=radio],[role=checkbox],[role=option],[role=separator],[role=scrollbar]";

interface Tip {
  text: string;
  kbd: string | null;
  side: "top" | "bottom" | "right" | "left";
  rect: DOMRect;
}

/** The element that carries a tooltip for an event target, and its text. */
export function tipFor(start: Element | null): { el: HTMLElement; text: string; kbd: string | null; side: Tip["side"] } | null {
  for (let n: Element | null = start; n && n !== document.body; n = n.parentElement) {
    if (!(n instanceof HTMLElement || n instanceof SVGElement)) continue;
    const el = n as HTMLElement;
    if (el.dataset.tipOff !== undefined) return null;
    const title = el.getAttribute("title");
    if (title) {
      el.setAttribute("data-tip", title);
      el.removeAttribute("title");
    }
    const tip = el.getAttribute("data-tip");
    if (tip) return { el, text: tip, kbd: el.getAttribute("data-tip-kbd"), side: sideOf(el.getAttribute("data-tip-side")) };
    if (el.matches(INTERACTIVE)) {
      const label = el.getAttribute("aria-label");
      const visible = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (label && label.trim() && !sameText(label, visible)) return { el, text: label, kbd: null, side: "top" };
      // Keep walking: a labelled wrapper may describe it.
    }
  }
  return null;
}

function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return norm(a) === norm(b) || (norm(b).length > 0 && norm(a).startsWith(norm(b)) && norm(a).length - norm(b).length < 4);
}

function sideOf(v: string | null): Tip["side"] {
  return v === "bottom" || v === "right" || v === "left" ? v : "top";
}

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: HTMLElement | null = null;
    let lastHidden = 0;
    let shown = false;
    const hide = () => {
      clearTimeout(timer);
      if (shown) lastHidden = Date.now();
      shown = false;
      current = null;
      setTip(null);
    };
    const show = (target: Element | null, immediate: boolean) => {
      const t = tipFor(target);
      if (!t) {
        if (current) hide();
        return;
      }
      if (t.el === current) return;
      clearTimeout(timer);
      current = t.el;
      const open = () => {
        if (current !== t.el || !t.el.isConnected) return;
        shown = true;
        setTip({ text: t.text, kbd: t.kbd, side: t.side, rect: t.el.getBoundingClientRect() });
      };
      if (immediate || Date.now() - lastHidden < WARM_MS || shown) open();
      else {
        setTip(null);
        timer = setTimeout(open, DELAY_MS);
      }
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      show(e.target as Element, false);
    };
    const out = (e: PointerEvent) => {
      const to = e.relatedTarget as Node | null;
      if (current && to && current.contains(to)) return;
      if (!to) hide();
    };
    const focus = (e: FocusEvent) => {
      const el = e.target as HTMLElement;
      if (el.matches?.(":focus-visible")) show(el, false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerout", out, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("focusout", hide, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("wheel", hide, { capture: true, passive: true });
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerout", out, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("focusout", hide, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("wheel", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // Place the bubble once its size is known: preferred side, flipped and clamped to the window.
  useEffect(() => {
    const b = bubble.current;
    if (!tip || !b) {
      setPos(null);
      return;
    }
    const w = b.offsetWidth;
    const h = b.offsetHeight;
    const r = tip.rect;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left: number;
    let top: number;
    if (tip.side === "right" || tip.side === "left") {
      left = tip.side === "right" ? r.right + GAP : r.left - GAP - w;
      if (left + w > vw - 4) left = r.left - GAP - w;
      if (left < 4) left = r.right + GAP;
      top = r.top + r.height / 2 - h / 2;
    } else {
      top = tip.side === "bottom" ? r.bottom + GAP : r.top - GAP - h;
      if (top < 4) top = r.bottom + GAP;
      if (top + h > vh - 4) top = r.top - GAP - h;
      left = r.left + r.width / 2 - w / 2;
    }
    setPos({ left: Math.max(4, Math.min(vw - w - 4, left)), top: Math.max(4, Math.min(vh - h - 4, top)) });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div ref={bubble} role="tooltip" className={styles.floating} style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}>
      <span>{tip.text}</span>
      {tip.kbd && <Kbd combo={tip.kbd} />}
    </div>,
    document.body,
  );
}
