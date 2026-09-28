'use strict'
// ============================================================================
//  参数草稿生成器的守卫
//
//  ⭐ 这个文件测的是**判断**，不是格式。判据来自一次真实对照：
//  拿 IndexTTS2（人已经手写好 14 条 parameters[] 的真引擎）当标准答案，
//  看生成器能不能做对。
//
//  ⚠ 但**不直接 require 真引擎的 venv** —— 那要 34 秒 import、几个 GB 依赖，
//  而且换台机器就红。这里把反射结果**冻结成夹具**，测纯函数那一层。
//  真引擎那一半由 tools/dev/probe_scaffold_vs_manifest.cjs 定期跑（不在 npm test 里）。
// ============================================================================

const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { buildDraft, inferType, exclusionReason, EXCLUDE } = require('../../tools/scaffold-params.cjs')

// ---------------------------------------------------------------------------
//  夹具：从 indextts.infer_v2.IndexTTS2.infer 反射出来的**真实**结果
//  （2026-09-04 由 lib/engines/reflect_params.py 实跑得到，未经手工编辑）
// ---------------------------------------------------------------------------
const REAL_REFLECTION = {
  ok: true,
  python: { version: '3.11', executable: 'python.exe', module_file: '.../indextts/__init__.py' },
  class: 'indextts.infer_v2.IndexTTS2',
  method: 'infer',
  warnings: [],
  load: [
    { name: 'cfg_path', phase: 'load', required: false, default: 'checkpoints/config.yaml',
      default_repr: "'checkpoints/config.yaml'",
      kind: { kind: 'text', confidence: 'medium', why: '默认值是 Python str' },
      annotation: null, name_hint: { kind: 'path?', confidence: 'weak', why: '名字像路径' } },
    { name: 'model_dir', phase: 'load', required: false, default: 'checkpoints',
      default_repr: "'checkpoints'",
      kind: { kind: 'text', confidence: 'medium', why: '默认值是 Python str' },
      annotation: null, name_hint: { kind: 'path?', confidence: 'weak', why: '名字像路径' } },
    { name: 'use_fp16', phase: 'load', required: false, default: false, default_repr: 'False',
      kind: { kind: 'boolean', confidence: 'strong', why: '默认值是 Python bool' },
      annotation: null, name_hint: { kind: 'boolean', confidence: 'weak', why: '名字以 use_ 开头' } },
    { name: 'device', phase: 'load', required: false, default: null, default_repr: 'None',
      kind: { kind: 'unknown', confidence: 'none', why: '默认值是 None' },
      annotation: null, name_hint: { kind: 'boolean', confidence: 'weak', why: '名字以 use_ 开头' } },
    { name: 'use_cuda_kernel', phase: 'load', required: false, default: null, default_repr: 'None',
      kind: { kind: 'unknown', confidence: 'none', why: '默认值是 None' },
      annotation: null, name_hint: { kind: 'boolean', confidence: 'weak', why: '名字以 use_ 开头' } },
    { name: 'use_deepspeed', phase: 'load', required: false, default: false, default_repr: 'False',
      kind: { kind: 'boolean', confidence: 'strong', why: '默认值是 Python bool' },
      annotation: null, name_hint: { kind: 'boolean', confidence: 'weak', why: '名字以 use_ 开头' } },
    { name: 'use_accel', phase: 'load', required: false, default: false, default_repr: 'False',
      kind: { kind: 'boolean', confidence: 'strong', why: '默认值是 Python bool' },
      annotation: null, name_hint: { kind: 'boolean', confidence: 'weak', why: '名字以 use_ 开头' } },
    { name: 'use_torch_compile', phase: 'load', required: false, default: false, default_repr: 'False',
      kind: { kind: 'boolean', confidence: 'strong', why: '默认值是 Python bool' },
      annotation: null, name_hint: { kind: 'boolean', confidence: 'weak', why: '名字以 use_ 开头' } },
    { name: 'aux_paths', phase: 'load', required: false, default: null, default_repr: 'None',
      kind: { kind: 'unknown', confidence: 'none', why: '默认值是 None' },
      annotation: null, name_hint: { kind: 'path?', confidence: 'weak', why: '名字像路径' } },
    { name: 'generation_kwargs', phase: 'load', skipped: true, why: '变长参数（*args / **kwargs）' },
  ],
  call: [
    { name: 'emo_alpha', phase: 'call', required: false, default: 1.0, default_repr: '1.0',
      kind: { kind: 'number', confidence: 'medium', why: '默认值是 Python float' },
      annotation: null, name_hint: { kind: 'number', confidence: 'weak', why: '名字像数值旋钮' } },
    { name: 'interval_silence', phase: 'call', required: false, default: 200, default_repr: '200',
      kind: { kind: 'integer', confidence: 'medium', why: '默认值是 Python int' },
      annotation: null, name_hint: { kind: 'number', confidence: 'weak', why: '名字像数值旋钮' } },
    { name: 'verbose', phase: 'call', required: false, default: false, default_repr: 'False',
      kind: { kind: 'boolean', confidence: 'strong', why: '默认值是 Python bool' },
      annotation: null, name_hint: { kind: 'boolean', confidence: 'weak', why: '名字像开关' } },
    { name: 'use_emo_text', phase: 'call', required: false, default: false, default_repr: 'False',
      kind: { kind: 'boolean', confidence: 'strong', why: '默认值是 Python bool' },
      annotation: null, name_hint: { kind: 'boolean', confidence: 'weak', why: '名字以 use_ 开头' } },
    { name: 'emo_audio_prompt', phase: 'call', required: false, default: null, default_repr: 'None',
      kind: { kind: 'unknown', confidence: 'none', why: '默认值是 None' },
      annotation: null, name_hint: { kind: 'audio', confidence: 'weak', why: '名字像音频输入' } },
    { name: 'emo_vector', phase: 'call', required: false, default: null, default_repr: 'None',
      kind: { kind: 'unknown', confidence: 'none', why: '默认值是 None' },
      annotation: null, name_hint: { kind: 'number[]', confidence: 'weak', why: '名字像数字数组' } },
    { name: 'emo_text', phase: 'call', required: false, default: null, default_repr: 'None',
      kind: { kind: 'unknown', confidence: 'none', why: '默认值是 None' },
      annotation: null, name_hint: { kind: 'text', confidence: 'weak', why: '名字像文本' } },
    { name: 'use_random', phase: 'call', required: false, default: false, default_repr: 'False',
      kind: { kind: 'boolean', confidence: 'strong', why: '默认值是 Python bool' },
      annotation: null, name_hint: { kind: 'boolean', confidence: 'weak', why: '名字以 use_ 开头' } },
    { name: 'max_text_tokens_per_segment', phase: 'call', required: false, default: 120,
      default_repr: '120',
      kind: { kind: 'integer', confidence: 'medium', why: '默认值是 Python int' },
      annotation: null, name_hint: { kind: 'number', confidence: 'weak', why: '名字像数值旋钮' } },
    { name: 'spk_audio_prompt', phase: 'call', required: true, default: null, default_repr: null,
      kind: { kind: 'unknown', confidence: 'none', why: '必填参数，没有默认值' },
      annotation: null, name_hint: { kind: 'audio', confidence: 'weak', why: '名字像音频输入' } },
    // ⭐ 上游自己写了 Literal —— 这是它说的，不是我们猜的
    { name: 'mode', phase: 'call', required: false, default: 'fast', default_repr: "'fast'",
      kind: { kind: 'text', confidence: 'medium', why: '默认值是 Python str' },
      annotation: { raw: "Literal['fast', 'quality']", literal_choices: ['fast', 'quality'] },
      name_hint: null },
  ],
}

// ---------------------------------------------------------------------------
//  1) 类型推断
// ---------------------------------------------------------------------------

test('⭐⭐ bool 必须是 boolean —— ⛔ 不能掉进 number（Python 里 bool 是 int 的子类）', () => {
  const t = inferType({ kind: { kind: 'boolean', confidence: 'strong' } })
  assert.equal(t.type, 'boolean')
})

test('⭐⭐ 上游 Literal[...] 里的选项直接用 —— 那是它说的，不是我猜的', () => {
  const t = inferType({
    kind: { kind: 'unknown', confidence: 'none' },
    upstream_choices: ['fast', 'quality'],
  })
  assert.equal(t.type, 'select')
  assert.equal(t.confidence, 'strong')
  assert.deepEqual(t.choices, ['fast', 'quality'])
})

test('⭐⭐ int 保留 integer 写法 —— 降级成 number 之后仍要记住「要整数」', () => {
  const t = inferType({ kind: { kind: 'integer', confidence: 'medium' } })
  assert.equal(t.type, 'integer',
    '⛔ 7.5 悄悄发给只吃整数的引擎，是最难查的一类 bug')
})

test('⭐⭐⭐ 默认值给不出类型时，用名字给建议，但必须标 needs_review', () => {
  const t = inferType({
    kind: { kind: 'unknown', confidence: 'none', why: '默认值是 None' },
    name_hint: { kind: 'boolean', confidence: 'weak', why: '名字以 use_ 开头' },
  })
  assert.equal(t.type, 'boolean')
  assert.equal(t.needs_review, true, '⛔ 不标出来 = 人会以为那是事实')
  assert.equal(t.confidence, 'weak')
})

test('⭐⭐⭐ 名字也没线索时，返回 null —— ⛔ 不许瞎给一个', () => {
  const t = inferType({ kind: { kind: 'unknown', confidence: 'none' } })
  assert.equal(t.type, null)
})

test('⭐ 名字线索是「音频」时不给 select —— 那是人工判断（source:audio vs text）', () => {
  const t = inferType({
    kind: { kind: 'unknown', confidence: 'none' },
    name_hint: { kind: 'audio', confidence: 'weak' },
  })
  assert.equal(t.type, 'text')
  assert.equal(t.needs_review, true)
})

// ---------------------------------------------------------------------------
//  2) 排除名单 —— ⭐ 这一组是生成器最核心的判断
// ---------------------------------------------------------------------------

test('⭐⭐⭐ cfg_path / model_dir 必须排除 —— 做成格子改了会「声音不对且不报错」', () => {
  for (const n of ['cfg_path', 'model_dir', 'ckpt_path', 'vocoder_dir', 'model_file']) {
    assert.ok(exclusionReason(n), `${n} 应当被排除，实际没排`)
  }
})

test('⭐⭐ device 必须排除 —— 平台自己探测过，暴露会出现两个真相', () => {
  assert.ok(exclusionReason('device'))
  assert.ok(exclusionReason('local_rank'))
})

test('⭐⭐⭐ 名字线索是「路径」时必须排除 —— ⛔ 不许猜成 text/textbox', () => {
  // aux_paths 的名字线索是 path?。猜成「文本框」的后果：用户填一个路径进去，
  // 引擎加载的不是那份权重 ⇒ **声音是别人的，且不报错**。
  const refl = { ...REAL_REFLECTION, load: [
    { name: 'aux_paths', phase: 'load', required: false, default: null, default_repr: 'None',
      kind: { kind: 'unknown', confidence: 'none', why: '默认值是 None' },
      annotation: null, name_hint: { kind: 'path?', confidence: 'weak', why: '名字像路径' } },
  ] }
  const { parameters, excluded } = buildDraft(refl)
  assert.equal(parameters.some(p => p.name === 'aux_paths'), false,
    '⛔ 路径类参数不许进草稿 —— 猜成文本框的话，用户填个路径进去，' +
    '引擎加载的不是那份权重 ⇒ 声音是别人的，且不报错')
  const e = excluded.find(x => x.name === 'aux_paths')
  assert.ok(e, '但要在 excluded 里说明为什么')
  // ⭐ 走的是**排除名单**那条路（比类型推断更早），所以它拿到的是
  //   「路径类」的完整理由，不是「类型反射不出」。这也是更好的一条路：
  //   它说的是「这个参数根本不该做成界面格子」，而不只是「我不知道它的类型」。
  assert.match(e.reason, /路径类|init_args/,
    '⭐ 理由要指向「归 init_args」，而不是含糊的「类型不知道」')
  assert.equal(e.needs_human, undefined,
    '⚠ 它不是「需要人定类型」，而是「已判定不该进草稿」—— 两者不该混')
})

test('⭐⭐⭐ 排除名单**不许**误伤正常的旋钮', () => {
  // ⚠ 这几个名字里都带 path/dir 之类的成分，但它们是**真参数**。
  //   放宽正则的代价是：把该暴露的藏起来 ⇒ 界面上少旋钮，且不报错。
  for (const n of ['prompt_path_ratio', 'dirichlet', 'directory_depth', 'filepath_mode']) {
    assert.equal(exclusionReason(n), null, `${n} 被误排了 —— 检查排除正则`)
  }
})

test('⭐⭐⭐ 真引擎对照：14 个真参数一个都不许漏', () => {
  const { parameters } = buildDraft(REAL_REFLECTION)
  const got = new Set(parameters.map(p => p.name))
  // IndexTTS2 真名片里手写的 14 条（cfg_path/model_dir/device 是 init_args 固定值，不在其列）
  const truth = ['use_fp16', 'use_cuda_kernel', 'use_deepspeed', 'use_accel', 'use_torch_compile',
    'emo_alpha', 'interval_silence', 'verbose', 'max_text_tokens_per_segment',
    'emo_audio_prompt', 'emo_vector', 'use_emo_text', 'emo_text', 'use_random']
  const missing = truth.filter(n => !got.has(n))
  assert.deepEqual(missing, [],
    `⛔ 漏了 ${missing.join(', ')} —— 界面上会少掉真实存在的旋钮，且没有任何报错`)
})

test('⭐⭐⭐ 反射得来的类型不许带 needs_review —— 那是「事实」不是「建议」', () => {
  const { parameters } = buildDraft(REAL_REFLECTION)
  const byName = new Map(parameters.map(p => [p.name, p]))
  for (const n of ['use_fp16', 'emo_alpha', 'interval_silence', 'verbose', 'use_emo_text']) {
    assert.equal(byName.get(n)._needs_review, undefined,
      `${n} 的类型是反射得来的，不该要求人工确认`)
  }
})

test('⭐⭐⭐ 名字猜出来的必须逐条标 needs_review', () => {
  const { parameters } = buildDraft(REAL_REFLECTION)
  const byName = new Map(parameters.map(p => [p.name, p]))
  for (const n of ['use_cuda_kernel', 'emo_audio_prompt', 'emo_vector', 'emo_text', 'spk_audio_prompt']) {
    assert.equal(byName.get(n)._needs_review, true,
      `${n} 是按名字猜的，不标出来 = 人会当它是反射得来的事实`)
  }
})

test('⭐⭐ 名字猜出来的条目不许带 default —— 类型和默认值都是猜的', () => {
  const { parameters } = buildDraft(REAL_REFLECTION)
  const byName = new Map(parameters.map(p => [p.name, p]))
  assert.equal(byName.get('emo_vector').default, undefined)
  assert.equal(byName.get('use_cuda_kernel').default, undefined)
})

test('⭐⭐⭐ 排除的每一条都必须说明为什么 —— 「不给理由」等于让人自己猜', () => {
  const { excluded } = buildDraft(REAL_REFLECTION)
  assert.ok(excluded.length >= 5, `排除得有 ${excluded.length} 条`)
  for (const e of excluded) {
    assert.ok(e.reason && e.reason.length > 8, `${e.name} 排除得没有理由`)
  }
})

test('⭐⭐ 变长参数排除，且理由是「不替你猜怎么展开」', () => {
  const { excluded } = buildDraft(REAL_REFLECTION)
  const gk = excluded.find(e => e.name === 'generation_kwargs')
  assert.ok(gk, '**kwargs 应当被排除')
  assert.match(gk.reason, /变长|\*args/)
})

// ---------------------------------------------------------------------------
//  3) 草稿的形状 —— 能被平台的派生逻辑吃下去
// ---------------------------------------------------------------------------

test('⭐⭐⭐ 草稿的 phase / tier / group 要对 —— 分错档界面就长错', () => {
  const { parameters } = buildDraft(REAL_REFLECTION)
  const byName = new Map(parameters.map(p => [p.name, p]))
  assert.equal(byName.get('use_fp16').phase, 'load')
  assert.equal(byName.get('use_fp16').tier, 'advanced')
  assert.equal(byName.get('use_fp16').group, 'runtime')
  assert.equal(byName.get('emo_alpha').phase, 'call')
  assert.equal(byName.get('emo_alpha').tier, 'common')
})

test('⭐⭐⭐ 每条都要有双语 label —— 少一种语言界面上就是一片空白', () => {
  const { parameters } = buildDraft(REAL_REFLECTION)
  for (const p of parameters) {
    assert.ok(p.label && p.label.en, `${p.name} 缺英文 label`)
    assert.ok(p.label && p.label.zh, `${p.name} 缺中文 label`)
    assert.ok(p.help && p.help.en, `${p.name} 缺英文 help`)
  }
})

test('⭐⭐⭐ 猜不出类型不许进草稿 —— 但要在 excluded 里点名要人定', () => {
  const refl = { ...REAL_REFLECTION, call: [{ name: 'zzz', phase: 'call', required: true,
    default: null, default_repr: null, kind: { kind: 'unknown', confidence: 'none' },
    annotation: null, name_hint: null }] }
  const { parameters, excluded } = buildDraft(refl)
  // ⚠ REAL_REFLECTION 的 load 段仍有 8 条，所以这里只断言「zzz 不在草稿里」
  assert.equal(parameters.some(p => p.name === 'zzz'), false, '猜不出类型就不该进草稿')
  const e = excluded.find(x => x.name === 'zzz')
  assert.ok(e && e.needs_human, '⛔ 但必须在 excluded 里点名「这个需要人定」')
})

test('⭐⭐ 上游已有的参数要标出来 —— 不许覆盖别人的', () => {
  const { parameters } = buildDraft(REAL_REFLECTION, { existing: ['emo_alpha'] })
  const a = parameters.find(p => p.name === 'emo_alpha')
  assert.ok(a, 'emo_alpha 应当在草稿里')
  assert.equal(a._already_in_manifest, true, '⛔ 名片里已有的参数必须标出来，不许静默覆盖')
  const others = parameters.filter(p => p.name !== 'emo_alpha')
  for (const o of others) {
    assert.equal(o._already_in_manifest, undefined, `${o.name} 不该被标为已存在`)
  }
})

test('⭐⭐⭐ order 要稳定且不重复 —— 界面排序靠它', () => {
  const r1 = buildDraft(REAL_REFLECTION)
  const r2 = buildDraft(REAL_REFLECTION)
  assert.deepEqual(r1.parameters.map(p => p.name), r2.parameters.map(p => p.name),
    '⭐ 同一份反射结果必须给出同一个顺序')
  const loadOrders = r1.parameters.filter(p => p.phase === 'load').map(p => p.order)
  assert.equal(new Set(loadOrders).size, loadOrders.length, 'order 重复了')
})

test('⭐⭐⭐ 生成器不认识任何具体引擎名 —— 装一台谁都没见过的也要能用', () => {
  const src = require('fs').readFileSync(
    path.join(__dirname, '..', '..', 'tools', 'scaffold-params.cjs'), 'utf8')
  const code = src.replace(/\/\/.*$/gm, '').replace(/'(?:indextts2|gpt-sovits)'/g, "''")
  for (const name of ['indextts2', 'gpt-sovits', 'IndexTTS2', 'GPT-SoVITS']) {
    assert.equal(code.includes(name), false,
      `⛔ 生成器里出现了具体引擎名 ${name} —— 判据：装一台谁都没见过的引擎，这个文件一个字都不用改`)
  }
})

test('⭐⭐ 排除名单是显式表，不是「看着办」的分支', () => {
  for (const k of ['path_like', 'platform_owned', 'bind_slots']) {
    assert.ok(EXCLUDE[k], `排除名单少了 ${k}`)
  }
})

// ---------------------------------------------------------------------------
//  4) ⭐ 不完整的反射不许悄悄通过
// ---------------------------------------------------------------------------
//  ⭐ 这一组是 2026-09-04 实机侦察抓出来的 bug：
//  方法名拼错 ⇒ 反射只拿到加载期 ⇒ 草稿从 17 条变成 5 条，
//  而 CLI **exit 0**、照常打印、照常允许 --write。
//  并进名片的后果：界面上少了一整段真实存在的旋钮，**没有任何报错**。
//  那正是这个项目反复付学费的「设了它但什么都没发生」。

test('⭐⭐⭐ 反射结果不完整时，partial 必须传出来', () => {
  const refl = { ...REAL_REFLECTION, partial: true, partial_reason: '方法 X 不存在' }
  const { partial, partialReason } = buildDraft(refl)
  assert.equal(partial, true, '⛔ 不完整的结果不带 partial ⇒ 调用方无法拒绝写盘')
  assert.equal(partialReason, '方法 X 不存在')
})

test('⭐⭐ 完整结果不许被当成不完整（别把正常的也拒了）', () => {
  const { partial } = buildDraft(REAL_REFLECTION)
  assert.equal(partial, false)
})

test('⭐⭐⭐ 不完整的反射绝不能进草稿当结果用', () => {
  // 只反射到加载期时，调用期那一整段都没了。
  // ⭐ 断言的是「结果里必须能被看出来」，而不是「条数是几」——
  //   条数会随引擎变，能守住的是 partial 这个信号本身。
  const refl = { ...REAL_REFLECTION, call: [], partial: true, partial_reason: '方法不存在' }
  const { parameters, partial } = buildDraft(refl)
  assert.equal(partial, true)
  assert.equal(parameters.some(p => p.phase === 'call'), false,
    '调用期一个都没有 —— 这就是「少了一整段旋钮」的具体形态')
})
