// Graceful shutdown coordinator. Extracted from server.js (P0 refactor).
// Default: stop taking new requests, let in-flight synthesis finish, then exit.

function createShutdownManager(server, { _inflight, _shuttingDown, console }) {
  let shuttingDown = _shuttingDown;
  const shutdownState = {
    get active() { return _inflight.size; },
    get shuttingDown() { return shuttingDown; },
    register(entry) { _inflight.add(entry); return () => _inflight.delete(entry); },
  };

  function shutdown(signal) {
    if (shuttingDown) {
      console.warn(`[shutdown] second ${signal} — forcing exit now.`);
      return process.exit(1);
    }
    shuttingDown = true;
    const graceMs = Math.max(0, parseInt(process.env.AURIVOX_SHUTDOWN_GRACE_MS, 10) || 120000);
    console.log(`[shutdown] ${signal} received — refusing new requests; ` +
      `${_inflight.size} in-flight (grace ${graceMs}ms).`);
    try { server.close(() => console.log("[shutdown] HTTP server closed to new connections.")); } catch (_) {}
    for (const entry of _inflight) {
      if (entry && entry.interruptible && typeof entry.abort === "function") {
        try { entry.abort(); } catch (_) {}
      }
    }
    const started = Date.now();
    const timer = setInterval(() => {
      if (_inflight.size === 0) {
        clearInterval(timer);
        console.log("[shutdown] all in-flight work finished — exiting cleanly.");
        process.exit(0);
      } else if (Date.now() - started > graceMs) {
        clearInterval(timer);
        console.warn(`[shutdown] grace elapsed with ${_inflight.size} still running — forcing exit.`);
        process.exit(0);
      }
    }, 250);
    if (typeof timer.unref === "function") timer.unref();
  }

  return { shutdown, shutdownState };
}

module.exports = { createShutdownManager };
