//  黑盒集成夹具：起真实的 server.js，配一个桩推理引擎，让测试驱动公开的 HTTP 接口。
// 刻意端到端：要验的接线（健康状态聚合、语言防线、续跑与分叉校验）都走生产同一条路。
// 只用 Node 标准库（http / net / fs / child_process）。
// 本文件不是测试文件（不匹配 *.node.test.js），测试运行器不会直接执行它，由集成测试 require。
//
// 环境隔离：后端按自己的目录（__dirname）加几个环境变量（BROKER_PORT / GPT_SOVITS_BASE_URL /
// ASSETS_ROOT / API_KEY）解析路径。每次运行搭一个临时 app 目录：server.js 与 package.json
// 是复制过去的（__dirname 因而指向临时目录），lib/ web/ node_modules/ 这些大目录链接回仓库。
// 夹具音色与资产放在临时 ASSETS_ROOT 下。真实检出目录不会被写入。

const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const READY_TIMEOUT_MS = 40000;

//  小工具
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

// 结构完整的 16 位单声道 PCM WAV（数据段非空）。
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

// 返回 { status, headers, body }，body 能当 JSON 解析时就解析。
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

//  桩推理引擎（代替真实引擎）
// 返回的 state 是可变的：一个桩就能在运行期模拟上下线（健康状态）与合成成败。
function startStubEngine() {
  // lastTts 记下 POST 到 /tts 的 JSON 原文，测试据此看真正到达推理侧的请求（比如解析后的 text_lang）。
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

//  运行条件判断 + 夹具 app 目录
// 后端跑不起来时返回一句跳过原因，跑得起来则返回 null。
function runtimeSkipReason() {
  if (!fs.existsSync(path.join(REPO_ROOT, "node_modules", "express"))) {
    return "backend node_modules not installed (need express/cors/multer/js-yaml). "
      + "Run `npm install` in the project root, then re-run these tests.";
  }
  return null;
}

// 把仓库里的目录链进临时 app 目录而不复制。Windows 上 Node 的 junction 类型不需要特权
//（裸符号链接会报 WinError 1314），POSIX 上则退化成普通符号链接。再失败就整份复制。
function linkDir(src, dst) {
  try {
    fs.symlinkSync(src, dst, "junction");
    return;
  } catch {
    fs.cpSync(src, dst, { recursive: true });
  }
}

// refSamples 决定夹具参考音频的长度。默认（64 采样，约 0 秒）够 OpenAI 兼容语音路径用，
// 但 /api/generate 服务要求参考音频 3 到 10 秒，走那条路径的用例必须给一个真实长度的片段。
// 64000 采样 @16kHz = 4 秒。
function buildApp(tmpRoot, { refSamples = 64 } = {}) {
  const app = path.join(tmpRoot, "app");
  fs.mkdirSync(app, { recursive: true });
  // 这两个文件必须是真的，__dirname 才会落在 app 目录上。
  fs.copyFileSync(path.join(REPO_ROOT, "server.js"), path.join(app, "server.js"));
  fs.copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(app, "package.json"));
  // 重量级目录链回仓库（运行时只读）。
  // pipeline 必须在列：server.js 直接 require pipeline/uvr5/uvr5_models，
  // 少了它后端起不来（MODULE_NOT_FOUND），于是所有依赖服务端的用例都变成跳过而不是失败。
  // engines 放推理树，vendor 放预编译二进制。
  for (const d of ["lib", "web", "engines", "pipeline", "vendor", "node_modules"]) {
    const src = path.join(REPO_ROOT, d);
    if (fs.existsSync(src)) linkDir(src, path.join(app, d));
  }

  // 夹具音色放在 app 的 data 目录下。运行期数据在 <app>/data，lib/paths.js 仍会回退到
  // <app>/voices.json（尚未做数据迁移的安装），但夹具必须走当前布局。
  fs.mkdirSync(path.join(app, "data"), { recursive: true });
  const voices = {
    // 完全没有语言元数据：text_lang 取默认值 auto，后端必须发出 X-Language-Warning。
    novoice_lang: { display_name: "No Lang Voice" },
    // 语言已固定：读法确定，不会告警。
    jp_voice: { display_name: "JP Voice", text_lang: "ja" },
  };
  fs.writeFileSync(path.join(app, "data", "voices.json"), JSON.stringify(voices), "utf-8");

  // 夹具资产放在临时 ASSETS_ROOT 下。
  const assets = path.join(tmpRoot, "assets");
  for (const vid of Object.keys(voices)) {
    const vd = path.join(assets, vid);
    fs.mkdirSync(vd, { recursive: true });
    const wav = path.join(vd, "ref.wav");
    fs.writeFileSync(wav, minimalWav(refSamples));
    const seg = { segments: [{ matched: true, audio: wav, text: "reference text" }] };
    fs.writeFileSync(path.join(vd, "segments.json"), JSON.stringify(seg), "utf-8");
    // segments.json 旁边必须有 meta.json：否则后端启动时的 assetsNeedScan() 会返回 true，
    // runFullAssetScan() 就会照资产元数据重建 voices.json，把上面设的逐音色语言抹掉。
    // checkpoints 留空即可：整音色合成路径只读 meta.assets.checkpoints，桩引擎照样返回 WAV。
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

// 起真实的 server.js 并接到一个新桩引擎上。返回的句柄含 base_url、子进程、桩引擎，
// 以及把这一切拆掉的 stop()。启动超时则抛错，错误里带上服务端日志尾部，调用方据此优雅跳过。
// extraEnv 让同一套夹具用不同的可选功能集启动（例如 FLOW_ENABLED=1），不必再写一份夹具。
async function startBroker({ extraEnv = null, refSamples = 64 } = {}) {
  const stub = await startStubEngine();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "broker-"));
  const { appDir, assetsDir } = buildApp(tmpRoot, { refSamples });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const env = Object.assign({}, process.env, {
    BROKER_PORT: String(port),
    BROKER_HOST: "127.0.0.1",
    GPT_SOVITS_BASE_URL: stub.url,
    ASSETS_ROOT: assetsDir,
    API_KEY: "",         // loopback calls never need a key
    NODE_ENV: "test",
  }, extraEnv || {});

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
    try { log = fs.readFileSync(logPath, "utf-8"); } catch {
      // 日志读不出来（路径没了或被占用）时仍然抛「没就绪」，只是错误里不带服务端日志。
    }
    await stop();
    throw new Error("backend did not become ready in time.\n--- server log ---\n" + log.slice(-3000));
  }

  return { base_url: baseUrl, engine: stub, proc, stop, appDir, tmpRoot, logPath };
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
