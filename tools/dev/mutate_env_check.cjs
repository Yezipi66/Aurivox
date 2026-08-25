'use strict';

/**
 * 突变验证: 第一道校验（引擎装没装）的守卫是不是真的能红。
 *
 * 用法: node tools/dev/mutate_env_check.cjs
 *
 * 铁律（和 mutate_config_repair.cjs 同款）:
 *   1. 先跑基线, 基线必须全绿, 否则后面全是噪音
 *   2. 每个锚点必须真的在文件里 grep 得到, 找不到就当场失败（锚点漂了 = 突变没生效）
 *   3. 结果是 GREEN 时先怀疑突变本身写坏了, 而不是庆祝
 *
 * ⚠ 沙箱里源码目录可能是只读的, 跑之前先 cp -r 到可写目录再在副本里跑。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TESTS = [
  'lib/engines/envCheck.node.test.js',
  'lib/engines/profile.node.test.js',
  'lib/engines/realManifests.node.test.js',
];
const CHECK = path.join(ROOT, 'lib', 'engines', 'envCheck.js');
const PROBE = path.join(ROOT, 'lib', 'engines', 'env_probe.py');
const PROFILE = path.join(ROOT, 'lib', 'engines', 'profile.js');
const MF_IDX = path.join(ROOT, 'engines', 'indextts2', 'manifest.json');
const MF_GSV = path.join(ROOT, 'engines', 'gpt-sovits', 'manifest.json');
const T_ENV = path.join(ROOT, 'lib', 'engines', 'envCheck.node.test.js');

const MUTATIONS = [
  // --- 浅层：查盘 --------------------------------------------------------
  {
    name: '解释器不在也判「装了」',
    file: CHECK,
    from: '  if (!exists(p.python)) {',
    to: '  if (false) {',
  },
  {
    name: '入口脚本不在也判「装了」',
    file: CHECK,
    from: '  if (!exists(p.entry)) {',
    to: '  if (false) {',
  },
  // --- 权重轴：和「装没装」分开的那根 ------------------------------------
  // ⛔⛔ 这几条是真机打回来补的：权重缺原先被算进 ok，于是 indextts2 的
  //   .venv 明明在盘上却显示「没装」，而且深层校验被浅层挡下、根本没跑。
  {
    name: '权重不在也放行（assets 永远绿）',
    file: CHECK,
    from: "  if (exists(p.checkpoints)) { out.ok = true; return out }",
    to: "  { out.ok = true; return out }",
  },
  {
    name: '⛔ 权重缺重新折回 ok（真机上那个 bug 本身）',
    file: CHECK,
    from: '  result.assets = checkAssets(profile, p, exists)',
    to: '  result.assets = checkAssets(profile, p, exists)\n' +
        '  result.problems.push(...result.assets.problems)',
  },
  {
    name: '⛔ 没声明 checkpoints 时 assets 报成「通过」',
    file: CHECK,
    from: "  if (!p || !p.checkpoints) return out   // 没声明 ⇒ 无从判断，不是通过",
    to: "  if (!p || !p.checkpoints) { out.ok = true; return out }",
  },
  {
    name: '深层报告把权重轴丢掉',
    file: CHECK,
    from: '  result.assets = shallow.assets\n\n  let proc',
    to: '\n  let proc',
  },
  {
    // ⭐ 这条突变改的是**测试文件自己** —— 被验的守卫也长在那里。
    //   真机上整组测试就是被 symlink 的 EPERM 打挂的，靠 review 记不住，
    //   得有一条会红的守卫替我记住。
    name: '⛔ 测试里重新用上 symlink（Windows 非管理员会 EPERM）',
    file: T_ENV,
    from: 'function pythonRef(root) {',
    to: 'function pythonRef(root) {\n  if (global.__never_true) fs.symlinkSync(PYTHON, root)',
  },
  {
    name: '⛔ entry 改成按项目根解析（会指到别的引擎目录里去）',
    file: CHECK,
    from: '    entry: path.resolve(profile.dir, rt.entry),',
    to: '    entry: path.resolve(rootDir, rt.entry),',
  },
  {
    name: '⛔ python 改成按名片目录解析',
    file: CHECK,
    from: '    python: path.resolve(rootDir, rt.python),',
    to: '    python: path.resolve(profile.dir, rt.python),',
  },
  {
    name: '⛔ 没有 runtime 时报「装了」（一张空名片显示成一切正常）',
    file: CHECK,
    from: '    result.ok = null\n    result.unmanaged = true',
    to: '    result.ok = true\n    result.unmanaged = true',
  },
  {
    name: '⛔ 有 runtime 没 verify 时报「装了」',
    file: CHECK,
    from: "    const r = makeResult(profile.id, { level: 'deep', ok: null, unverifiable: true })",
    to: "    const r = makeResult(profile.id, { level: 'deep', ok: true, unverifiable: true })",
  },
  {
    name: '浅层不过也照样起一次进程',
    file: CHECK,
    from: '  if (shallow.ok !== true) return shallow',
    to: '  if (false) return shallow',
  },
  {
    name: '⛔ 探针说没装, envCheck 却报装了',
    file: CHECK,
    from: '  result.ok = result.problems.length === 0 && payload.ok === true',
    to: '  result.ok = true',
  },
  {
    name: 'sys_path 不再传给探针（GSV 会 import 不了 TTS）',
    file: CHECK,
    from: '  const spec = { sys_path: p.sys_path, imports: rt.verify.imports }',
    to: '  const spec = { sys_path: [], imports: rt.verify.imports }',
  },
  // --- 探针 ---------------------------------------------------------------
  {
    name: '探针不再把 sys_path 塞进 sys.path',
    file: PROBE,
    from: '    for entry in spec.get("sys_path") or []:',
    to: '    for entry in []:',
  },
  {
    name: '探针不再检查方法在不在',
    file: PROBE,
    from: '    for name in item.get("methods") or []:',
    to: '    for name in []:',
  },
  {
    name: '⛔ 探针把「没装」报成非零退出（调用方会分不清"没装"和"探针崩了"）',
    file: PROBE,
    from: '    sys.stdout.write(json.dumps(run(spec), ensure_ascii=False))\n    return 0',
    to: '    result = run(spec)\n    sys.stdout.write(json.dumps(result, ensure_ascii=False))\n    return 0 if result["ok"] else 3',
  },
  {
    name: '探针 import 失败时也报 ok',
    file: PROBE,
    from: '        result["missing"].append("module:%s" % module_name)\n        return result',
    to: '        result["ok"] = True\n        return result',
  },
  {
    name: '⛔ 探针 import 了第三方包（它要在任意引擎的 venv 里跑）',
    file: PROBE,
    from: 'import json\nimport sys',
    to: 'import json\nimport sys\nimport numpy',
  },
  // --- 名片解析 -----------------------------------------------------------
  {
    name: 'runtime 里不认识的键被静默忽略（ready_endoint 拼错漏网）',
    file: PROFILE,
    from: '    if (!RUNTIME_KEYS.includes(k)) {',
    to: '    if (false) {',
  },
  {
    name: 'runtime 缺字段时回落成空串而不是抛',
    file: PROFILE,
    from: "  const python = relPath(manifest, 'runtime.python',\n    required(manifest, 'runtime.python', r.python,",
    to: "  const python = relPath(manifest, 'runtime.python',\n    (r.python || 'x/y',\n     required(manifest, 'runtime.python', r.python || 'x/y',",
    close: true,
  },
  {
    name: '绝对路径被放行（名片就只在作者那台机器上成立了）',
    file: PROFILE,
    from: '  if (/^([A-Za-z]:[\\\\/]|[\\\\/])/.test(value)) {',
    to: '  if (false) {',
  },
  {
    name: 'ready_endpoint 不再要求以 / 开头',
    file: PROFILE,
    from: "  if (typeof readyEndpoint !== 'string' || !readyEndpoint.startsWith('/')) {",
    to: '  if (false) {',
  },
  {
    name: 'verify 写了却没 imports 时不再抛（显示成"校验通过"）',
    file: PROFILE,
    from: '  if (!Array.isArray(rawImports) || rawImports.length === 0) {',
    to: '  if (false) {',
  },
  {
    name: 'verify.imports 上不认识的键被静默忽略（method 少个 s 漏网）',
    file: PROFILE,
    from: '      if (!VERIFY_IMPORT_KEYS.includes(k)) {',
    to: '      if (false) {',
  },
  {
    name: 'methods/init_params 没有 class 也放行（"要检查 infer" 变成空话）',
    file: PROFILE,
    from: '    if (!cls && (methods.length || initParams.length)) {',
    to: '    if (false) {',
  },
  {
    name: 'preload 缺省变成 true',
    file: PROFILE,
    from: '    preload: r.preload === true,',
    to: '    preload: r.preload !== false,',
  },
  // --- 真名片 -------------------------------------------------------------
  {
    name: 'GSV 名片的 ready_endpoint 被照着 IndexTTS2 抄成 /healthz',
    file: MF_GSV,
    from: '"ready_endpoint": "/",',
    to: '"ready_endpoint": "/healthz",',
  },
  {
    name: 'GSV 名片的 runtime 又变回 null（进程知识退回启动脚本）',
    file: MF_GSV,
    from: '  "runtime": {\n    "python": "venv/Scripts/python.exe",',
    to: '  "runtime_disabled": {\n    "python": "venv/Scripts/python.exe",',
  },
  {
    name: '名片里的路径写成反斜杠（非 Windows 上会被当成文件名的一部分）',
    file: MF_IDX,
    from: '"python": "engines/indextts2/.venv/Scripts/python.exe"',
    to: '"python": "engines\\\\indextts2\\\\.venv\\\\Scripts\\\\python.exe"',
  },
];

// ---------------------------------------------------------------------------
//  只有真机能抓的那一类
// ---------------------------------------------------------------------------
// ⭐ "路径少一个点"这种错，CI 上抓不到 —— CI 上没有任何引擎的 venv，
//    对它来说改前改后都是"文件不存在"。这不是守卫是摆设，是**这个问题本身
//    就是机器状态问题**，只有装了环境的那台机器能回答。
//
// ⛔ 所以不能把它塞进上面那张表然后接受一个 GREEN（那才是自欺）。
//    它单独走 check-engine-env.cjs：先看基线上这台引擎是不是"装了"，
//    是，才有资格做这条突变（并要求它翻成"没装"）；
//    不是，就 SKIP 并**说明原因**，让读输出的人知道这条没被验过。
const MACHINE_ONLY = [
  {
    name: '⭐ indextts2 的 .venv 又写回 venv（这道校验存在的全部理由）',
    engine: 'indextts2',
    file: MF_IDX,
    from: '"python": "engines/indextts2/.venv/Scripts/python.exe"',
    to: '"python": "engines/indextts2/venv/Scripts/python.exe"',
  },
];

function cliSaysInstalled(engineId) {
  const res = spawnSync(process.execPath,
    [path.join(ROOT, 'tools', 'dev', 'check-engine-env.cjs'), '--engine', engineId, '--json'],
    { cwd: ROOT, encoding: 'utf8' });
  try {
    return JSON.parse(res.stdout).results[0].ok === true;
  } catch {
    return false;
  }
}

function runMachineOnly() {
  process.stdout.write('\n=== 只有真机能抓的（走 check-engine-env.cjs，不走测试）===\n');
  for (const m of MACHINE_ONLY) {
    if (!cliSaysInstalled(m.engine)) {
      process.stdout.write(`SKIP         ${m.name}\n` +
        `             这台机器上 ${m.engine} 本来就报"没装"，突变前后都是没装，验不出东西。\n` +
        `             要验这条，请在装好 ${m.engine} 环境的机器上跑。\n`);
      continue;
    }
    const original = fs.readFileSync(m.file, 'utf8');
    if (!original.includes(m.from)) {
      process.stdout.write(`ANCHOR-LOST  ${m.name}\n`);
      process.exitCode = 1;
      continue;
    }
    fs.writeFileSync(m.file, original.replace(m.from, m.to), 'utf8');
    let stillInstalled;
    try {
      stillInstalled = cliSaysInstalled(m.engine);
    } finally {
      fs.writeFileSync(m.file, original, 'utf8');
    }
    if (stillInstalled) {
      process.stdout.write(`GREEN(坏)    ${m.name}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`RED          ${m.name}\n`);
    }
  }
}

function runTests() {
  for (const t of TESTS) {
    const res = spawnSync(process.execPath, ['--test', t], { cwd: ROOT, encoding: 'utf8' });
    if (res.status !== 0) return false;
  }
  return true;
}

function main() {
  process.stdout.write('=== 基线 ===\n');
  if (!runTests()) {
    process.stdout.write('基线就是红的, 先修基线。\n');
    process.exit(1);
  }
  process.stdout.write('基线 GREEN\n\n');

  let red = 0;
  let counted = 0;
  for (const m of MUTATIONS) {
    const original = fs.readFileSync(m.file, 'utf8');
    if (!original.includes(m.from)) {
      process.stdout.write(`ANCHOR-LOST  ${m.name}\n             锚点在 ${path.relative(ROOT, m.file)} 里找不到\n`);
      process.exitCode = 1;
      continue;
    }
    counted += 1;
    fs.writeFileSync(m.file, original.replace(m.from, m.to), 'utf8');
    let ok;
    try {
      ok = runTests();
    } finally {
      fs.writeFileSync(m.file, original, 'utf8');
    }
    if (ok) {
      // ⚠ GREEN 的第一嫌疑人永远是突变本身写坏了（锚点匹配到了但改出来的
      //   代码语义没变），第二才是守卫是摆设。两个都要看，别只看后者。
      process.stdout.write(`GREEN(坏)    ${m.name}\n`);
      process.exitCode = 1;
    } else {
      red += 1;
      process.stdout.write(`RED          ${m.name}\n`);
    }
  }

  process.stdout.write(`\n${red}/${counted} 条突变被抓到\n`);

  runMachineOnly();

  if (!runTests()) {
    process.stdout.write('⛔ 还原后基线不再是绿的, 文件可能被写坏了, 立刻 git diff 检查\n');
    process.exitCode = 1;
  }
}

main();
