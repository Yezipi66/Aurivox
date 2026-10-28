'use strict';

// 注释「不放飞自我」检查器。
// 配套 docs/COMMENT_GUIDELINE.md 的「注释不是草稿纸」一节。
//
// 只盯注释有没有越过「注释该干的活」那条线——把不属于代码事实的东西写进注释：
//   A. 归属与决策：谁定的、谁拍板的、用户怎么反馈的。决定写进 docs/ 的决策文档，
//      注释里只留结论性的约束。
//   B. 变更史：以前长什么样、什么时候改的、改之前是什么样。那是 changelog，跟着提交信息走。
//   C. 备忘待办：TODO / FIXME / 下一步要。那是 backlog，进 issue；留在注释里只会烂在里面。
//   D. 人称与口吻：我以为 / 我觉得 / 「不是用来刁难人的」。注释陈述事实，不发表感想。
//   E. 行过长（>80 全角字符）：仅作提示。长句未必有错，交给改的人自己判断。
//
// 标点混用不查：半角逗号出现在 {a, b} 里是代码不是散文，机器判不准，抓死了只有噪音。
// 测试文件默认不查：按当前口径，测试的注释不在这一轮范围内（--include-tests 可打开）。
//
// 本脚本只产出报告、不阻断构建（exit 0）。需要当门槛时由调用方决定。
//
// 抽取交给 @babel/parser（与 commentDiscipline 同源），不手写逐字符状态机——
// 后者会把正则字面量当成字符串起点，把两个引号之间整段吞掉。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCAN_ROOTS = ['lib', 'web/src', 'tools', 'server.js', 'pipeline'];
const SCAN_EXTS = new Set(['.js', '.jsx', '.cjs', '.mjs']);
const SKIP_RELS = [
  'node_modules', '__pycache__', '.git', '.venv', '.staging', 'dist',
  'engines', 'cache', 'tools/dev', 'tools/runtime',
];

const INCLUDE_TESTS = process.argv.includes('--include-tests');
const LONG_LINE_LIMIT = 80;

const RULES = [
  {
    cat: '归属与决策',
    words: [
      'Owner', '裁决', '拍板', '裁定', '亲自', '前任', '老板',
      '产品要求', '由产品决定', '用户反馈', '使用者反馈', '口头', '当面交代',
      '我们决定', '经讨论', '需求方要求',
    ],
  },
  {
    cat: '变更史',
    // 「原来」单字也收：漏掉它就会放过「原来 tier 在行内、phase 在行内」这种 changelog。
    words: [
      '原来', '原先', '以前是', '以前只有', '早先', '历史上', '历史遗留',
      '后补', '改前', '改之前', '拆分前', '迁移前', '搬家前',
      '第一版', '上一版', '一度', '曾经有', '后来改', '已改成', '现改为',
    ],
  },
  {
    // 只收明确的任务标记。「下一步 / 将来」在流程类注释里是合法说法，不收。
    cat: '备忘待办',
    words: ['TODO', 'FIXME', 'XXX', 'HACK', '待实现', '待办', '待补'],
  },
  {
    // 「才发现」不收：写失败在哪个环节暴露是合法叙述，不是主观感想。
    cat: '人称与口吻',
    words: ['我以为', '我觉得', '我认为', '我猜', '我发现', '刁难'],
  },
];

function loadParser() {
  try {
    return require(path.join(ROOT, 'lib', 'testDeps.js')).babelParse();
  } catch (e) {
    try {
      return require('@babel/parser').parse;
    } catch (e2) {
      throw new Error(`拿不到 @babel/parser，检查器无法抽取注释：${e2.message}`);
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
    if (!INCLUDE_TESTS && /(\.test|Test)\.(js|jsx)$/.test(e.name)) continue;
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
    for (const rule of RULES) {
      for (const w of rule.words) {
        if (b.includes(w)) hits.push({ line: c.line, cat: rule.cat, token: w, body: b.trim() });
      }
    }
    const fw = fullwidthLen(b);
    if (fw > LONG_LINE_LIMIT) hits.push({ line: c.line, cat: '行过长', token: String(fw), body: b.trim() });
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
  lines.push(`扫描文件数: ${files.length}${INCLUDE_TESTS ? '' : '（已跳过测试文件）'}`);
  lines.push(`命中总数: ${total}`);
  lines.push(`分类: ${JSON.stringify(byCat)}`);
  lines.push('');
  for (const { rel, hits } of perFile) {
    lines.push(`### ${rel}`);
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
