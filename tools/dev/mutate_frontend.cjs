#!/usr/bin/env node
// ============================================================
//  突变验证：前端 force_resynth 那条文本守卫真的守得住吗？
// ============================================================
//
// 文本守卫最容易写成「摆设」—— 断言一个恒真的东西，看着绿，其实什么都没盯。
// 这个脚本挨个把守卫应该拦住的错误真的做进源码，然后看测试是不是真的红。
//
// 用法（在仓库根）：
//   node tools/dev/mutate_frontend.cjs
// 默认复制一份到临时目录再改，绝不动工作区；MUTATE_IN_PLACE=1 可就地跑。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC_ROOT = path.resolve(__dirname, '..', '..');
const IN_PLACE = process.env.MUTATE_IN_PLACE === '1';

let ROOT = SRC_ROOT;
if (!IN_PLACE) {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-fe-'));
  for (const entry of ['web', 'package.json']) {
    const from = path.join(SRC_ROOT, entry);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(ROOT, entry), { recursive: true });
  }
}

const JSX = path.join(ROOT, 'web', 'src', 'components', 'generate', 'GenerateTab.jsx');
const TEST = path.join(ROOT, 'web', 'src', 'components', 'generate', 'advancedParamsMemory.node.test.js');

const MUTANTS = [
  {
    name: '① 把 force_resynth 混进引擎参数表（/api/advanced-params 的 body）',
    find: 'body: {',
    to: 'body: { force_resynth: forceResynth,',
  },
  {
    name: '② 持久化换成普通 useState —— 刷新页面就忘了用户上次的选择',
    find: "usePersistentState('generate.forceResynth', false)",
    to: 'useState(false)',
  },
  {
    name: '③ 开关没进请求体 —— 界面勾了，服务端根本收不到',
    find: '      force_resynth: forceResynth,\n',
    to: '',
  },
  {
    name: '④ 请求体里写死 false —— 勾了也没用',
    find: 'force_resynth: forceResynth,',
    to: 'force_resynth: false,',
  },
];

function runTest() {
  try {
    execFileSync(process.execPath, ['--test', TEST], {
      cwd: ROOT,
      stdio: 'pipe',
      env: { ...process.env, TMPDIR: os.tmpdir() },
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

const ORIGINAL = fs.readFileSync(JSX, 'utf-8');

// 先确认干净状态是绿的，否则后面全部结论都不成立。
const baseline = runTest();
if (!baseline.ok) {
  console.error('⛔ 未突变时就是红的，先修好再跑这个脚本：\n' + baseline.out);
  process.exit(1);
}
console.log('基线：GREEN ✔\n');

let red = 0;
let green = 0;
let broken = 0;

for (const m of MUTANTS) {
  if (!ORIGINAL.includes(m.find)) {
    console.log(`⚠ 锚点坏  ${m.name}\n         找不到：${JSON.stringify(m.find.slice(0, 60))}`);
    broken += 1;
    continue;
  }
  fs.writeFileSync(JSX, ORIGINAL.replace(m.find, m.to), 'utf-8');
  const r = runTest();
  fs.writeFileSync(JSX, ORIGINAL, 'utf-8');
  if (r.ok) {
    console.log(`✖ GREEN  ${m.name}   ← 守卫没盯住这个错误`);
    green += 1;
  } else {
    console.log(`✔ RED    ${m.name}`);
    red += 1;
  }
}

console.log(`\nRED ${red} / GREEN ${green} / 锚点坏 ${broken}`);
if (!IN_PLACE) console.log(`（改的是副本：${ROOT}）`);
process.exit(green === 0 && broken === 0 ? 0 : 1);
