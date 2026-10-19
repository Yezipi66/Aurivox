'use strict';

// ============================================================
//  全仓注释纪律守卫
// ============================================================
//
//  注释只解释文件本身、代码块、代码行：这段在做什么、为什么这样实现、
//  什么输入会让它坏。四类归属性内容不进代码注释：现场经过、归属叙述、
//  纪律宣告、情绪标记。
//
//  判据与 tools/engine-wizard/test/styleguard.node.test.js 里那一组正则一致。
//  那条守卫只守 wizard 子树（且带一份只许变小的历史台账），本文件把同一组
//  判据铺到 lib/、web/src/、tools/、server.js、pipeline/，并且只认「零」。
//
//  范围与排除：
//    扫 lib/、web/src/、tools/、server.js、pipeline/。
//    不扫 engines/ 与 cache/（第三方源码与运行期产物），以及
//    node_modules/、.venv/、.staging/、dist/、tools/dev/、tools/runtime/。
//    注意 lib/engines/ 与 lib/cache/ 是本项目自己的代码，在扫描范围内。
//
//  抽取交给 @babel/parser（项目前端校验用的就是它，与 styleguard 同源）。
//  手写逐字符状态机会把正则字面量当成字符串起点，两个引号之间整段吞掉，
//  漏扫会表现成「零违规」的假象。拿不到解析器、或某个文件解析失败，
//  本文件一律报错：宁可红，不可静默通过。
// ============================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_ROOTS = ['lib', 'web/src', 'tools', 'server.js', 'pipeline'];
const SCAN_EXTS = new Set(['.js', '.jsx', '.cjs', '.mjs']);
// 只按「仓库根相对路径」判排除。写成前缀目录名的形式，所以
// lib/engines、lib/cache 不会被 engines、cache 这两条误伤。
const SKIP_RELS = [
  'node_modules', '__pycache__', '.git', '.venv', '.staging', 'dist',
  'engines', 'cache', 'tools/dev', 'tools/runtime',
];
// 扫描文件数下限：范围写错（例如某个根目录不存在）时不许安静地报零违规。
const MIN_SCANNED_FILES = 300;

const DATE_FORM_RE = /\b\d{4}-\d{2}-\d{2}\b/;
const ATTRIBUTION_WORDS = ['Owner', '亲自', '前任', '裁决', '裁定'];
const SCENE_WORDS = ['实测', '试错', '报障', '踩过', '踩到', '曾经', '一度', '上一版', '今晚'];
const EMPHASIS_SYMBOL_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

// 一条注释行的判据。return 空数组即合规。
function reasonsOf(body) {
  const r = [];
  if (DATE_FORM_RE.test(body)) r.push('日期体');
  for (const w of ATTRIBUTION_WORDS) if (body.includes(w)) r.push('归属:' + w);
  for (const w of SCENE_WORDS) if (body.includes(w)) r.push('现场:' + w);
  if (EMPHASIS_SYMBOL_RE.test(body)) r.push('符号');
  // 中文双破折号：注释里没有它存在的理由。英文单破折号是正确标点，不判。
  if (body.includes('\u2014\u2014')) r.push('破折号');
  return r;
}

// 解析器必须在仓库里解析到。解析不到就报错，不退回手写抽取：那种抽取会漏，
// 而漏抽和「没有违规」在输出上长得一模一样。
function loadParser() {
  try {
    return require(require.resolve('@babel/parser', { paths: [path.join(ROOT, 'web'), ROOT] })).parse;
  } catch (e) {
    throw new Error(`拿不到 @babel/parser，注释守卫无法抽取注释：${e.message}`);
  }
}

// parse 失败必须带着文件名与错误原文炸出来，静默跳过等于把问题记成零违规。
function parseSource(rel, src) {
  const parse = loadParser();
  let last = null;
  for (const opts of [
    { sourceType: 'unambiguous', plugins: ['jsx'] },
    { sourceType: 'module', plugins: ['jsx'] },
    { sourceType: 'script', plugins: ['jsx'] },
  ]) {
    try { return parse(src, opts); } catch (e) { last = e; }
  }
  throw new Error(`babel 解析失败 ${rel}: ${String(last && last.message).split('\n')[0]}`);
}

// 注释节点按 loc 逐行展开成 body。行号取 loc.start.line，与「定位到源码行」对齐。
function commentBodies(rel, src) {
  const ast = parseSource(rel, src);
  const comments = ast.comments || [];
  const out = [];
  comments.forEach((c, idx) => {
    const start = c.loc.start.line;
    const span = c.loc.end.line - start + 1;
    const lines = String(c.value == null ? '' : c.value).split('\n');
    for (let k = 0; k < span; k++) {
      const seg = k < lines.length ? lines[k] : '';
      out.push({
        node: idx,
        line: start + k,
        body: seg.replace(/^\s*\*\/?/, '').replace(/^\/\*/, ''),
      });
    }
  });
  return out;
}

function collectFiles(p, out) {
  let st;
  try { st = fs.statSync(p); } catch { throw new Error(`扫描根不存在：${p}`); }
  if (st.isFile()) {
    if (SCAN_EXTS.has(path.extname(p))) out.push(p);
    return out;
  }
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, e.name);
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    if (SKIP_RELS.some((s) => rel === s || rel.startsWith(s + '/'))) continue;
    if (e.isDirectory()) collectFiles(full, out);
    else if (SCAN_EXTS.has(path.extname(e.name)) && !e.name.endsWith('.bak')) out.push(full);
  }
  return out;
}

function scannedFiles() {
  const files = [];
  for (const r of SCAN_ROOTS) collectFiles(path.join(ROOT, r), files);
  return files;
}

// 逐文件扫一遍，返回 { 文件数, 命中行: [{rel, line, reasons}] }
function scanAll() {
  const files = scannedFiles();
  const hits = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    for (const c of commentBodies(rel, fs.readFileSync(f, 'utf8'))) {
      const r = reasonsOf(c.body);
      if (r.length) hits.push({ rel, line: c.line, reasons: r.join(' '), body: c.body.trim() });
    }
  }
  return { fileCount: files.length, hits };
}

// ------------------------------------------------------------
//  ① 判据自身有效：五类违规各判得出来，正常技术注释不误判
//
//  这一段是防「判据被改坏」。正则被清空、词表被删空时，
//  上面那条零违规断言会照绿，而它绿的理由是判据失效，不是注释干净。
// ------------------------------------------------------------
test('注释纪律判据自身有效：五类违规各能判出，技术注释不误判', () => {
  const mustHit = [
    ['现场经过', '引擎没启动时平台不返回错误信息' + ['', '实测', '撞到过'].join(''), '现场'],
    ['归属叙述', ['Own', 'er 说这里不返回错误'].join(''), '归属'],
    ['日期体', ['2024', '01', '02'].join('-') + ' 起这条路径不再有人走', '日期体'],
    ['强调符号', '由 ' + String.fromCodePoint(0x26D4) + ' 标出的必填项', '符号'],
    ['破折号', 'A' + String.fromCharCode(0x2014, 0x2014) + 'B', '破折号'],
  ];
  for (const [name, sample, expect] of mustHit) {
    const r = reasonsOf(sample);
    assert.ok(r.some((x) => x.includes(expect)),
      `判据漏判（${name}）：${JSON.stringify(sample)} 只判出 ${JSON.stringify(r)}`);
  }
  // 反向：正常的技术注释一条都不该判出来。
  const clean = [
    '引擎未启动时平台不返回错误信息，界面因此只显示一次通用失败',
    '这里按绝对路径起一次解释器，裸名字一律判否',
    '目录在进程活着的时候会消失，所以每次都要重新确认',
    '两档都画，不是只画 common 一层',
    '路径拼接归 clone.js，前端不算路径',
  ];
  for (const s of clean) {
    assert.deepStrictEqual(reasonsOf(s), [], `判据误判正常注释：${s}`);
  }
});

// ------------------------------------------------------------
//  ② 解析器与文件数下限：拿不到解析器、某个文件解析失败、
//     范围写错只扫到极少文件，三种退化都在这里炸出来。
// ------------------------------------------------------------
test('注释抽取：全范围文件解析成功且扫描范围未退化', () => {
  const files = scannedFiles();
  assert.ok(files.length >= MIN_SCANNED_FILES,
    `只扫到 ${files.length} 个文件（下限 ${MIN_SCANNED_FILES}）：扫描范围写错了，这个数字不是「零违规」`);
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    // commentBodies 内部：loadParser 拿不到 → 抛错；parseSource 解析失败 → 抛错
    commentBodies(rel, fs.readFileSync(f, 'utf8'));
  }
});

// ------------------------------------------------------------
//  ③ 全仓注释纪律：违规 0 处
// ------------------------------------------------------------
test('注释纪律：全仓注释零违规', () => {
  const { hits } = scanAll();
  const rows = hits.map((h) => `${h.rel}:${h.line}  [${h.reasons}]  ${h.body.slice(0, 70)}`);
  assert.deepStrictEqual(hits.length, 0,
    `\n有 ${hits.length} 处注释含归属性内容：\n  ${rows.join('\n  ')}\n`
    + '  现场经过改写成代码事实，归属叙述改成技术陈述，\n'
    + '  描述界面元素的符号改成文字，双破折号改成冒号或逗号。\n');
});
