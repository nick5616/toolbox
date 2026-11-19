/* Page-side helpers for the capture harness (injected next to cursor.js; never shipped).
 *
 *   __demo.find(spec)            -> {x, y, w, h} of the element's centre, or null
 *   __demo.exists(spec)          -> boolean
 *   __demo.drop(targetId, paths) -> synthetic in-app file drop (what a Library row dragged onto a tool does)
 *   __demo.call(name, args)      -> a Wails bound method by name, over the runtime's own transport
 *
 * Production builds have no dev handles (window.__ui), so everything here uses
 * the DOM and the runtime the page already has.
 */
(function (root) {
  "use strict";
  if (typeof document === "undefined" || root.__demo) return;

  var INTERACTIVE = 'button,a[href],[role="button"],[role="tab"],[role="menuitem"],[role="option"],[role="switch"],[role="checkbox"],[role="radio"],label,summary,input,select,textarea';
  var TEXTY = "button,a,[role],label,summary,li,h1,h2,h3,h4,span,div,p,td,th,input,textarea,select,option";
  var PATHS_MIME = "application/x-toolbox-paths";

  function norm(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase();
  }

  function visible(el) {
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
    return true;
  }

  function labelOf(el) {
    var parts = [el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("title"), el.getAttribute("data-tip")];
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") parts.push(el.textContent);
    return parts.map(norm).filter(Boolean);
  }

  function candidates(spec) {
    if (spec.any != null) {
      // A bare string: a CSS selector when it matches something visible, else text.
      var asCss = [];
      try {
        asCss = candidates({ css: spec.any, within: spec.within, nth: spec.nth });
      } catch (e) {
        asCss = [];
      }
      return asCss.length ? asCss : candidates({ text: spec.any, within: spec.within, exact: spec.exact });
    }
    var scope = spec.within ? document.querySelector(spec.within) : document;
    if (!scope) return [];
    var sel = spec.css || TEXTY;
    var list = Array.prototype.slice.call(scope.querySelectorAll(sel));
    if (spec.text == null && spec.textRe == null) return list.filter(visible);
    var want = spec.text == null ? "" : norm(spec.text);
    var re = spec.textRe == null ? null : new RegExp(spec.textRe, "i");
    var scored = [];
    list.forEach(function (el) {
      if (!visible(el)) return;
      var labels = labelOf(el);
      var exact = !re && labels.some(function (l) {
        return l === want;
      });
      var partial = re
        ? labels.some(function (l) {
            return re.test(l);
          })
        : labels.some(function (l) {
            return l.indexOf(want) >= 0;
          });
      if (!exact && !(partial && !spec.exact)) return;
      var r = el.getBoundingClientRect();
      scored.push({ el: el, exact: exact, area: r.width * r.height, inter: el.matches(INTERACTIVE) });
    });
    scored.sort(function (a, b) {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      if (a.inter !== b.inter) return a.inter ? -1 : 1;
      return a.area - b.area;
    });
    return scored.map(function (s) {
      return s.el;
    });
  }

  function resolve(spec) {
    if (typeof spec === "string") spec = { any: spec };
    var list = candidates(spec);
    var el = list[spec.nth || 0];
    if (!el) return null;
    var target = el.matches(INTERACTIVE) ? el : el.closest(INTERACTIVE) || el;
    return target;
  }

  function find(spec) {
    var el = resolve(spec);
    if (!el) return null;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top, tag: el.tagName.toLowerCase() };
  }

  function drop(targetId, paths) {
    var target = (targetId && document.getElementById(targetId)) || document.getElementById("app-root") || document.body;
    var dt = new DataTransfer();
    dt.setData(PATHS_MIME, JSON.stringify(paths));
    dt.setData("text/plain", paths.join("\n"));
    ["dragenter", "dragover", "drop"].forEach(function (type) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    return true;
  }

  /** A bound Wails method by its full name, e.g. call("toolbox/api.JobsService.List", [filter]). */
  async function call(methodName, args) {
    var w = root._wails;
    if (!w || !w.clientId) throw new Error("Wails runtime not ready");
    var res = await fetch(root.location.origin + "/wails/runtime", {
      method: "POST",
      headers: { "x-wails-client-id": w.clientId, "Content-Type": "application/json" },
      body: JSON.stringify({ object: 0, method: 0, args: { "call-id": "demo" + Math.random().toString(36).slice(2), methodName: methodName, args: args || [] } }),
    });
    var ct = res.headers.get("Content-Type") || "";
    if (!res.ok) throw new Error(await res.text());
    return ct.indexOf("application/json") >= 0 ? res.json() : res.text();
  }

  root.__demo = { find: find, exists: function (s) { return !!resolve(s); }, drop: drop, call: call, norm: norm };
})(window);
