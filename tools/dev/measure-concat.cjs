// ============================================================
//  measure-concat.cjs —— 把「拼接的那 1.4 秒」拆到底
//
//  为什么要有这个脚本：
//    measure-fullhit.ps1 量出 B - C = 1.40 秒（全命中时拼接的账），
//    但它的 F 轴（自己跑一次 ffmpeg concat）只要 0.21 秒。
//    差了 1.2 秒 —— 说明**产品代码的拼接和 F 轴量的那个 ffmpeg 不是一回事**。
//    F 轴喂给 ffmpeg 的是 30 个 seg，产品喂的是 30 个 seg + 29 段静音（silence_ms
//    默认 300），而且静音文件是 **22050 Hz 写死的**（lib/audio/wav.js:10），
//    而 GPT-SoVITS 的段是 32000 Hz。参数不一致 + `-c copy` 是重点怀疑对象。
//
//  怎么量：不重写一份"像产品的"拼接，而是**直接 require 产品自己的模块**跑。
//    重写的东西量出来只能证明重写的那份有多快。
//
//  跑法（仓库根目录，服务开不开都行）：
//    .\tools\runtime\node\node.exe tools\dev\measure-concat.cjs
//
//  只读 + 写临时文件，跑完自己删干净；不碰 outputs\generate 里的原始产物。
// ============================================================

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const REPEAT = 3;

function say(s) { console.log(s); }

// ---------- 找一窝分段 ----------
// 取 outputs\generate 下 seg*.wav 最多的那个目录（就是 measure-fullhit 刚跑过的那次）。
function findSegs() {
  const gen = path.join(ROOT, 'outputs', 'generate');
  if (!fs.existsSync(gen)) return null;
  let best = null;
  for (const name of fs.readdirSync(gen)) {
    const dir = path.join(gen, name);
    let st;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const segs = fs.readdirSync(dir)
      .filter(f => /^seg.*\.wav$/i.test(f))
      .sort()
      .map(f => path.join(dir, f));
    if (segs.length >= 2 && (!best || segs.length > best.segs.length)) {
      best = { dir, segs };
    }
  }
  return best;
}

// ---------- 读 wav 头 ----------
function wavFacts(p) {
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(64);
  fs.readSync(fd, buf, 0, 64, 0);
  fs.closeSync(fd);
  return {
    rate: buf.readUInt32LE(24),
    channels: buf.readUInt16LE(22),
    bits: buf.readUInt16LE(34),
    bytes: fs.statSync(p).size,
  };
}

function stats(list) {
  const s = list.slice().sort((a, b) => a - b);
  return { min: s[0], med: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
}
function fmt(st) {
  return `${st.med.toFixed(2)} 秒  (min ${st.min.toFixed(2)} / max ${st.max.toFixed(2)})`;
}

async function timeIt(label, fn) {
  const runs = [];
  for (let i = 0; i < REPEAT; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    const t1 = process.hrtime.bigint();
    runs.push(Number(t1 - t0) / 1e9);
  }
  const st = stats(runs);
  say(`  ${label.padEnd(34)} ${fmt(st)}`);
  return st;
}

(async () => {
  say('=== 拼接耗时拆账 ' + new Date().toISOString().slice(0, 19).replace('T', ' ') + ' ===');
  say('仓库: ' + ROOT);

  const found = findSegs();
  if (!found) { say('⛔ outputs\\generate 下找不到带 seg*.wav 的目录 —— 先跑一次 measure-fullhit.ps1。'); process.exit(1); }
  say(`分段: ${found.segs.length} 个   来自 ${found.dir}`);

  // ---------- 事实 1：段和静音的格式对不对得上 ----------
  const { generateSilenceWav } = require(path.join(ROOT, 'lib', 'audio', 'wav.js'));
  const { concatWavFiles, concatWithFfmpeg } = require(path.join(ROOT, 'lib', 'audio', 'concat.js'));
  const { ffmpegCmd, checkFfmpeg } = require(path.join(ROOT, 'lib', 'audio', 'ffmpeg.js'));

  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'aurivox-concat-'));
  const probeSil = path.join(tmp, 'probe_silence.wav');
  generateSilenceWav(300, 22050, probeSil);

  const segF = wavFacts(found.segs[0]);
  const silF = wavFacts(probeSil);
  say('');
  say('── 格式核对 ─────────────────────────────');
  say(`  seg     ${segF.rate} Hz / ${segF.channels} ch / ${segF.bits} bit`);
  say(`  silence ${silF.rate} Hz / ${silF.channels} ch / ${silF.bits} bit   ← lib/audio/wav.js:10 写死 22050`);
  const mismatch = segF.rate !== silF.rate || segF.channels !== silF.channels || segF.bits !== silF.bits;
  say(mismatch
    ? '  ⛔ 参数不一致 —— concat demuxer + `-c copy` 遇到这种情况会逐个文件重开、报警告，'
    : '  ok 参数一致。');
  if (mismatch) {
    say(`     而且 300ms 的静音按 ${silF.rate} Hz 写、按 ${segF.rate} Hz 播 ⇒ 实际只有 `
      + `${(300 * silF.rate / segF.rate).toFixed(0)}ms，句间停顿本身也是错的。`);
  }

  const ffOk = checkFfmpeg();
  say(`  ffmpeg  ${ffOk ? ffmpegCmd() : '⛔ 不可用'}`);
  if (!ffOk) {
    // 不能"继续跑但数不作数" —— 那样屏幕上会出现一排看着正常的 0.00 秒，
    // 而它们量的是纯 Node 兜底，跟要查的那条路无关。当场停。
    say('⛔ 找不到 ffmpeg，产品会走纯 Node 兜底 —— 量出来的不是要查的那条路。停。');
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }

  // ---------- 事实 2：ffmpeg 到底在抱怨什么 ----------
  say('');
  say('── ffmpeg 的原话（产品那种喂法，只跑一次，取前 12 行）──');
  {
    const list = path.join(tmp, 'list_product.txt');
    const lines = [];
    for (let i = 0; i < found.segs.length; i++) {
      lines.push(`file '${found.segs[i].replace(/'/g, "'\\''")}'`);
      if (i < found.segs.length - 1) lines.push(`file '${probeSil.replace(/'/g, "'\\''")}'`);
    }
    fs.writeFileSync(list, lines.join('\n'));
    const out = path.join(tmp, 'out_probe.wav');
    const r = spawnSync(ffmpegCmd(), ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out], { encoding: 'utf8' });
    const err = String(r.stderr || '');
    const interesting = err.split(/\r?\n/).filter(l => /warn|error|dts|non-mono|differ|chang/i.test(l));
    const show = (interesting.length ? interesting : err.split(/\r?\n/).filter(Boolean)).slice(0, 12);
    for (const l of show) say('  | ' + l);
    if (!show.length) say('  （什么都没说）');
    say(`  警告类行数合计: ${interesting.length}`);
  }

  // ---------- 事实 3：三种喂法各要多久 ----------
  say('');
  say('── 计时（每项跑 ' + REPEAT + ' 次取中位数）──────────');

  const outP1 = path.join(tmp, 'p1.wav');
  const outP2 = path.join(tmp, 'p2.wav');
  const outP3 = path.join(tmp, 'p3.wav');

  // P1 = 产品原样：30 段 + 29 段静音，silence_ms=300
  const p1 = await timeIt('P1 产品 concatWavFiles(300ms)', async () => {
    await concatWavFiles(found.segs, outP1, 300);
  });

  // P2 = 产品同一个函数，但 silence_ms=0 ⇒ 列表里只有 30 段、没有静音文件
  const p2 = await timeIt('P2 产品 concatWavFiles(0ms)', async () => {
    await concatWavFiles(found.segs, outP2, 0);
  });

  // P3 = 裸 ffmpeg，30 段 -c copy（等于 measure-fullhit 的 F 轴，只是改由 node 起进程）
  const p3 = await timeIt(`P3 裸 ffmpeg ${found.segs.length} 段 -c copy`, async () => {
    const list = path.join(tmp, 'list_plain.txt');
    fs.writeFileSync(list, found.segs.map(s => `file '${s.replace(/'/g, "'\\''")}'`).join('\n'));
    spawnSync(ffmpegCmd(), ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', outP3], { stdio: 'ignore' });
  });

  // ---------- 结账 ----------
  say('');
  say('── 结账 ──────────────────────────────────');
  say(`  P1 - P2 = 静音那 29 个文件的账      ${(p1.med - p2.med).toFixed(2)} 秒`);
  say(`  P2 - P3 = 产品包装 vs 裸 ffmpeg     ${(p2.med - p3.med).toFixed(2)} 秒`);
  say(`  P3      = ffmpeg 进程本身的地板     ${p3.med.toFixed(2)} 秒`);
  say('');
  say('  怎么读：');
  say('   · P1 ≈ 1.4 且 P1-P2 占大头  ⇒ 账在**静音插值**上，是采样率不一致把 -c copy 逼慢了；');
  say('     改法是让静音跟着段的采样率走（wav.js 那个 22050 别写死），顺带把停顿时长修对。');
  say('   · P1 ≈ P2 ≈ P3 ≈ 0.2       ⇒ 拼接是清白的，那 1.4 秒在 concat 之外');
  say('     （statSync / computeSegmentBounds / writeGenMeta / HTTP），另外查。');
  say('   · P1 ≈ 1.4 但 P1-P2 很小    ⇒ 是产品这条包装路本身慢，看 concat.js 里写列表/写静音那几步。');

  fs.rmSync(tmp, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
