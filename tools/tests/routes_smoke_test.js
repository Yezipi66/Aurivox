// Stage-1 smoke test. Loads server.js with npm deps (express/cors/multer)
// shimmed and app.listen stubbed, executing all top-level module code. This:
//   1) builds `const ctx = { ...allNames }` — throws ReferenceError if any ctx
//      name is undefined (i.e. a router dependency was not wired);
//   2) mounts all 9 domain routers via the shimmed express.Router, proving the
//      full factory wiring builds without throwing.
// Run from the project root:  node tools/tests/routes_smoke_test.js
// Exits non-zero on failure. No real engine / GPU / network required.
const path = require("path");
const Module = require("module");
const ROOT = path.resolve(__dirname, "..", "..");

function makeApp() {
  const a = {};
  for (const m of ["get", "post", "put", "delete", "patch", "use", "all", "set", "enable", "disable"]) a[m] = () => a;
  a.listen = (port, host, cb) => { console.log(`  [stub] app.listen(${port}, ${host}) — not actually listening`); return { close() {} }; };
  return a;
}
const expressShim = function () { return makeApp(); };
expressShim.Router = function () { const r = {}; for (const m of ["get", "post", "put", "delete", "patch", "use", "all"]) r[m] = () => r; return r; };
expressShim.static = () => (q, s, n) => n && n();
expressShim.json = () => (q, s, n) => n && n();
expressShim.urlencoded = () => (q, s, n) => n && n();

const multerShim = function () { const i = {}; for (const k of ["single", "array", "fields", "none", "any"]) i[k] = () => (q, s, n) => n && n(); return i; };
multerShim.diskStorage = () => ({});
multerShim.memoryStorage = () => ({});

const shims = { express: expressShim, cors: () => (q, s, n) => n && n(), multer: multerShim };
const orig = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(shims, request)) return shims[request];
  return orig.apply(this, arguments);
};

try {
  require(path.join(ROOT, "server.js"));
  console.log("\nroutes smoke test PASSED — ctx complete, all routers mounted, no ReferenceError.");
} catch (e) {
  console.error("\nroutes smoke test FAILED:\n" + (e && e.stack ? e.stack : e));
  process.exit(1);
}
