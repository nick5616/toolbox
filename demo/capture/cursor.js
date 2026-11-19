/* Capture overlay: a neutral arrow cursor, click ripples and key-chip captions.
 *
 * Injected by the demo harness only (Page.addScriptToEvaluateOnNewDocument);
 * nothing in the app ships it. The harness moves the real (CDP) mouse along an
 * eased path and this overlay simply follows the pointer events, so hover
 * states and tooltips behave exactly as they do for a person.
 *
 * Plain script (no import/export) so the page can run it as-is; Node tests load
 * the pure helpers through `module.exports`.
 */
(function (root) {
  "use strict";

  /** Duration of a cursor move in ms: 350 for a hop, 700 for a trip across the screen. */
  function moveDuration(distancePx) {
    var d = Math.max(0, Number(distancePx) || 0);
    var t = Math.min(1, d / 1400);
    return Math.round(350 + 350 * t);
  }

  /** Cubic ease in-out on 0..1. */
  function ease(t) {
    var x = Math.min(1, Math.max(0, t));
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  }

  /** Position on the straight eased path from a to b at progress t (0..1). */
  function pathPoint(a, b, t) {
    var k = ease(t);
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  }

  var api = { moveDuration: moveDuration, ease: ease, pathPoint: pathPoint };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined" || typeof window === "undefined") return;
  if (root.__demoCursor) return;

  var ARROW =
    '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="34" viewBox="0 0 28 34">' +
    '<defs><filter id="ds" x="-30%" y="-30%" width="170%" height="170%"><feDropShadow dx="1" dy="2" stdDeviation="1.6" flood-color="#000" flood-opacity="0.38"/></filter></defs>' +
    '<path filter="url(#ds)" d="M4 2 L4 24 L9.4 19.2 L13 27.6 L16.6 26 L13 17.8 L20.4 17.6 Z" fill="#fff" stroke="#1b1b1f" stroke-width="1.6" stroke-linejoin="round"/></svg>';

  var host = null;
  var cur = null;
  var chips = null;
  var shown = false;
  var others = "";
  var TOP = "2147483647";

  function build() {
    host = document.createElement("div");
    host.id = "__demo-overlay";
    host.setAttribute("popover", "manual");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "position:fixed;inset:0;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;z-index:" + TOP + ";width:100vw;height:100vh;";
    cur = document.createElement("div");
    cur.style.cssText = "position:absolute;left:0;top:0;width:28px;height:34px;pointer-events:none;opacity:0;will-change:transform;transform:translate(-100px,-100px);";
    cur.innerHTML = ARROW;
    chips = document.createElement("div");
    chips.style.cssText = "position:absolute;left:0;right:0;bottom:44px;display:flex;justify-content:center;gap:10px;pointer-events:none;";
    host.appendChild(cur);
    host.appendChild(chips);
    document.documentElement.appendChild(host);
    promote(true);
  }

  /** Top layer: menus (popovers) and modal dialogs sit above any z-index, so re-show after they open. */
  function promote(force) {
    if (!host) return;
    var sig = "";
    try {
      sig = Array.prototype.map
        .call(document.querySelectorAll(":popover-open, dialog:modal"), function (e) {
          return e === host ? "" : e.tagName + (e.id || "") + (e.className || "");
        })
        .join("|");
    } catch (e) {
      return;
    }
    if (!force && sig === others && host.matches(":popover-open")) return;
    others = sig;
    try {
      if (host.matches(":popover-open")) host.hidePopover();
      host.showPopover();
    } catch (e) {
      /* popover API missing: z-index only */
    }
  }

  function place(x, y) {
    if (!host) build();
    cur.style.opacity = "1";
    cur.style.transform = "translate(" + (x - 4) + "px," + (y - 2) + "px)";
    shown = true;
  }

  function ripple(x, y) {
    if (!host) build();
    var r = document.createElement("div");
    r.style.cssText =
      "position:absolute;left:" + (x - 22) + "px;top:" + (y - 22) + "px;width:44px;height:44px;border-radius:50%;pointer-events:none;" +
      "border:3px solid rgba(255,255,255,0.95);background:rgba(120,160,255,0.30);box-shadow:0 0 0 1px rgba(0,0,0,0.25);opacity:0;";
    host.insertBefore(r, cur);
    var a = r.animate(
      [
        { transform: "scale(0.25)", opacity: 0.95 },
        { transform: "scale(1.15)", opacity: 0 },
      ],
      { duration: 480, easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" },
    );
    a.onfinish = function () {
      r.remove();
    };
  }

  function chip(text, ms) {
    if (!host) build();
    promote(true);
    var c = document.createElement("div");
    c.textContent = text;
    c.style.cssText =
      "font:600 22px/1 system-ui,'Segoe UI',sans-serif;color:#fff;background:rgba(24,24,28,0.86);padding:12px 18px;border-radius:12px;" +
      "box-shadow:0 6px 22px rgba(0,0,0,0.35),inset 0 0 0 1px rgba(255,255,255,0.12);letter-spacing:0.02em;opacity:0;";
    chips.appendChild(c);
    var life = ms || 1400;
    var a = c.animate(
      [
        { opacity: 0, transform: "translateY(8px)" },
        { opacity: 1, transform: "translateY(0)", offset: 0.12 },
        { opacity: 1, transform: "translateY(0)", offset: 0.8 },
        { opacity: 0, transform: "translateY(0)" },
      ],
      { duration: life, fill: "forwards" },
    );
    a.onfinish = function () {
      c.remove();
    };
  }

  function onPointer(e) {
    if (e.clientX === undefined) return;
    place(e.clientX, e.clientY);
  }
  document.addEventListener("mousemove", onPointer, true);
  document.addEventListener("pointermove", onPointer, true);
  document.addEventListener(
    "mousedown",
    function (e) {
      place(e.clientX, e.clientY);
      ripple(e.clientX, e.clientY);
    },
    true,
  );
  setInterval(function () {
    if (!host || !host.isConnected) {
      host = null;
      if (shown) build();
    } else promote(false);
  }, 120);

  root.__demoCursor = { place: place, ripple: ripple, chip: chip, moveDuration: moveDuration, ease: ease, pathPoint: pathPoint };
})(typeof window !== "undefined" ? window : globalThis);
