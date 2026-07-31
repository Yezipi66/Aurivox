// ===========================================================================
//  BLACK-BOX INTEGRATION HARNESS  (node:test, zero third-party deps)
// ===========================================================================
// Ported from the former Python/pytest conftest.py. Launches the REAL
// Node/Express backend (server.js) against a lightweight STUB inference engine
// (a stdlib http.Server standing in for GPT-SoVITS on :9880), then lets tests
// drive the public HTTP surface. Deliberately end-to-end so the wiring under
// test — health aggregation, the language-defense stack, and resume/fork
// validation — is exercised through the same code path production uses.
//
// Everything here is Node stdlib only (http / net / fs / child_process). This
// file is NOT a test file (does not match *.node.test.js) so the runner never
// executes it directly — the integration test requires it.
//
// Environment isolation: the backend resolves its paths from its own directory
// (__dirname) plus a few env vars (BROKER_PORT / GPT_SOVITS_BASE_URL /
// ASSETS_ROOT / API_KEY). We assemble a TEMP app dir per run: server.js +
// package.json are COPIED (so __dirname points at the temp dir) while the heavy
// lib/ web/ node_modules/ trees are LINKED back to the repo. Fixture voices and
// assets live under a temp ASSETS_ROOT. Nothing in the real checkout is written.

const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const READY_TIMEOUT_MS = 40000;

// --------------------------------------------------------------------------- //
//  Small helpers
// --------------------------------------------------------------------------- //
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// A tiny but structurally valid 16-bit mono PCM WAV (non-empty body).
function minimalWav(nSamples = 64) {
  const sampleRate = 16000, blockAlign = 2, byteRate = sampleRate * blockAlign;
  const data = Buffer.alloc(nSamples * 2); // silence
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);          // PCM
  head.writeUInt16LE(1, 22);          // mono
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(byteRate, 28);
  head.writeUInt16LE(blockAlign, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

function maybeJson(buf) {
  try { return JSON.parse(buf.toString("utf-8")); } catch { return buf; }
}

// Return { status, headers, body } — body parsed as JSON when possible.
function httpJson(url, { method = "GET", body = null, headers = null, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const hdrs = Object.assign({}, headers || {});
    let data = null;
    if (body != null) {
      data = Buffer.from(JSON.stringify(body), "utf-8");
      if (!hdrs["Content-Type"]) hdrs["Content-Type"] = "application/json";
      hdrs["Content-Length"] = data.length;
    }
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: hdrs, timeout },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: maybeJson(Buffer.concat(chunks)) }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// --------------------------------------------------------------------------- //
//  Stub inference engine (stands in for GPT-SoVITS :9880)
// --------------------------------------------------------------------------- //
// The returned `state` is mutable so a single stub can simulate up/down (health)
// and tts success/failure at runtime, exactly like the pytest _EngineState.
function startStubEngine() {
  // `lastTts` captures the exact JSON body the broker POSTs to /tts, so tests can
  // inspect what actually reaches the inference side (e.g. the resolved text_lang).
  const state = { online: true, ttsStatus: 200, lastTts: null };
  const send = (res, code, buf = Buffer.alloc(0), ctype = "application/json") => {
    res.writeHead(code, { "Content-Type": ctype, "Content-Length": buf.length });
    res.end(buf);
  };
  const server = http.createServer((req, res) => {
    const pathname = req.url.split("?", 1)[0];
    if (req.method === "GET") {
      if (pathname === "/") {
        return state.online
          ? send(res, 200, Buffer.from('{"ok":true}'))
          : send(res, 503, Buffer.from('{"ok":false}'));
      }
      if (pathname === "/set_gpt_weights" || pathname === "/set_sovits_weights") {
        return send(res, 200, Buffer.from('{"ok":true}'));
      }
      return send(res, 404, Buffer.from('{"error":"not found"}'));
    }
    if (req.method === "POST") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (pathname === "/tts") {
          try { state.lastTts = JSON.parse(Buffer.concat(chunks).toString("utf-8")); } catch { state.lastTts = null; }
          return state.ttsStatus >= 400
            ? send(res, state.ttsStatus, Buffer.from('{"error":"stub tts failure"}'))
            : send(res, 200, minimalWav(), "audio/wav");
        }
        return send(res, 404, Buffer.from('{"error":"not found"}'));
      });
      return;
    }
    send(res, 405, Buffer.from('{"error":"method not allowed"}'));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// --------------------------------------------------------------------------- //
//  Runtime gate + fixture app dir
// --------------------------------------------------------------------------- //
// Returns a skip reason string if the backend can't run here, else null.
function runtimeSkipReason() {
  if (!fs.existsSync(path.join(REPO_ROOT, "node_modules", "express"))) {
    return "backend node_modules not installed (need express/cors/multer/js-yaml). "
      + "Run `npm install` in the project root, then re-run these tests.";
  }
  return null;
}

// Link a repo dir into the temp app dir WITHOUT copying. Node's junction type
// needs NO privilege on Windows (unlike a raw symlink -> WinError 1314) and is
// ignored on POSIX (a normal symlink is made). Falls back to a full copy.
function linkDir(src, dst) {
  try {
    fs.symlinkSync(src, dst, "junction");
    return;
  } catch {
    fs.cpSync(src, dst, { recursive: true });
  }
}

function buildApp(tmpRoot) {
  const app = path.join(tmpRoot, "app");
  fs.mkdirSync(app, { recursive: true });
  // Copy the two files that must be REAL so __dirname resolves to `app`.
  fs.copyFileSync(path.join(REPO_ROOT, "server.js"), path.join(app, "server.js"));
  fs.copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(app, "package.json"));
  // Link the heavy trees back to the repo (read-only use at runtime).
  for (const d of ["lib", "web", "node_modules"]) {
    const src = path.join(REPO_ROOT, d);
    if (fs.existsSync(src)) linkDir(src, path.join(app, d));
  }

  // Fixture voices at the app root (server reads <app>/voices.json).
  const voices = {
    // No language metadata at all -> text_lang defaults to "auto" and the
    // backend MUST emit an X-Language-Warning (defense line 4/6).
    novoice_lang: { display_name: "No Lang Voice" },
    // Pinned language -> deterministic read, NO warning.
    jp_voice: { display_name: "JP Voice", text_lang: "ja" },
  };
  fs.writeFileSync(path.join(app, "voices.json"), JSON.stringify(voices), "utf-8");

  // Fixture assets under a temp ASSETS_ROOT.
  const assets = path.join(tmpRoot, "assets");
  for (const vid of Object.keys(voices)) {
    const vd = path.join(assets, vid);
    fs.mkdirSync(vd, { recursive: true });
    const wav = path.join(vd, "ref.wav");
    fs.writeFileSync(wav, minimalWav());
    const seg = { segments: [{ matched: true, audio: wav, text: "reference text" }] };
    fs.writeFileSync(path.join(vd, "segments.json"), JSON.stringify(seg), "utf-8");
    // A meta.json MUST sit next to segments.json, or the server's startup
    // assetsNeedScan() returns true and runFullAssetScan() REBUILDS voices.json
    // from asset metadata — wiping the per-voice language we set above. Empty
    // checkpoints are sufficient: the whole-voice synthesis path only reads
    // meta.assets.checkpoints and the stub returns a WAV regardless.
    const meta = { assets: { checkpoints: { gpt: [], sovits: [] } } };
    fs.writeFileSync(path.join(vd, "meta.json"), JSON.stringify(meta), "utf-8");
  }

  return { appDir: app, assetsDir: assets };
}

async function waitReady(baseUrl) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const { status } = await httpJson(baseUrl + "/api/health", { timeout: 3000 });
      if (status && status < 500) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Boot the real server.js wired to a fresh stub engine. Returns a handle with
// base_url, the child process, the stub, and a stop() that tears everything
// down. On a boot timeout, throws an Error whose message includes the tail of
// the server log — the caller turns that into a graceful t.skip().
async function startBroker() {
  const stub = await startStubEngine();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "broker-"));
  const { appDir, assetsDir } = buildApp(tmpRoot);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const env = Object.assign({}, process.env, {
    BROKER_PORT: String(port),
    BROKER_HOST: "127.0.0.1",
    GPT_SOVITS_BASE_URL: stub.url,
    ASSETS_ROOT: assetsDir,
    API_KEY: "",         // loopback calls never need a key
    NODE_ENV: "test",
  });

  const logPath = path.join(tmpRoot, "server.out.log");
  const logfd = fs.openSync(logPath, "w");
  const proc = spawn("node", ["server.js"], { cwd: appDir, env, stdio: ["ignore", logfd, logfd] });

  const stop = async () => {
    try { proc.kill(); } catch {}
    try { fs.closeSync(logfd); } catch {}
    try { await stub.close(); } catch {}
  };

  const ready = await waitReady(baseUrl);
  if (!ready) {
    let log = "";
    try { log = fs.readFileSync(logPath, "utf-8"); } catch {}
    await stop();
    throw new Error("backend did not become ready in time.\n--- server log ---\n" + log.slice(-3000));
  }

  return { base_url: baseUrl, engine: stub, proc, stop };
}

module.exports = {
  REPO_ROOT,
  freePort,
  minimalWav,
  httpJson,
  startStubEngine,
  runtimeSkipReason,
  buildApp,
  startBroker,
};
