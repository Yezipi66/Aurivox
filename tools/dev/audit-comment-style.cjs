'use strict';

// 注释「风格与可读性」检查器。
// 配套 docs/COMMENT_GUIDELINE.md 的「风格与可读性」一节，把可机械判定的几条规则落地成报告。
// 与 commentDiscipline.node.test.js（判「归属性内容零违规」）不同，本脚本判「可读、统一」：
//   A. 填充词：说白了 / 简单来说 / 总的来说 / 也就是说 / 换句话说 / 顺便 / 老实说 /
//              注意一下 / 说实在的 / 换言之 / 讲白了 / 说穿了 / 总之
//      （「其实 / 这里 / 这个」语义常合法，不在此列，避免误报）
//   B. 同一注释行里半角逗号与全角逗号混用（, 与 ，同现）
//   C. 单行过长（全角字符 > 62，仅作提示，不强制）
// 本脚本只产出报告、不阻断构建（exit 0）。需要当门槛时由调用方决定。
//
// 抽取交给 @babel/parser（与 commentDiscipline 同源），不手写逐字符状态机——
// 后者会把正则字面量当成字符串起点，两个引号之间整段吞掉。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCAN_ROOTS = ['lib', 'web/src', 'tools', 'server.js', 'pipeline'];
const SCAN_EXTS = new Set(['.js', '.jsx', '.cjs', '.mjs']);
const SKIP_RELS = [
  'node_modules', '__pycache__', '.git', '.venv', '.staging', 'dist',
  'engines', 'cache', 'tools/dev', 'tools/runtime',
];

const FULL_COMMA = '，';
const HALF_COMMA = ',';
const FILLER_WORDS = [
  '说白了', '简单来说', '总的来说', '也就是说', '换句话说',
  '顺便', '老实说', '注意一下', '说实在的', '换言之', '讲白了', '说穿了', '总之',
];

function loadParser() {
  try {
    return require(path.join(ROOT, 'lib', 'testDeps.js')).babelParse();
  } catch (e) {
    try {
      return require('@babel/parser').parse;
    } catch (e2) {
      throw new Error(`拿不到 @babel/parser，风格检查无法抽取注释：${e2.message}`);
    }
  }
}

function parseSource(parse, rel, src) {
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

function commentLines(rel, src) {
  const parse = loadParser();
  const ast = parseSource(parse, rel, src);
  const out = [];
  for (const c of ast.comments || []) {
    const start = c.loc.start.line;
    const span = c.loc.end.line - start + 1;
    const lines = String(c.value == null ? '' : c.value).split('\n');
    for (let k = 0; k < span; k++) {
      const seg = (k < lines.length ? lines[k] : '').replace(/^\s*\*\/?/, '').replace(/^\/\*/, '');
      out.push({ line: start + k, body: seg });
    }
  }
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

function fullwidthLen(s) {
  let n = 0;
  for (const ch of s) n += ch.charCodeAt(0) > 0x2e80 ? 1 : 0;
  return n;
}

function scanOne(rel, src) {
  const hits = [];
  for (const c of commentLines(rel, src)) {
    const b = c.body;
    if (!b.trim()) continue;
    for (const w of FILLER_WORDS) {
      if (b.includes(w)) hits.push({ line: c.line, cat: '填充词', token: w, body: b.trim() });
    }
    // 真·不一致：半角逗号夹在两个中文之间（散文停顿误用半角），且同行还有全角逗号。
    // 代码对象字面量 {a, b} 里的半角逗号两侧是 ASCII，不命中。
    if (b.includes(FULL_COMMA) && /[一-鿿],[一-鿿]/.test(b)) {
      hits.push({ line: c.line, cat: '混用逗号', token: ',夹中文', body: b.trim() });
    }
    const fw = fullwidthLen(b);
    if (fw > 62) hits.push({ line: c.line, cat: '行过长', token: String(fw), body: b.trim() });
  }
  return hits;
}

function main() {
  const files = [];
  for (const r of SCAN_ROOTS) collectFiles(path.join(ROOT, r), files);
  let total = 0;
  const byCat = {};
  const perFile = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    let hits = [];
    try { hits = scanOne(rel, fs.readFileSync(f, 'utf8')); } catch (e) {
      process.stderr.write(`跳过（解析失败）${rel}: ${e.message}\n`);
      continue;
    }
    if (hits.length) {
      perFile.push({ rel, hits });
      for (const h of hits) { total++; byCat[h.cat] = (byCat[h.cat] || 0) + 1; }
    }
  }
  perFile.sort((a, b) => a.rel.localeCompare(b.rel));
  const lines = [];
  lines.push(`扫描文件数: ${files.length}`);
  lines.push(`命中总数: ${total}`);
  lines.push(`分类: ${JSON.stringify(byCat)}`);
  lines.push('');
  for (const { rel, hits } of perFile) {
    const isTest = /\.test\.(js|jsx)$/.test(rel) || /node\.test\.(js|jsx)$/.test(rel);
    lines.push(`### ${rel}${isTest ? '  [测试]' : ''}`);
    for (const h of hits) {
      lines.push(`  L${h.line}  [${h.cat}:${h.token}]  ${h.body.slice(0, 90)}`);
    }
  }
  const outPath = path.join(ROOT, 'tmp', 'audit_style.txt');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  process.stdout.write(lines.join('\n') + '\n');
  process.stdout.write(`\n报告已写入 ${outPath}\n`);
}

main();
