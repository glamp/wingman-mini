// Runs in the page's MAIN world (see manifest content_scripts world: "MAIN") at
// document_start. Content scripts live in an isolated world with their own `console`, so
// the only way to capture the *page's* console output is to wrap console here in the page's
// own world. We keep a capped ring buffer of serialized entries and hand it to the extension
// (isolated world) on request via window.postMessage — the two worlds share the DOM/window
// event target but not JS globals.
(function () {
  // Guard against double-install (the script can be injected again on-demand for tabs that
  // predate install). Without this, console would get wrapped twice.
  if (window.__wingmanConsoleCapture__) return;
  window.__wingmanConsoleCapture__ = true;

  const MAX_ENTRIES = 300;
  const MAX_LEN = 2000;
  const buffer = []; // { level, text, time }

  function push(level, text) {
    buffer.push({
      level,
      time: new Date().toISOString(),
      text: text.length > MAX_LEN ? text.slice(0, MAX_LEN) + "… (truncated)" : text,
    });
    if (buffer.length > MAX_ENTRIES) buffer.shift();
  }

  // Serialize a single console argument to a string eagerly, so we don't retain references to
  // (possibly huge, possibly mutated-later) objects in the buffer.
  function serializeArg(arg) {
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
    try {
      const seen = new WeakSet();
      const json = JSON.stringify(arg, (k, v) => {
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[Circular]";
          seen.add(v);
        }
        if (typeof v === "bigint") return v.toString();
        if (typeof v === "function") return `[Function ${v.name || "anonymous"}]`;
        return v;
      });
      // JSON.stringify returns undefined for things like a bare function/undefined.
      return json === undefined ? String(arg) : json;
    } catch (_e) {
      try {
        return String(arg);
      } catch (_e2) {
        return "[Unserializable]";
      }
    }
  }

  function format(args) {
    return Array.prototype.map.call(args, serializeArg).join(" ");
  }

  // Wrap console methods, calling through to the originals so page behavior is unchanged.
  ["log", "info", "warn", "error"].forEach((level) => {
    const original = console[level];
    if (typeof original !== "function") return;
    console[level] = function () {
      try {
        push(level, format(arguments));
      } catch (_e) {
        // Never let capture break the page's logging.
      }
      return original.apply(this, arguments);
    };
  });

  // Uncaught exceptions and unhandled promise rejections are usually the most useful signal.
  window.addEventListener("error", (e) => {
    try {
      const where =
        e.filename != null ? ` (${e.filename}:${e.lineno || 0}:${e.colno || 0})` : "";
      const stack = e.error && e.error.stack ? `\n${e.error.stack}` : "";
      push("error", `Uncaught: ${e.message}${where}${stack}`);
    } catch (_e) {}
  });

  window.addEventListener("unhandledrejection", (e) => {
    try {
      const reason = e.reason;
      const text =
        reason instanceof Error
          ? reason.stack || `${reason.name}: ${reason.message}`
          : serializeArg(reason);
      push("unhandled", `Unhandled promise rejection: ${text}`);
    } catch (_e) {}
  });

  // Hand the buffer to the extension (isolated world) when it asks. Request and response use
  // different `type`s so the listener never reacts to its own response (no echo loop).
  window.addEventListener("message", (e) => {
    const d = e.data;
    // Don't gate on e.source === window: the request comes from the extension's isolated
    // world, and the source WindowProxy isn't always === this world's `window`. The
    // source/type/nonce tags are enough to identify our own request.
    if (!d || d.source !== "wingman" || d.type !== "WM_LOGS_REQUEST") return;
    window.postMessage(
      { source: "wingman", type: "WM_LOGS_RESPONSE", nonce: d.nonce, logs: buffer.slice() },
      "*"
    );
  });
})();
