'use strict';

/**
 * lib/inference/config_repair.py 的守卫。
 *
 * ⭐ 为什么这条测试要真的去 spawn 一个 Python
 * -------------------------------------------
 * 这段逻辑是从 start.ps1 的 Repair-EngineConfig 搬过来的, 搬家最容易出的事
 * 就是"看着一样、判据悄悄少了一条"。仓库里的 Python 侧至今没有任何测试覆盖
 * (契约 §8 记着这笔账: JS 测试全绿但引擎起不来)。所以这里不写"文件里有没有
 * 这个词"的弱守卫, 而是**真的把各种坏配置摆到盘上, 问 config_repair 你怎么判**。
 *
 * ⛔ 探针只调 decide(), 不写盘 —— 测试不需要验证 shutil.copyfile 会不会复制。
 *
 * 找不到 Python 解释器时整组 skip 并说明原因, 不静默通过。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { firstWorkingPython, projectPythonCandidates } = require('../util/pythonResolve');

const MODULE_PATH = path.join(__dirname, 'config_repair.py');
const readStartBody = () => fs.readFileSync(
  path.join(PROJECT_ROOT, 'tools', 'cli', 'start.js'), 'utf8')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * ⭐ 选一个**真的能按绝对路径跑起来**的解释器。
 *
 * ⚠️ 2026-10-04（A15）：判据从「文件存在」换成「起一次看退出码」。
 * 从前是 `fs.existsSync(c)` —— 而 venv 的文件**在**，只是它的 base 解释器
 * 指向另一台机器（项目搬过机器的典型形状）。那个形状会一路走到
 * `decide()` 才炸，而那时候报错是 `uv trampoline failed to spawn`，
 * **看不出「是环境选错了」**。
 *
 * 详见 `lib/util/pythonResolve.js` 的文件头（那里写着为什么判据必须
 * 是「按绝对路径能跑」而不是「能跑」—— 裸名字过不了路径运算）。
 */
function findPython() {
  return firstWorkingPython(projectPythonCandidates(PROJECT_ROOT));
}

const PYTHON = findPython();
const SKIP = PYTHON ? false : '找不到可用的 Python 解释器（根 venv / 内嵌 runtime / PATH 都试过了），无法驱动 config_repair.py';

function decide(liveCfg, exampleCfg, root) {
  const res = spawnSync(
    PYTHON,
    [MODULE_PATH, '--live', liveCfg, '--example', exampleCfg, '--root', root || ''],
    { encoding: 'utf8' },
  );
  assert.strictEqual(res.status, 0, `探针非零退出:\n${res.stderr || ''}`);
  return JSON.parse(res.stdout);
}

/** 造一个临时盘面: 返回 { dir, live, example, realFile }。 */
function makeCase(liveContent, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgrepair-'));
  const live = path.join(dir, 'tts_infer.yaml');
  const example = path.join(dir, 'tts_infer.yaml.example');
  if (opts.withExample !== false) fs.writeFileSync(example, 'version: v2\n', 'utf8');
  if (liveContent !== null) fs.writeFileSync(live, liveContent, 'utf8');
  // 一个确实存在的相对文件, 供"健康配置"用例引用
  fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'models', 'ok.ckpt'), 'x', 'utf8');
  return { dir, live, example };
}

test('config_repair: 各类坏配置的判据与 PowerShell 原版一致', { skip: SKIP }, async (t) => {
  await t.test('模板存在、路径都在 -> 不动', () => {
    const c = makeCase([
      // 注: `# 开头的行` 本来也过不了 key: value 的正则, 所以 config_repair.py 里
      // 那句 continue 是保险而非承重 —— 这里不假装在验它。
      '# comment',
      'device: cuda',
      'version: v2',
      't2s_weights_path: ./models/ok.ckpt',
    ].join('\n'));
    const r = decide(c.live, c.example, c.dir);
    assert.strictEqual(r.needs_regen, false, `不该重建, 实得 reason=${r.reason}`);
  });

  await t.test('活动配置缺失 -> missing', () => {
    const c = makeCase(null);
    assert.deepStrictEqual(decide(c.live, c.example, c.dir), {
      needs_regen: true,
      reason: 'missing',
    });
  });

  await t.test('活动配置只有空白 -> empty or unreadable', () => {
    const c = makeCase('   \n\n\t\n');
    assert.deepStrictEqual(decide(c.live, c.example, c.dir), {
      needs_regen: true,
      reason: 'empty or unreadable',
    });
  });

  await t.test('值里带问号 (GBK 控制台写坏的中文路径) -> mangled', () => {
    const c = makeCase('t2s_weights_path: D:\\??????\\s1.ckpt\n');
    const r = decide(c.live, c.example, c.dir);
    assert.strictEqual(r.needs_regen, true);
    assert.match(r.reason, /^mangled path: /);
  });

  await t.test('⭐ 相对写法的死路径也要抓 (键名以 _path 结尾)', () => {
    // 这条是 PowerShell 版本注释里记着的教训: 早期只看"长得像绝对路径"的值,
    // 于是一份全是相对写法的死配置每次都被判成健康。
    const c = makeCase('vits_weights_path: ./models/gone.pth\n');
    const r = decide(c.live, c.example, c.dir);
    assert.strictEqual(r.needs_regen, true, '相对写法的死路径被漏掉了');
    assert.match(r.reason, /^stale path: /);
  });

  await t.test('搬家后残留的旧绝对路径 -> stale', () => {
    const c = makeCase('bert_base: D:\\no\\such\\place\\bert\n');
    const r = decide(c.live, c.example, c.dir);
    assert.strictEqual(r.needs_regen, true, '键名不以 _path 结尾时, 绝对路径这条判据没生效');
    assert.match(r.reason, /^stale path: /);
  });

  await t.test('带引号的值要先剥引号再探测', () => {
    const ok = makeCase('t2s_weights_path: "./models/ok.ckpt"\n');
    assert.strictEqual(decide(ok.live, ok.example, ok.dir).needs_regen, false,
      '引号没剥干净, 健康配置被误判');
    const bad = makeCase("t2s_weights_path: './models/gone.pth'\n");
    assert.strictEqual(decide(bad.live, bad.example, bad.dir).needs_regen, true);
  });

  await t.test('⛔ 模板不存在时绝不重建 (没有可回退的东西)', () => {
    const c = makeCase('t2s_weights_path: ./models/gone.pth\n', { withExample: false });
    const r = decide(c.live, c.example, c.dir);
    assert.strictEqual(r.needs_regen, false, '没有模板还敢判重建, 会把用户唯一一份配置备份掉');
    assert.strictEqual(r.reason, 'template missing');
  });

  await t.test('非路径键不参与探测 (device/version 不是文件)', () => {
    const c = makeCase('device: cuda\nis_half: true\nversion: v2\n');
    assert.strictEqual(decide(c.live, c.example, c.dir).needs_regen, false);
  });
});

test('启动脚本不再自己修引擎配置', () => {
  // ⚠️ 2026-10-05：原来这条读 tools/scripts/start.ps1 并断言「老实现的判据
  //   变量不在里面」。那个文件已删除（主体搬到 tools/cli/start.js），
  //   而读一个不存在的文件只会得到 ENOENT —— 那个红说的是「文件没了」，
  //   不是这条守卫想说的事（「那段逻辑不许长回启动脚本」）。
  // ⇒ 改成对**新主体**断同一件事：新主体里不许出现那套判据变量。
  // ⚠️⛔ 必须**剥掉注释**再查 —— 这条守卫今天已经栽过一次：
  //   tools/cli/start.js 里有一段注释**解释来历**，写的就是
  //   「这里原先有一个 76 行的 Repair-EngineConfig … 已搬进 config_repair.py」。
  //   而那是**文档**：它恰恰是「这段逻辑被搬走了」的证据。
  //   ⭐ 本项目已经为「文本扫描撞注释」栽过四次（守卫按文件存在判、
  //     守卫静默 skip、engine_online 扫到 JSDoc、现在这条）。
  //     规律：**扫文本之前先问「注释会不会被算进去」。**
  const src = readStartBody()
    .split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  for (const gone of ['needsRegen', 'Repair-EngineConfig', 'config_repair']) {
    assert.ok(!src.includes(gone),
      `tools/cli/start.js 里出现了 ${gone} —— 引擎配置的自检自修已经整块搬进`
      + ' lib/inference/config_repair.py，由引擎自己调。谁起这个进程都一样修，'
      + '启动脚本里不该再有引擎特例。')
  }
  // ⭐⭐ 而**引擎侧确实接了这个活** —— 原来这条守卫有这两行，
  //   我第一版改写时漏了。它们才是关键：没有它们，「不许在启动脚本里」
  //   可以靠**把逻辑删掉**来满足，而删掉的后果是引擎不再自修配置。
  const py = fs.readFileSync(path.join(__dirname, 'infer_server.py'), 'utf8')
  assert.ok(/from config_repair import repair/.test(py),
    'infer_server.py 没有引入 config_repair —— 那这段逻辑就是被删掉而不是搬走了')
  assert.ok(/_repair_engine_config\(config_path,/.test(py),
    'config_repair 被 import 了但没有人调用它')
});
