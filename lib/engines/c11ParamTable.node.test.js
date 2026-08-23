'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { listEngines } = require('./registry');
const { PLATFORM_REQUEST_KEYS } = require('./paramTable');

// ============================================================
//  契约 C11 守卫 —— 参数表只有一份
// ============================================================
//
// 契约 `docs/ENGINE_CONTRACT.md` 的 C11 写了判据，原文：
//
//     **判据（可机器验）**：`lib\` 和 `server.js` 里搜不到任何引擎参数名的
//     硬编码清单。加一条守卫测试：仓库里再出现第二份写死的参数清单就变红。
//
// 这条守卫至今不存在 —— 这个文件就是补上它。
//
// ⭐⭐ 为什么这件事非要机器守：副本的问题**不是重复，是它们会各自漂移，
//    而漂移不会报错**。实证：`batch_size` 曾同时有四份副本（名片 4 / server.js
//    跟环境变量走 / recipeStore 写死 1 / GenerateTab useState 写死 1 且无条件发），
//    结果名片那个 4 和 `AURIVOX_TTS_BATCH_SIZE` 旋钮在 webui 路径上**从未生效**，
//    而 644 条测试没有一条会红。症状只是「同一个参数，Workbench 里有效、
//    Flow 里无效」，或者「配方存出来的声音和刚才听到的不一样」。
//
// 判定规则（规则式，本文件不点任何引擎的名字）：
//   1. 私有参数名 = 所有**已装引擎**名片 param_keys 的并集 − 平台词
//      （平台词取自 paramTable.PLATFORM_REQUEST_KEYS，同样是唯一产地）
//   2. 扫 lib/**/*.js（排除 *.test.js）+ server.js，**去掉注释**
//   3. 命中 = 源码里出现被引号完整包裹的该键名字面量
//   4. 每一处命中都必须在下面的 EXEMPT 里**连键名一起**登记，并写明理由
//
// ⛔ 豁免是 (文件 → 键名清单)，不是 (文件)。往一个已豁免的文件里塞一个**新的**
//    参数名，照样会红 —— 否则豁免会变成后门，C11 的账又会悄悄长回来。

const ROOT = path.resolve(__dirname, '..', '..');

// ── 带理由的豁免清单 ────────────────────────────────────────
//
// ⭐ 判据：这里的每一条都必须是「**不是**在记载引擎认识哪些参数」。
//    如果一条豁免的理由是「这里也需要知道引擎有哪些参数」，那它就不是豁免，
//    是还没还的账 —— 请去改成向名片要，而不是加进这张表。
const EXEMPT = {
  // ── 历史事实：v3 磁盘上当年那些键 ──
  //
  // 这两份清单**不是**「引擎认识哪些参数」，而是「v3 的 params 里哪些键当年是
  // 塞给引擎的」。它回答的是一个纯历史问题，答案已经被磁盘上的存量配方冻住了。
  // ⛔ 名片改了它也**不能**跟着改：跟着改就会把老配方读错。
  'lib/recipeStore.js': {
    why: 'V3_PARAM_KEYS —— v3 磁盘格式的历史事实，被存量配方冻住，名片变了它也不能变',
    keys: [
      'top_k', 'top_p', 'temperature', 'text_split_method', 'repetition_penalty',
      'sample_steps', 'if_sr', 'batch_size', 'batch_threshold', 'split_bucket',
      'fragment_interval', 'parallel_infer', 'aux_ref_audio_paths', 'pron_overrides',
    ],
  },
  'lib/recipeView.js': {
    why: 'V3_ENGINE_PARAM_KEYS —— 同上，v3 → v4 迁移时回答「当年哪些键是塞给引擎的」',
    keys: [
      'top_k', 'top_p', 'temperature', 'text_split_method', 'repetition_penalty',
      'sample_steps', 'if_sr', 'batch_size', 'batch_threshold', 'split_bucket',
      'fragment_interval', 'parallel_infer', 'aux_ref_audio_paths', 'pron_overrides',
    ],
  },

  // ── 平台概念名，恰好与某台引擎的字面键名撞车 ──
  'lib/engines/payload.js': {
    why: 'CORE_KEYS —— `maps` 左边的**平台**概念名（平台说「参考音频」，名片负责翻译成引擎的键名）。'
      + '它们长得像 GSV 的键名纯属撞车：GSV 的 maps 恰好是恒等映射。'
      + '（CORE_KEYS 里另外两个 reference_audio / reference_lang 不在任何名片的 param_keys 上，'
      + '本来就不会被判为违规，所以不必登记 —— 反向守卫会盯着这件事）',
    keys: ['text_lang', 'reference_text'],
  },

  // ── 资产字段：权重 / 参考音频，不是可调旋钮 ──
  //
  // 平台**必须**懂它们的结构（路径要做可移植性解析、要跟着音色搬家），
  // 这跟「引擎认识哪些旋钮」是两件事。归契约 §12 第 2 步那一刀。
  'lib/flowgraph/docs.js': {
    why: '资产字段的人话说明（辅助参考音频）—— 非可调旋钮，归契约 §12 第 2 步',
    keys: ['aux_ref_audio_paths'],
  },

  'server.js': {
    why: 'aux_ref_audio_paths ＝ 资产字段，做的是托管路径解析与可移植性分类（平台必须懂它的结构）；'
      + "batch_size ＝ **训练**配置（custom.training），与推理侧同名不同物 —— "
      + '契约 v2 只管推理，微调那一侧默认 1、推理默认 4，是两个场景各自正确的答案',
    keys: ['aux_ref_audio_paths', 'batch_size'],
  },
};

// ── 扫描 ────────────────────────────────────────────────────

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walk(full, out);
    } else if (e.name.endsWith('.js') && !e.name.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

/** 去掉注释 —— 注释里提到参数名是好事（解释为什么搬走了），不该被算成副本。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

/** 私有参数名 = 已装引擎 param_keys 的并集 − 平台词。 */
function enginePrivateKeys() {
  const platform = new Set(PLATFORM_REQUEST_KEYS);
  const keys = new Set();
  for (const manifest of listEngines()) {
    for (const k of manifest.param_keys || []) {
      if (!platform.has(k)) keys.add(k);
    }
  }
  return keys;
}

function scan() {
  const priv = enginePrivateKeys();
  const files = walk(path.join(ROOT, 'lib'));
  files.push(path.join(ROOT, 'server.js'));

  const hits = new Map(); // rel -> Map(key -> [行号])
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const lines = stripComments(fs.readFileSync(file, 'utf-8')).split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const key of priv) {
        const re = new RegExp(`['"\`]${key.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}['"\`]`);
        if (!re.test(line)) continue;
        if (!hits.has(rel)) hits.set(rel, new Map());
        const perKey = hits.get(rel);
        if (!perKey.has(key)) perKey.set(key, []);
        perKey.get(key).push(i + 1);
      }
    });
  }
  return { priv, hits };
}

// ── 守卫 ────────────────────────────────────────────────────

test('C11：lib/ 和 server.js 里没有第二份写死的引擎参数清单', () => {
  const { hits } = scan();
  const offences = [];

  for (const [rel, perKey] of hits) {
    const exempt = EXEMPT[rel];
    for (const [key, lineNos] of perKey) {
      if (exempt && exempt.keys.includes(key)) continue;
      offences.push(
        `${rel}:${lineNos.join(',')}  写死了引擎参数名 "${key}"`
        + (exempt ? `\n      （本文件已豁免，但豁免清单里没有这个键）` : ''),
      );
    }
  }

  assert.deepStrictEqual(
    offences.sort(),
    [],
    '契约 C11：同一个引擎认识哪些参数，全项目只能有一处记载 —— 它自己的名片。\n\n'
    + '请改为向名片要（lib/engines/paramTable.js 是平台读名片的唯一入口）。\n'
    + '若这一处**确实不是**在记载「引擎认识哪些参数」（例如磁盘格式的历史事实、\n'
    + '平台概念名、资产字段、训练侧配置），请在本文件的 EXEMPT 中连键名一起登记，\n'
    + '并写明理由。\n\n'
    + offences.join('\n'),
  );
});

test('C11 豁免清单本身没有腐烂 —— 登记了却已经不存在的条目要清掉', () => {
  // ⭐ 反向守卫。没有这一条，豁免清单会变成只进不出的垃圾堆：某一处明明已经
  //   改成名片驱动了，它的豁免却还挂在这里，替**下一个**写死的清单挡子弹。
  const { hits } = scan();
  const stale = [];

  for (const [rel, entry] of Object.entries(EXEMPT)) {
    const perKey = hits.get(rel);
    if (!perKey) {
      stale.push(`${rel}  整个文件已经不再提到任何引擎参数名 —— 请把这条豁免删掉`);
      continue;
    }
    for (const key of entry.keys) {
      if (!perKey.has(key)) {
        stale.push(`${rel}  "${key}" 已经不在源码里了 —— 请从豁免清单里划掉`);
      }
    }
  }

  assert.deepStrictEqual(
    stale.sort(),
    [],
    '豁免清单只能越来越短。以下条目登记了但源码里已经找不到：\n\n' + stale.join('\n'),
  );
});

test('每一条豁免都写了理由', () => {
  for (const [rel, entry] of Object.entries(EXEMPT)) {
    assert.ok(
      typeof entry.why === 'string' && entry.why.trim().length >= 20,
      `${rel} 的豁免没写清楚理由。豁免不写理由，下一个人就只能靠猜，`
      + `而猜错的方向永远是「那我也加一条吧」`,
    );
    assert.ok(
      Array.isArray(entry.keys) && entry.keys.length > 0,
      `${rel} 的豁免没有列出键名。⛔ 豁免必须是 (文件 → 键名清单)，不能只豁免文件 —— `
      + `否则往这个文件里塞新参数名就成了后门`,
    );
  }
});

test('守卫自己是活的 —— 真的认得出已装引擎的私有参数', () => {
  // ⛔⛔ 这一条防的是「守卫扫了个寂寞」。如果名片解析哪天坏掉、或者
  //   registry 返回空数组，上面三条会**全部变绿**，而 C11 的账无人看守。
  //   这正是我在这一刀里已经踩过一次的形状：为测试开的缝没人走真路。
  const { priv } = scan();
  assert.ok(priv.size >= 10, `只认出 ${priv.size} 个引擎私有参数，名片解析可能已经坏了`);

  // 平台词必须被排除干净，否则守卫会把平台自己的字段当成引擎参数误报
  for (const platformKey of PLATFORM_REQUEST_KEYS) {
    assert.ok(!priv.has(platformKey), `平台词 "${platformKey}" 不该被当成引擎私有参数`);
  }

  // 已装的每一台引擎都要有键被认出来（装了第二台引擎却一个键都没扫到 = 漏扫）
  const platform = new Set(PLATFORM_REQUEST_KEYS);
  for (const manifest of listEngines()) {
    const own = (manifest.param_keys || []).filter((k) => !platform.has(k));
    if (own.length === 0) continue;
    assert.ok(
      own.some((k) => priv.has(k)),
      `引擎 ${manifest.id} 的私有参数一个都没被守卫认出来`,
    );
  }
});
