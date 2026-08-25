// ============================================================
//  measure-concat2.cjs —— 第二刀：拼接本身清白，那 1.2 秒到底在哪
//
//  上一刀（measure-concat.cjs）的读数，真机 30 段：
//    P1 产品 concatWavFiles(300ms) = 0.22 秒
//    P2 产品 concatWavFiles(0ms)   = 0.19 秒
//    P3 裸 ffmpeg                  = 0.19 秒
//  ⇒ 拼接**清白**，静音插值只值 0.02 秒。
//  但 measure-fullhit 量到 B - C = 1.40 秒，而 B 比 C 多出来的**只有**这一段代码
//  （synthesisService.js:380-393）：concatWavFiles + statSync + computeSegmentBounds
//  + 一个更大的 writeGenMeta。后三样都是读 30 个 wav 头 / 写一个 json，毫秒级。
//
//  ⇒ 差别只剩一个：**文件的新旧**。
//     P1 拼的是 8-23 那批老段（跑三遍，早被系统缓存捂热了），
//     B 拼的是**这次请求刚写出来的 30 个新文件**，而且 combined.wav 也是新写进项目目录的。
//     Windows 上"另一个进程（ffmpeg.exe）去读刚落盘的新文件"正是 Defender
//     实时扫描要插一脚的地方 —— 这是唯一一个 P1 没有复现出来的条件。
//
//  这一刀就量这个。三条腿分离两个变量：
//    P1  老段（热）      → 输出到 %TEMP%      ＝ 上一刀的对照，应该还是 0.2
//    P5  老段（热）      → 输出到 outputs\    ＝ 只改**输出位置**
//    P4  刚复制的新段    → 输出到 outputs\    ＝ 再改**输入新鲜度**，最接近 B
//
//  怎么读：
//    P4 ≈ 1.4  ⇒ 账坐实在"新文件被另一个进程读"上（Defender/落盘），代码没毛病，
//                 该做的是给项目目录加排除项，或者别让 ffmpeg 去读刚写的文件。
//    P5 ≈ 1.4  ⇒ 是**写**到项目目录慢，跟输入新旧无关。
//    三条都 ≈ 0.2 ⇒ 那 1.2 秒不在这段代码里，回头去 B/C 两次的 meta.json 里对时间。
//
//  跑法（仓库根目录，服务开不开都行）：
//    .\tools\runtime\node\node.exe tools\dev\measure-concat2.cjs
//
//  只读原始产物；自己造的临时目录跑完删干净。
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const REPEAT = 3;

function say(s) { console.log(s); }

function findSegs() {
  const gen = path.join(ROOT, 'outputs', 'generate');
  if (!fs.existsSync(gen)) return null;
  let best = null;
  for (const name of fs.readdirSync(gen)) {
    const dir = path.join(gen, name);
    let st;
    try { st = fs.statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const segs = fs.readdirSync(dir).filter(f => /^seg.*\.wav$/i.test(f)).sort().map(f => path.join(dir, f));
    if (segs.length >= 2 && (!best || segs.length > best.segs.length)) best = { dir, segs };
  }
  return best;
}

function stats(list) {
  const s = list.slice().sort((a, b) => a - b);
  return { min: s[0], med: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
}

// prepare() 在计时之外跑（复制文件的钱不算进拼接的账）
async function timeIt(label, prepare, run) {
  const runs = [];
  for (let i = 0; i < REPEAT; i++) {
    const arg = prepare ? await prepare(i) : null;
    const t0 = process.hrtime.bigint();
    await run(arg, i);
    const t1 = process.hrtime.bigint();
    runs.push(Number(t1 - t0) / 1e9);
  }
  const st = stats(runs);
  say(`  ${label.padEnd(38)} ${st.med.toFixed(2)} 秒  (min ${st.min.toFixed(2)} / max ${st.max.toFixed(2)})`);
  return st;
}

(async () => {
  say('=== 拼接耗时拆账 · 第二刀 ' + new Date().toISOString().slice(0, 19).replace('T', ' ') + ' ===');
  say('仓库: ' + ROOT);

  const found = findSegs();
  if (!found) { say('⛔ outputs\\generate 下找不到带 seg*.wav 的目录 —— 先跑一次 measure-fullhit.ps1。'); process.exit(1); }
  say(`分段: ${found.segs.length} 个   来自 ${found.dir}`);

  const { concatWavFiles } = require(path.join(ROOT, 'lib', 'audio', 'concat.js'));
  const { checkFfmpeg, ffmpegCmd } = require(path.join(ROOT, 'lib', 'audio', 'ffmpeg.js'));
  if (!checkFfmpeg()) { say('⛔ 找不到 ffmpeg —— 产品会走纯 Node 兜底，量的不是要查的那条路。停。'); process.exit(1); }
  say('ffmpeg: ' + ffmpegCmd());

  const stamp = Date.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-cc2-'));
  const probeRoot = path.join(ROOT, 'outputs', '_concatprobe_' + stamp);
  fs.mkdirSync(probeRoot, { recursive: true });
  const madeDirs = [];

  const totalIn = found.segs.reduce((a, p) => a + fs.statSync(p).size, 0);
  say(`输入合计 ${(totalIn / 1048576).toFixed(1)} MB`);
  say('');
  say('── 计时（每项跑 ' + REPEAT + ' 次取中位数；复制的钱不计入）──');

  try {
    // P1：老段（热） → %TEMP%     ＝ 上一刀那个 0.22 的对照
    const p1 = await timeIt('P1 热输入 → %TEMP% 输出', null, async () => {
      await concatWavFiles(found.segs, path.join(tmp, 'p1.wav'), 300);
    });

    // P5：老段（热） → outputs\   ＝ 只改输出位置
    const p5 = await timeIt('P5 热输入 → outputs 输出', null, async (_a, i) => {
      await concatWavFiles(found.segs, path.join(probeRoot, `p5_${i}.wav`), 300);
    });

    // P4：刚复制出来的新段 → outputs\   ＝ 最接近 B 的条件
    const p4 = await timeIt('P4 新输入 → outputs 输出  ★', async (i) => {
      const d = path.join(probeRoot, `fresh_${i}`);
      fs.mkdirSync(d, { recursive: true });
      madeDirs.push(d);
      const copies = [];
      for (const src of found.segs) {
        const dst = path.join(d, path.basename(src));
        fs.copyFileSync(src, dst);
        copies.push(dst);
      }
      return copies;
    }, async (copies, i) => {
      await concatWavFiles(copies, path.join(probeRoot, `p4_${i}.wav`), 300);
    });

    say('');
    say('── 结账 ──────────────────────────────────');
    say(`  P5 - P1 = 换成往 outputs 里写的账   ${(p5.med - p1.med).toFixed(2)} 秒`);
    say(`  P4 - P5 = 输入换成刚落盘的新文件    ${(p4.med - p5.med).toFixed(2)} 秒`);
    say(`  P4      = 最接近 B 的那一刀         ${p4.med.toFixed(2)} 秒   （B - C 实测 1.40 秒）`);
    say('');
    say('  怎么读：');
    say('   · P4 追上 1.4 而 P1 还是 0.2 ⇒ 账在**新文件被另一个进程读**上（Defender 实时扫描/落盘），');
    say('     代码本身没毛病。该做的是给项目目录加排除项，或者干脆别让 ffmpeg 去读刚写的文件。');
    say('   · P5 就跳上去了 ⇒ 是**往项目目录写**慢，跟输入新旧无关。');
    say('   · 三条都还是 0.2 ⇒ 这 1.2 秒不在这段代码里。下一步去比 B 和 C 两次 meta.json，');
    say('     看哪个字段的产生要花掉这一秒。');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(probeRoot, { recursive: true, force: true }); } catch {}
    const left = fs.existsSync(probeRoot);
    say('');
    say(left ? '⚠ 临时目录没删干净: ' + probeRoot : '临时目录已清理。');
  }
})().catch(e => { console.error(e); process.exit(1); });
