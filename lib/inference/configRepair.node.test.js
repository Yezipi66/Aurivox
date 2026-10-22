'use strict';

/**
 * lib/inference/config_repair.py 的守卫：坏配置摆在盘上时它怎么判、要不要动盘。
 *
 * 探针只调 decide()，不写盘：测试不需要验证 shutil.copyfile 会不会复制。
 * 把各种坏配置摆到盘上，问 config_repair 怎么判，而不是检查文件里有没有某个词。
 *
 * 找不到 Python 解释器时整组 skip 并说明原因，不静默通过。
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
 * 选一个真的能按绝对路径跑起来的解释器。
 *
 * 判据是「起一次看退出码」，不是「文件存在」：venv 文件在而它的 base 解释器指向别处时，
 * 那个形状会一路走到 decide() 才炸，那时报错是 `uv trampoline failed to spawn`，
 * 看不出是「环境选错了」。
 *
 * 详见 `lib/util/pythonResolve.js` 的文件头（那里写着为什么判据必须是
 * 「按绝对路径能跑」而不是「能跑」：裸名字过不了路径运算）。
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
  // 一个确实存在的相对文件，供「健康配置」用例引用
  fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'models', 'ok.ckpt'), 'x', 'utf8');
  return { dir, live, example };
}

test('config_repair: 各类坏配置的判据与 PowerShell 原版一致', { skip: SKIP }, async (t) => {
  await t.test('模板存在、路径都在 -> 不动', () => {
    const c = makeCase([
      // 注：以 # 开头的行本来就过不了 key: value 的正则，所以 config_repair.py 里
      // 那句 continue 是保险而非承重，这里不假装在验它。
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
    // 这一条盯的是「相对写法的死路径」：只看长得像绝对路径的值，
    // 一份全是相对写法的死配置就会每次都被判成健康。
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
  // 这里断言的是「那段逻辑不许长回启动脚本」，所以查的是新主体 tools/cli/start.js：
  // 读一个已删除的文件只会得到 ENOENT，那个红说的是「文件没了」，不是这条守卫要说的事。
  // 必须剥掉注释再查：文件里有一段注释解释来历，那段恰恰是「逻辑被搬走了」的证据，
  // 守卫读到自己的说明书就会判自己不合格。
  // 规律：扫文本之前先问「注释会不会被算进去」。
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
  // 引擎侧确实接了这个活，这两行才是关键：没有它们，「不许在启动脚本里」
  // 可以靠把逻辑删掉来满足，而删掉的后果是引擎不再自修配置。
  const py = fs.readFileSync(path.join(__dirname, 'infer_server.py'), 'utf8')
  assert.ok(/from config_repair import repair/.test(py),
    'infer_server.py 没有引入 config_repair —— 那这段逻辑就是被删掉而不是搬走了')
  assert.ok(/_repair_engine_config\(config_path,/.test(py),
    'config_repair 被 import 了但没有人调用它')
});
