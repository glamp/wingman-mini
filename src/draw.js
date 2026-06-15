// Reusable freehand drawing surface for on-screen markup. Retained-mode (not flattened
// pixels): strokes are kept as data and redrawn every frame, which is what lets the
// "vanishing pen" fade each stroke independently on its own clock. The same surface backs
// both screenshot markup (canvas sized to the screenshot's natural pixels, fade off) and
// live-page recording markup (canvas sized to the viewport × devicePixelRatio, fade
// optional). DOM-agnostic so it works inside the Shadow DOM and in the light DOM alike.
(function () {
  // High-visibility presets: red, yellow, green, blue.
  const PALETTE = ["#ef4444", "#facc15", "#22c55e", "#3b82f6"];

  // Vanishing-pen timing (ms): hold at full opacity, then linear fade to nothing.
  const FADE = { hold: 2500, duration: 700 };

  // Wire freehand drawing onto an existing canvas. The caller sets canvas.width/height
  // (backing store) and the CSS box; we map client coords -> canvas coords from the two.
  // opts: { color, penWidth, fade }. Returns { setColor, setFade, clear, isEmpty, destroy }.
  function createSurface(canvas, opts = {}) {
    const ctx = canvas.getContext("2d");
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Each stroke: { color, width, points: [{x,y}], bornAt }.
    const strokes = [];
    let color = opts.color || PALETTE[0];
    let penWidth = opts.penWidth || 4;
    let fadeEnabled = !!opts.fade;
    let drawing = false;
    let cur = null;
    let rafId = 0;

    const now = () => performance.now();

    // Map a pointer event to backing-store coordinates.
    function toCanvas(e) {
      const r = canvas.getBoundingClientRect();
      const sx = r.width ? canvas.width / r.width : 1;
      const sy = r.height ? canvas.height / r.height : 1;
      return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
    }

    function drawStroke(s, alpha) {
      if (!s.points.length) return;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
      // A dot so a single click/tap leaves a mark.
      if (s.points.length === 1) ctx.lineTo(s.points[0].x + 0.01, s.points[0].y + 0.01);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    function render() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const t = now();
      for (let i = strokes.length - 1; i >= 0; i--) {
        const s = strokes[i];
        let alpha = 1;
        if (fadeEnabled) {
          const age = t - s.bornAt;
          if (age >= FADE.hold + FADE.duration) {
            strokes.splice(i, 1);
            continue;
          }
          if (age > FADE.hold) alpha = 1 - (age - FADE.hold) / FADE.duration;
        }
        drawStroke(s, alpha);
      }
    }

    function tick() {
      rafId = 0;
      render();
      // Keep animating while drawing, or while strokes are still aging out under fade.
      if (drawing || (fadeEnabled && strokes.length)) ensureLoop();
    }

    function ensureLoop() {
      if (!rafId) rafId = requestAnimationFrame(tick);
    }

    function onDown(e) {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      drawing = true;
      cur = { color, width: penWidth, points: [toCanvas(e)], bornAt: now() };
      strokes.push(cur);
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (_) {}
      render();
      ensureLoop();
    }

    function onMove(e) {
      if (!drawing || !cur) return;
      e.preventDefault();
      cur.points.push(toCanvas(e));
      render();
    }

    function onUp(e) {
      if (!drawing) return;
      drawing = false;
      cur = null;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch (_) {}
      // One last render; the loop stops on its own (unless fade keeps it alive).
      render();
    }

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);

    return {
      setColor(c) {
        color = c;
      },
      // Toggle the vanishing pen. Enabling restamps existing strokes so they hold-then-fade
      // from now (rather than vanishing instantly); disabling snaps them back to permanent.
      setFade(on) {
        fadeEnabled = !!on;
        if (fadeEnabled) {
          const t = now();
          for (const s of strokes) s.bornAt = t;
          ensureLoop();
        } else {
          render();
        }
      },
      clear() {
        strokes.length = 0;
        render();
      },
      isEmpty() {
        return strokes.length === 0;
      },
      destroy() {
        canvas.removeEventListener("pointerdown", onDown);
        canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("pointerup", onUp);
        canvas.removeEventListener("pointercancel", onUp);
        if (rafId) cancelAnimationFrame(rafId);
      },
    };
  }

  globalThis.Wingman = globalThis.Wingman || {};
  globalThis.Wingman.draw = { createSurface, PALETTE };
})();
