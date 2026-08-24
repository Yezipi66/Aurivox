'use strict';

/**
 * 突变验证: lib/inference/configRepair.node.test.js 里的守卫是不是真的能红。
 *
 * 用法: node tools/dev/mutate_config_repair.cjs
 *
 * 铁律 (记在 tools/dev/mutate_guards.py 同款):
 *   1. 先跑基线, 基线必须全绿, 否则后面全是噪音
 *   2. 每个锚点必须真的在文件里 grep 得到, 找不到就当场失败 (锚点漂了 = 突变没生效)
 *   3. 结果是 GREEN 时先怀疑突变本身写坏了, 而不是庆祝
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST = 'lib/inference/configRepair.node.test.js';
const PY = path.join(ROOT, 'lib', 'inference', 'config_repair.py');
const PS1 = path.join(ROOT, 'tools', 'scripts', 'start.ps1');
const SRV = path.join(ROOT, 'lib', 'inference', 'infer_server.py');

const MUTATIONS = [
  {
    name: '不再认「键名以 _path 结尾」-> 相对写法的死路径漏网',
    file: PY,
    from: '        is_path_key = key.endswith("_path")',
    to: '        is_path_key = False',
  },
  {
    name: '不再认「值长得像绝对路径」-> 非 _path 键的死路径漏网',
    file: PY,
    from: '        looks_absolute = bool(_ABSOLUTE_RE.match(value))',
    to: '        looks_absolute = bool(_ABSOLUTE_RE.match(value)) and False',
  },
  {
    name: '不再检查问号 -> GBK 写坏的路径漏网',
    file: PY,
    from: '        if "?" in value:',
    to: '        if False:',
  },
  {
    name: '不再剥引号 -> 带引号的健康配置被误判',
    file: PY,
    from: '    return value.strip().strip(\'"\').strip("\'")',
    to: '    return value.strip()',
  },
  {
    name: '空文件不再判 regen',
    file: PY,
    from: '    if content is None or not content.strip():',
    to: '    if False:',
  },
  {
    name: '⛔ 模板缺失时也敢重建 (会毁掉用户唯一一份配置)',
    file: PY,
    from: '        return (False, "template missing")',
    to: '        return (True, "template missing")',
  },
  {
    name: '活动配置缺失不再判 missing',
    file: PY,
    from: '        return (True, "missing")',
    to: '        return (False, "missing")',
  },
  {
    name: 'Repair-EngineConfig 又长回 start.ps1',
    file: PS1,
    from: '# 2. Inference engine',
    to: 'function Repair-EngineConfig {\n  $needsRegen = $false\n}\n\n# 2. Inference engine',
  },
  {
    name: 'infer_server.py 不再 import config_repair (等于把逻辑删了而非搬走)',
    file: SRV,
    from: 'from config_repair import repair as _repair_engine_config',
    to: 'from config_repair import decide as _repair_engine_config',
  },
  {
    name: 'import 了却没人调用',
    file: SRV,
    from: '_repair_engine_config(config_path, config_path + ".example", PROJECT_ROOT)',
    to: 'pass  # _repair_engine_config not called',
  },
];

function runTest() {
  const res = spawnSync(process.execPath, ['--test', TEST], {
    cwd: ROOT, encoding: 'utf8',
  });
  return res.status === 0;
}

function main() {
  process.stdout.write('=== 基线 ===\n');
  if (!runTest()) {
    process.stdout.write('基线就是红的, 先修基线。\n');
    process.exit(1);
  }
  process.stdout.write('基线 GREEN\n\n');

  let red = 0;
  for (const m of MUTATIONS) {
    const original = fs.readFileSync(m.file, 'utf8');
    if (!original.includes(m.from)) {
      process.stdout.write(`ANCHOR-LOST  ${m.name}\n             锚点在 ${path.relative(ROOT, m.file)} 里找不到\n`);
      process.exitCode = 1;
      continue;
    }
    fs.writeFileSync(m.file, original.replace(m.from, m.to), 'utf8');
    let ok;
    try {
      ok = runTest();
    } finally {
      fs.writeFileSync(m.file, original, 'utf8');
    }
    if (ok) {
      process.stdout.write(`GREEN(坏)    ${m.name}\n`);
      process.exitCode = 1;
    } else {
      red += 1;
      process.stdout.write(`RED          ${m.name}\n`);
    }
  }

  process.stdout.write(`\n${red}/${MUTATIONS.length} 条突变被抓到\n`);
  if (!runTest()) {
    process.stdout.write('⛔ 还原后基线不再是绿的, 文件可能被写坏了, 立刻 git diff 检查\n');
    process.exitCode = 1;
  }
}

main();
