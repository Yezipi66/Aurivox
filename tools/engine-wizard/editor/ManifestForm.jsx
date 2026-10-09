import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { RuntimeSection, CallSection, ModelsSection } from './NestedSections'
import { useInstalled } from './useInstalled'

// ============================================================================
//  MANIFEST FORM —— ⭐ 名片填表（不是 JSON 编辑器）
//
//  ⛔⛔ 这个组件存在的理由
//  上一版左侧是个 <textarea> 装 JSON —— 那是**代码编辑器**，不是填表。
//  它要求用户：会写 JSON + 记得住几十个键的语义 + 知道哪些填错不报错。
//  ⇒ 只有技术用户能用，而且技术用户也懒得填。
//
//  ⭐ 这一版：按**分组**分区（项目现成的 .section 三件套）
//    · 每个字段：键名 + 一句话说明 + 填错的后果
//    · 高危字段（静默失效那一类）当场挂 .badge-warn
//    · 参数区是**可增删的行**，不是一坨 JSON
//    · ⛔ 表单由 /wizard/spec 长出来（fieldmeta 是唯一权威），不手写清单
//
//  ⛔⛔ 全部用项目类：.section / .field / .field-label / .field-hint /
//    .control / .param-grid / .plan-warn / .rc-cmd / .expert-block /
//    .expert-summary / .badge / .msg —— ⛔⛔ 一个自造的 mf-*/pr-* 都不留。
//
//  ⛔⛔ 纪律：不许出现任何具体引擎名。
// ============================================================================

// ---------------------------------------------------------------------------
// 分组标题 —— ⭐ 用**平台的词汇**，不自己造中文名
// ⚠ 为什么不是「怎么起进程」这种说法：平台自己的界面从不这么叫它。
//   造一套「更friendly」的说法 = 造第二套词汇，用户学的是我的词、
//   填的是平台的键，两边对不上。⇒ 显示键名，说明放在 fieldmeta 的 howto 里。
// ---------------------------------------------------------------------------
const GROUP_LABELS = {
  basics: { en: 'Basics', zh: '基本信息' },
  source: { en: 'Source', zh: '源码与许可' },
  models: { en: 'Models', zh: '模型权重' },
  runtime: { en: 'runtime', zh: 'runtime（启动引擎进程）' },
  call: { en: 'call', zh: 'call（调用引擎接口）' },
  parameters: { en: 'parameters', zh: 'parameters（界面参数）' },
  capabilities: { en: 'capabilities', zh: 'capabilities（能力声明）' },
  install: { en: 'install', zh: 'install（怎么装）' },
  output: { en: 'output', zh: 'output（输出格式）' },
}

const GROUP_ORDER = [
  'basics', 'source', 'models', 'runtime', 'call',
  'capabilities', 'install', 'output',
]

// ⛔ 这三段是**嵌套结构**，有专门的编辑器（NestedSections.jsx），
//    不能「一个键一个 input」—— 那样只显示说明、填不了值。
const NESTED_GROUPS = ['runtime', 'call', 'models']

// 顶层哪些键是「简单值」⇒ 直接给个输入框；哪些是对象/数组 ⇒ 展开写
const SIMPLE_KEYS = {
  id: 'text', label: 'text', local_changes: 'text',
  max_chars: 'number', max_chars_source: 'text',
  timeout_ms: 'number', timeout_ms_source: 'text',
  base_url_env: 'text', contract_version: 'number',
}

function Field ({ sec, value, onChange }) {
  const { t } = useT()
  const kind = SIMPLE_KEYS[sec.key] || 'text'
  return (
    <div className="field">
      {/* ⭐ 键名 + 「填错不报错」徽标同一行（内联 flex，照 TrainingTab 的写法）*/}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <label className="field-label" style={{ margin: 0 }} title={sec.howto}>
          <code>{sec.key}</code>
        </label>
        {sec.danger === 'silent' && (
          <span className="badge badge-warn">
            {t('no error if wrong', '填错不报错')}
          </span>
        )}
      </div>
      <div className="field-hint">{sec.howto}</div>
      {kind === 'number'
        ? (
          <input className="control" type="number" value={value ?? ''}
            onChange={(e) => onChange(e.target.value === ''
              ? undefined
              : Number(e.target.value))} />
          )
        : (
          <input className="control" type="text" value={value ?? ''}
            onChange={(e) => onChange(e.target.value === undefined
              ? ''
              : e.target.value)} />
          )}
      {sec.warn && <div className="plan-warn">⚠ {sec.warn}</div>}
      {sec.structure && (
        <div className="rc-cmd">
          <pre className="rc-cmd-body">{sec.structure}</pre>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 参数区：可增删的行
// ---------------------------------------------------------------------------
function ParamRow ({ entry, index, spec, onChange, onDelete }) {
  const { t } = useT()
  const set = (k, v) => {
    const next = { ...entry }
    if (v === undefined || v === '') delete next[k]
    else next[k] = v
    onChange(index, next)
  }
  const type = entry.type || 'text'
  void spec

  return (
    <div className="card">
      <div className="form-grid">
        <div className="field">
          <label className="field-label">
            {t('Parameter name', '参数名')}
          </label>
          <input className="control" value={entry.name || ''}
            onChange={(e) => set('name', e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label">type</label>
          <select className="control" value={type}
            onChange={(e) => set('type', e.target.value)}>
            {['text', 'number', 'select', 'boolean', 'file'].map((x) => (
              <option key={x} value={x}>{x}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ⭐ .param-grid —— 项目给「一堆小字段」准备的（2 列，gap 10px，
          而且 .param-grid label 自带 11px muted 的标签样式）*/}
      <div className="param-grid">
        <label><span>label</span>
          <input className="control" value={entry.label?.zh || entry.label || ''}
            placeholder={t('shown in the UI', '界面上显示的名字')}
            onChange={(e) => set('label', e.target.value)} /></label>

        <label><span>tier</span>
          <select className="control" value={entry.tier || ''}
            onChange={(e) => set('tier', e.target.value || undefined)}>
            <option value="">{t('(unset → advanced)', '（不写 → advanced）')}</option>
            <option value="common">common</option>
            <option value="advanced">advanced</option>
          </select></label>

        <label><span>phase</span>
          <select className="control" value={entry.phase || ''}
            onChange={(e) => set('phase', e.target.value || undefined)}>
            <option value="">{t('(unset → call)', '（不写 → call）')}</option>
            <option value="call">call</option>
            <option value="load">load</option>
          </select></label>

        <label><span>default</span>
          <input className="control" value={entry.suggested_value ?? ''}
            onChange={(e) => set('suggested_value',
              e.target.value === ''
                ? undefined
                : (type === 'number' || type === 'boolean')
                  ? (type === 'boolean' ? e.target.value === 'true' : Number(e.target.value))
                  : e.target.value)} /></label>

        {type === 'number' && (
          <label><span>min / max</span>
            <span className="form-grid">
              <input className="control" type="number" value={entry.min ?? ''}
                onChange={(e) => set('min',
                  e.target.value === '' ? undefined : Number(e.target.value))} />
              <input className="control" type="number" value={entry.max ?? ''}
                onChange={(e) => set('max',
                  e.target.value === '' ? undefined : Number(e.target.value))} />
            </span></label>
        )}

        {type === 'select' && (
          <label><span>choices</span>
            <input className="control"
              value={Array.isArray(entry.choices) ? entry.choices.join(',') : ''}
              placeholder="voices / weights / audio"
              onChange={(e) => set('choices', e.target.value
                ? e.target.value.split(',').map((s) => s.trim())
                : undefined)} /></label>
        )}

        <label><span>applies_to</span>
          <input className="control"
            value={Array.isArray(entry.applies_to) ? entry.applies_to.join(',') : ''}
            placeholder={t('comma separated', '逗号分隔')}
            onChange={(e) => set('applies_to', e.target.value
              ? e.target.value.split(',').map((s) => s.trim())
              : undefined)} /></label>
      </div>

      {/* ⭐ 折叠用**项目的** .expert-block + .expert-summary
          （⛔⛔ 不再用裸 <details> —— 那个没有边框/间距，
            跟整页所有其它折叠长得不一样）*/}
      <details className="expert-block" style={{ marginTop: 8 }}>
        <summary className="expert-summary">
          {t('More (rarely needed)', '更多（多数用不到）')}
        </summary>
        <div className="param-grid" style={{ marginTop: 8 }}>
          <label><span>repeat</span>
            <input className="control" type="number" value={entry.repeat ?? ''}
              onChange={(e) => set('repeat',
                e.target.value === '' ? undefined : Number(e.target.value))} /></label>
          <label><span>group</span>
            <input className="control" value={entry.group || ''}
              onChange={(e) => set('group', e.target.value)} /></label>
          <label><span>order</span>
            <input className="control" type="number" value={entry.order ?? ''}
              onChange={(e) => set('order',
                e.target.value === '' ? undefined : Number(e.target.value))} /></label>
          <label><span>source</span>
            <select className="control" value={entry.source || ''}
              onChange={(e) => set('source', e.target.value || undefined)}>
              <option value="">{t('(unset)', '（不写）')}</option>
              <option value="voices">voices</option>
              <option value="weights">weights</option>
              <option value="audio">audio</option>
            </select></label>
        </div>
        <p className="plan-warn">
          {t('repeat unset or 1 means a single value (scalar). Only 2 or more makes an array. '
            + 'Those are two different things to the engine, and neither is reported '
            + 'as an error.',
            'repeat 未填或填 1 表示单个值（标量），仅当大于等于 2 时才为数组。'
            + '这两种对引擎是两件事，而且都不会报错。')}
        </p>
      </details>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <button className="btn btn-sm btn-danger" type="button"
          onClick={() => onDelete(index)}>
          {t('Delete this parameter', '删掉这个参数')}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ⭐ 第 2 步：草稿的三块分区渲染（用户操作流的界面形态）
//
// ⛔⛔ 三条纪律（硬约束，违反即返工）：
//   1. **参数一条都不许丢** —— 三块是同一份 parameters[] 的重排视图。
//      数据侧 organizeDraft 已经保证 must+may === parameters.length；
//      这里再加一道显示侧的守卫（三条数对不上就如实说，⛔ 不许悄悄少显示）。
//   2. **平台认识的才给中文人话** —— 只查 spec.platformWords（fieldmeta 的
//      PLATFORM_WORDS，也就是 payload.js 那 10 个词）。⛔ 表外的一个字都不
//      翻译，只给「上游官方原话」（那条还是上游自己写的英文，⛔ 不改写）。
//   3. **不新增任何校验** —— 界面只展示「反射/上游说了什么」。
//      必填标记来自反射结果里的 required 字段，⛔ 不是平台自己判的。
// ---------------------------------------------------------------------------

/** 平台那 10 个词的中文人话。spec 拿不到时退化成空表（界面照样能跑）。 */
function usePlatformWords (spec) {
  const map = React.useMemo(() => {
    const out = {}
    for (const w of (spec && spec.platformWords) || []) out[w.key] = w
    return out
  }, [spec])
  return map
}

/**
 * 一条参数的说明。
 * ⭐ 优先级（⛔ 照这个来，别调）：
 *   ① 平台认识的词 → fieldmeta 的中文人话（用户看得懂的那个）
 *   ② 其余 → 反射给的理由（`_why`，可能含 REPLACE_ME）或上游 help 的英文
 * ⭐ 两条都不编：没有就说没有，⛔ 不许自己写一句「这个参数控制 xxx」。
 */
function ParamHelp ({ item, words, t }) {
  const w = words && words[item.name]
  if (w) {
    return (
      <>
        <div className="field-hint">{t(w.help, w.help)}</div>
        {w.warn && <div className="plan-warn">⚠ {t(w.warn, w.warn)}</div>}
      </>
    )
  }
  const why = item._why || (item.help && item.help.en) || ''
  if (!why) {
    return (
      <div className="field-hint">
        {t('The upstream did not say what this does. Open the official wording below to check.',
          '上游没说这个是干什么的。展开下面的「上游官方原话」自己对照。')}
      </div>
    )
  }
  // ⚠ _why 里可能含 REPLACE_ME —— 那是提醒「这里要人填」，如实显示
  return <div className="field-hint">{why}</div>
}

/**
 * ⭐⭐ 「上游官方原话」折叠块。
 *
 * ⛔⛔ 原话逐字显示，⛔ 不翻译、不改写、不缩写、不补标点。
 *    用户要的就是上游自己写的那句（「Comma-separated 8-dimensional emotion
 *    vector」顺带告诉了用户怎么填，比平台猜的准）。
 *
 * ⚠ 两种内容叠在一起，⛔ 不许合并：
 *   ① `item._cli` —— 直接同名自动贴上的那一条（上游自己写成同名 = 事实）
 *   ② `cli.flags`  —— 上游 CLI 的**全部** flag 摊开（Owner 定：乙）。
 *      不配对的那些参数，用户照着自己对照。
 *      ⛔ 这不是冗余：① 只是「这条大概率是它」，② 才是完整的答案。
 */
function UpstreamWords ({ item, cli, t }) {
  const own = item._cli || null
  const rest = ((cli && cli.flags) || []).filter((f) => {
    if (!own) return true
    // 直接同名那条在 ① 里已经单独显示了，⛔ 不在 ② 里重复列同一份
    return !(f.dest === own.dest && f.source_file === own.source_file)
  })
  const total = (own ? 1 : 0) + rest.length
  if (!total) {
    return (
      <p className="field-hint">
        {t('This engine has no CLI on disk, so there is no official wording to show. '
          + 'Read the upstream source, or write the description yourself.',
          '盘上没有这台引擎的 CLI，没有官方原话可看。读上游源码，或自己写说明。')}
      </p>
    )
  }
  return (
    <>
      {own && (
        <div className="field">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <code>{own.flag}</code>
            {own.subcommand && <span className="badge badge-neutral">{own.subcommand}</span>}
            {own.required && <span className="badge badge-warn">{t('required', '上游要求必填')}</span>}
            <span className="badge badge-ok">
              {t('same name as this parameter', '与本参数同名')}
            </span>
          </div>
          <div className="field-hint">{own.help || t('(no help text)', '（上游没写说明）')}</div>
        </div>
      )}
      <p className="field-hint">
        {t(`${rest.length} other upstream flags. They are listed whole, not matched to this `
          + 'parameter: the upstream uses different words for the same thing, and guessing '
          + 'the pairing would silently send the user down the wrong path.',
          `上游另外 ${rest.length} 个 flag，整份摊开，不与本参数配对：`
          + '上游对同一个东西用的是另一套词，猜对应关系会静默地把用户引到错的路上。')}
      </p>
      <div className="param-grid">
        {rest.map((f) => (
          <div key={f.dest + '|' + f.source_file + '|' + (f.subcommand || '')} className="field">
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <code>{f.is_option ? f.flags.join(' ') : f.flags[0]}</code>
              {f.subcommand && <span className="badge badge-neutral">{f.subcommand}</span>}
              {f.required && <span className="badge badge-warn">{t('required', '上游要求必填')}</span>}
              {f.choices && <span className="badge badge-info">{f.choices.join(' / ')}</span>}
              <span className="badge badge-muted">{f.source_file}</span>
            </div>
            <div className="field-hint">{f.help || t('(no help text)', '（上游没写说明）')}</div>
          </div>
        ))}
      </div>
    </>
  )
}

/** 一条参数的卡片：名字 + 徽标 + 中文人话 + 上游原话（可展开） */
function DraftItem ({ item, words, cli, t }) {
  const isPlatform = !!(words && words[item.name])
  return (
    <div className="card">
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <code>{item.name}</code>
        {isPlatform && (
          <span className="badge badge-ok">
            {t((words[item.name] && words[item.name].label) || 'platform word', '平台认识的')}
          </span>
        )}
        {item.type && <span className="badge badge-neutral">{item.type}</span>}
        {item.phase && <span className="badge badge-neutral">{item.phase}</span>}
        {item.required === true && (
          <span className="badge badge-danger">{t('you must fill this', '这个必须你填')}</span>
        )}
        {item._needs_review && (
          <span className="badge badge-warn">{t('type guessed from name', '类型按名字猜的')}</span>
        )}
        {item._platform_key && (
          <span className="badge badge-warn">{t('platform word', '平台词')}</span>
        )}
      </div>
      <ParamHelp item={item} words={words} t={t} />
      {/* ⭐ 上游原话默认折叠 —— 每条都摊开是噪音，要的人自己点。
          ⛔ 用项目的 .expert-block（⛔ 不许裸 <details>，那个没边框/间距）*/}
      <details className="expert-block" style={{ marginTop: 6 }}>
        <summary className="expert-summary">
          {t('Upstream official wording', '上游官方原话')}
        </summary>
        <div style={{ marginTop: 8 }}>
          <UpstreamWords item={item} cli={cli} t={t} />
        </div>
      </details>
    </div>
  )
}

/**
 * ⭐⭐ 三块分区的主组件。
 * ① 平台已自动填好的  ② 必须你填的  ③ 可以不管的（默认折叠）
 */
function DraftBlocks ({ organized, cli, spec }) {
  const { t } = useT()
  const words = usePlatformWords(spec)
  const byKey = {}
  for (const b of organized.blocks || []) byKey[b.key] = b.items || []

  // ⛔ 显示侧的最后一道守卫：一条参数都不许丢。
  //   数据侧 organizeDraft 已经保证过，这里再查一次 —— 因为「界面少显示一条」
  //   和「数据少一条」是同一个后果（用户永远看不到那个旋钮），而显示侧是
  //   唯一离用户最近的那一层。
  const shown = (byKey.must || []).length + (byKey.may || []).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* ---- ① 平台已自动填好的 ---- */}
      <div className="card">
        <strong>{t('Already handled for you', '平台已自动填好的')}</strong>
        <p className="field-hint">
          {t('These platform words already point at an engine parameter in this manifest. '
            + 'Nothing to do here.',
            '这些平台词在这张名片里已经指向引擎参数了，不用再动。')}
        </p>
        {(byKey.auto || []).length === 0 ? (
          <p className="field-hint">
            {t('None yet. Tick rows in the platform word candidates below to map them.',
              '还没有。在下面的「平台词候选」里勾选即可映射。')}
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            {(byKey.auto || []).map((item) => (
              <div key={item.name} className="field">
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <code>{item.name}</code>
                  <span className="badge badge-ok">{t('platform word', '平台词')}</span>
                  {words[item.name] && (
                    <span>{t(words[item.name].label, words[item.name].label)}</span>
                  )}
                  {item._mapped_to && (
                    <span className="badge badge-neutral">
                      {t(`→ ${item._mapped_to}`, `→ ${item._mapped_to}`)}
                    </span>
                  )}
                </div>
                {words[item.name] && (
                  <div className="field-hint">{t(words[item.name].help, words[item.name].help)}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- ② 必须你填的（排最前 + 高亮）---- */}
      <div className="card">
        <strong>
          {t(`You must fill these (${(byKey.must || []).length})`,
            `必须你填的（${(byKey.must || []).length} 条）`)}
        </strong>
        <p className="field-hint">
          {t('The upstream requires these, but the platform cannot tell what they mean. '
            + 'Each one needs a label and a description from you.',
            '上游要求这几个必须给，但平台说不出它们是什么意思。每一条都要你写名字和说明。')}
        </p>
        {(byKey.must || []).length === 0 ? (
          <p className="field-hint">
            {t('None. Every required parameter is already handled.',
              '没有。必填参数都已经处理好了。')}
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            {(byKey.must || []).map((item) => (
              <DraftItem key={item.name} item={item} words={words} cli={cli} t={t} />
            ))}
          </div>
        )}
      </div>

      {/* ---- ③ 可以不管的（默认折叠）---- */}
      <details className="expert-block">
        <summary className="expert-summary">
          {t(`Optional knobs you can ignore (${(byKey.may || []).length})`,
            `可以不管的（${(byKey.may || []).length} 条）`)}
        </summary>
        <p className="field-hint" style={{ marginTop: 8 }}>
          {t('The upstream has defaults for all of these. Leave them alone unless a user '
            + 'asks for that knob.',
            '这些上游都给了默认值。没人要就别动。')}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
          {(byKey.may || []).map((item) => (
            <DraftItem key={item.name} item={item} words={words} cli={cli} t={t} />
          ))}
        </div>
      </details>

      {shown !== organized.counts.must + organized.counts.may && (
        <div className="msg msg-warning">
          {t(`Only ${shown} of ${organized.counts.must + organized.counts.may} parameters are shown. `
            + 'Some are missing from the screen.',
            `只显示了 ${shown} 条，应有 ${organized.counts.must + organized.counts.may} 条。`
            + '有参数没显示出来。')}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ⭐ 从源码反射生成 parameters[] 草稿 + 映射候选（第 4 步）
//
// ⛔⛔ 三条纪律（硬约束，违反即返工）：
//   1. 只填**表单**，⛔ 绝不直接写 manifest.json —— 落盘是用户按「保存」的事
//   2. 映射候选只给候选，**人点选之后**才写 maps，⛔ 绝不自动落盘
//   3. 不新增任何平台侧校验逻辑 —— 界面只展示「反射说了什么」
// ---------------------------------------------------------------------------
function ReflectPanel ({ manifest, onChange, spec }) {
  const { t } = useT()
  const { installed } = useInstalled()
  const [engineId, setEngineId] = React.useState(manifest.id || '')
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState(null)
  const [err, setErr] = React.useState(null)
  // ⭐ 勾上的候选才会被采纳 —— 默认全不勾（「人点选后才写」这条纪律的界面形态）
  const [picked, setPicked] = React.useState({})

  // 引擎目录名：优先表单里已填的 id，否则让用户从已装的里挑
  React.useEffect(() => {
    if (!engineId && manifest.id) setEngineId(manifest.id)
  }, [manifest.id])

  const run = async () => {
    if (!engineId) return
    setBusy(true)
    setErr(null)
    setResult(null)
    setPicked({})
    try {
      // ⭐ 多方法引擎：把名片 call.methods 里声明的**真实方法名**传给后端，
      //   否则只反射加载期（构造参数），推理期参数（tts_text / prompt_wav…）
      //   一个都拿不到 —— 那正是用户要配的东西。
      //   ⛔ 单方法引擎（没写 call.methods）不传 ⇒ 后端走 call.method 单个反射。
      const methodsByName = (manifest.call && manifest.call.methods) || {}
      const methodList = Object.values(methodsByName)
        .map((m) => (m && m.method) || null)
        .filter(Boolean)
      const r = await fetch('/wizard/params', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: engineId,
          // ⭐ 名片里已经有的 maps 只用来打「已映射」标记，⛔ 不会覆盖
          existingMaps: manifest.maps || {},
          existing: (manifest.parameters || []).map((p) => p.name),
          // ⭐ 多方法引擎的推理方法真名（inference_sft / inference_zero_shot…）
          ...(methodList.length ? { methods: methodList } : {}),
        }),
      })
      const j = await r.json()
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return }
      setResult(j)
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  const applyParams = () => {
    if (!result) return
    // ⭐ 把草稿**追加**进表单（同名的不覆盖已有人手写的）
    const existing = manifest.parameters || []
    const have = new Set(existing.map((p) => p.name))
    const added = result.parameters
      .filter((p) => !have.has(p.name))
      .map((p) => ({
        name: p.name,
        type: p.type,
        phase: p.phase,
        tier: p.tier,
        group: p.group,
        order: p.order,
        label: p.label,
        help: p.help,
        // ⚠ _needs_review 一路带过去 —— 界面要能显示「这条类型是猜的」
        ...(p._needs_review ? { _needs_review: true, _why: p._why } : {}),
        ...(p._platform_key ? { _platform_key: true, _why: p._why } : {}),
      }))
    onChange({ ...manifest, parameters: [...existing, ...added] })
  }

  const applyMaps = () => {
    if (!result) return
    // ⭐ 只有**勾上的**才写 maps。默认一个都不勾。
    const next = { ...(manifest.maps || {}) }
    let n = 0
    for (const row of result.map_candidates) {
      const pick = picked[row.platform_key]
      if (!pick) continue
      next[row.platform_key] = pick
      n += 1
    }
    onChange({ ...manifest, maps: next })
    setErr(null)
    // 采纳后把这些行标成已映射（界面即时反映，不重发请求）
    setResult({ ...result, map_candidates: result.map_candidates.map((r) => ({
      ...r,
      already_mapped: Object.prototype.hasOwnProperty.call(next, r.platform_key),
    })) })
  }

  const pickedCount = Object.keys(picked).length

  return (
    <div className="section">
      <div className="section-hdr">
        <h2>{t('Reflect from source', '从源码反射生成')}</h2>
      </div>
      <div className="section-body">
        <p className="field-hint" style={{ marginTop: 0 }}>
          {t('Read the engine\'s own source on this machine and list the knobs it '
            + 'exposes. Source, environment and weights must already be on disk '
            + '(steps 1-3), so this works offline.',
            '读本机上这台引擎自己的源码，列出它暴露的旋钮。源码、环境、权重需已在盘上'
            + '（第 1-3 步），因此这一步不联网。')}
        </p>
        <p className="plan-warn">
          {t('This fills the form only. It never writes manifest.json, and mapped '
            + 'platform words stay candidates until you tick them.',
            '只填表单，不直接写 manifest.json。映射候选在你勾选之后才会写进 maps。')}
        </p>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input className="control" style={{ maxWidth: 220 }}
            value={engineId} placeholder={t('engine id', '引擎 id')}
            onChange={(e) => setEngineId(e.target.value)} />
          {installed.length > 0 && (
            <select className="control" style={{ maxWidth: 200 }}
              value="" onChange={(e) => e.target.value && setEngineId(e.target.value)}>
              <option value="">{t('or pick…', '或选一个…')}</option>
              {installed.map((e) => (
                <option key={e.id} value={e.id}>{e.id}</option>
              ))}
            </select>
          )}
          <button className="btn btn-sm btn-primary" type="button"
            disabled={!engineId || busy} onClick={run}>
            {busy ? t('Reflecting…', '反射中…') : t('Reflect', '反射')}
          </button>
        </div>

        {err && <div className="msg msg-danger" style={{ marginTop: 8 }}>{err}</div>}

        {result && (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="msg msg-info">
              {t(`Reflected ${result.counts.reflected} named parameters: `
                + `${result.counts.parameters} for the form, `
                + `${result.counts.excluded} excluded (each says why), `
                + `${result.counts.map_candidates} platform-word candidates.`,
                `反射到 ${result.counts.reflected} 个具名参数：草稿 ${result.counts.parameters} 条，`
                + `排除 ${result.counts.excluded} 条（每条都写了原因），`
                + `平台词候选 ${result.counts.map_candidates} 组。`)}
            </div>
            {result.partial && (
              <div className="msg msg-warning">
                {t('The reflection is incomplete: ', '反射结果不完整：') + result.partial_reason}
              </div>
            )}

            {/* ⭐⭐ 第 2 步：按「用户操作流」三块分区。
                ⛔ 这不是把参数拆开，是**同一份草稿的重排视图** ——
                  organizeDraft 保证 must + may === parameters.length，
                  一条都不许丢（丢一条 = 界面上少一个旋钮，且不报错）。 */}
            {result.organized && result.organized.ok ? (
              <DraftBlocks organized={result.organized} cli={result.cli} />
            ) : (
              /* ⚠ 分区失败不许静默退回旧视图 —— 那会把「分错了」说成「没参数」。
                 如实说，并把原始草稿留在下面。 */
              <div className="msg msg-warning">
                {t('Could not group the draft: ', '参数分区没做成：')
                  + (result.organized ? result.organized.error : '分区结果缺失')}
              </div>
            )}

            {/* ---- ① 参数草稿原文（三块视图的数据来源，⛔ 不许删）---- */}
            <details className="expert-block">
              <summary className="expert-summary">
                {t(`Raw draft (${result.counts.parameters} parameters)`,
                  `原始草稿（${result.counts.parameters} 条参数）`)}
              </summary>
              <div style={{ marginTop: 8 }}>
                <div className="form-grid" style={{ alignItems: 'center' }}>
                  <button className="btn btn-sm" type="button" onClick={applyParams}>
                    + {t('Append to form', '追加到表单')}
                  </button>
                </div>
                {result.parameters.length === 0 ? (
                  <p className="field-hint">
                    {t('No parameters survived the exclusions. Check the excluded list below.',
                      '排除之后没有剩下任何参数。看看下面的排除清单。')}
                  </p>
                ) : (
                  <div className="param-grid" style={{ marginTop: 8 }}>
                    {result.parameters.map((p) => (
                      <div key={p.name} className="field">
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                          <code>{p.name}</code>
                          <span className="badge badge-neutral">{p.type}</span>
                          <span className="badge badge-neutral">{p.phase}</span>
                          {p._needs_review && (
                            <span className="badge badge-warn">
                              {t('type guessed from name', '类型按名字猜的')}
                            </span>
                          )}
                          {p._platform_key && (
                            <span className="badge badge-warn">
                              {t('platform word', '平台词')}
                            </span>
                          )}
                        </div>
                        <div className="field-hint">{p._why || p.help?.en || ''}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </details>

            {/* ---- ② 映射候选：单独一栏，人勾选后才写 maps ---- */}
            <div className="card">
              <div className="form-grid" style={{ alignItems: 'center' }}>
                <strong>
                  {t('Platform word candidates (maps)', '平台词候选（maps）')}
                </strong>
                <button className="btn btn-sm btn-primary" type="button"
                  disabled={pickedCount === 0} onClick={applyMaps}>
                  {pickedCount > 0
                    ? t(`Write ${pickedCount} into maps`, `写 ${pickedCount} 条进 maps`)
                    : t('Nothing ticked', '未勾选')}
                </button>
              </div>
              <p className="field-hint">
                {t('Nothing is written until you tick a row. Rows already mapped in '
                  + 'the manifest are marked and never overwritten automatically.',
                  '未勾选前什么都不写。名片里已映射的行会被标出，⛔ 不会自动覆盖。')}
              </p>
              {result.map_candidates.length === 0 ? (
                <p className="field-hint">
                  {t('No parameter name looks like a platform word.',
                    '没有一个参数名像平台词。')}
                </p>
              ) : (
                <div className="param-grid" style={{ marginTop: 8 }}>
                  {result.map_candidates.map((row) => (
                    <div key={row.platform_key} className="field">
                      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input type="checkbox"
                          checked={!!picked[row.platform_key]}
                          onChange={(e) => {
                            const next = { ...picked }
                            if (e.target.checked) next[row.platform_key] = row.candidates[0].engine_param
                            else delete next[row.platform_key]
                            setPicked(next)
                          }} />
                        <code>{row.platform_key}</code>
                        {row.already_mapped && (
                          <span className="badge badge-ok">
                            {t(`mapped → ${row.current}`, `已映射 → ${row.current}`)}
                          </span>
                        )}
                      </label>
                      {picked[row.platform_key] ? (
                        <select className="control"
                          value={picked[row.platform_key]}
                          onChange={(e) => setPicked({ ...picked, [row.platform_key]: e.target.value })}>
                          {row.candidates.map((c) => (
                            <option key={c.engine_param} value={c.engine_param}>
                              {c.engine_param} ({c.phase}, {c.score})
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className="field-hint">
                          {row.candidates.map((c) => c.engine_param).join(' / ')}
                          {row.candidates[0] ? ` — ${row.candidates[0].why}` : ''}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ---- ③ 排除清单：每条都说了为什么 ---- */}
            {result.excluded.length > 0 && (
              <div className="card">
                <strong>
                  {t(`Excluded (${result.excluded.length})`, `排除的（${result.excluded.length} 条）`)}
                </strong>
                <div className="param-grid" style={{ marginTop: 8 }}>
                  {result.excluded.map((e) => (
                    <div key={e.phase + e.name} className="field">
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <code>{e.name}</code>
                        <span className="badge badge-neutral">{e.phase}</span>
                        {e.needs_human && (
                          <span className="badge badge-warn">
                            {t('needs a human', '需要人定')}
                          </span>
                        )}
                      </div>
                      <div className="field-hint">{e.reason}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <p className="plan-warn">{result.caveat}</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
export default function ManifestForm ({ manifest, onChange, spec }) {
  const { t } = useT()
  const { installed } = useInstalled()
  const [importId, setImportId] = React.useState('')
  const [importing, setImporting] = React.useState(false)
  const [importErr, setImportErr] = React.useState(null)

  if (!spec) {
    return <p className="field-hint" style={{ margin: 0 }}>
      {t('Loading field spec…', '正在读字段规格…')}
    </p>
  }

  const set = (k, v) => {
    const next = { ...manifest }
    if (v === undefined || v === '') delete next[k]
    else next[k] = v
    onChange(next)
  }

  // ---- 从已有引擎导入 ----
  const handleImport = async () => {
    if (!importId) return
    setImporting(true)
    setImportErr(null)
    try {
      const r = await fetch(`/wizard/manifest/${encodeURIComponent(importId)}`)
      const j = await r.json()
      if (!r.ok || !j.ok) {
        setImportErr(j.error || `HTTP ${r.status}`)
        return
      }
      const src = j.manifest
      const next = { ...manifest }
      // 核心字段
      if (src.runtime) next.runtime = src.runtime
      if (src.call) next.call = src.call
      if (src.maps) next.maps = src.maps
      if (src.parameters) next.parameters = src.parameters
      if (src.capabilities) next.capabilities = src.capabilities
      if (src.models) next.models = src.models
      if (src.weights) next.weights = src.weights
      if (src.upstream) next.upstream = src.upstream
      if (src.install) next.install = src.install
      if (src.output_formats) next.output_formats = src.output_formats
      if (src.max_chars) next.max_chars = src.max_chars
      if (src.max_chars_source) next.max_chars_source = src.max_chars_source
      if (src.timeout_ms) next.timeout_ms = src.timeout_ms
      if (src.timeout_ms_source) next.timeout_ms_source = src.timeout_ms_source
      if (src.base_url_env) next.base_url_env = src.base_url_env
      if (src.default_base_url) next.default_base_url = src.default_base_url
      onChange(next)
    } catch (e) {
      setImportErr(e.message)
    } finally {
      setImporting(false)
    }
  }

  const setParam = (i, v) => {
    const list = [...(manifest.parameters || [])]
    list[i] = v
    set('parameters', list)
  }
  const addParam = () => set('parameters', [...(manifest.parameters || []),
    { name: '', type: 'text', tier: 'common' }])
  const delParam = (i) => {
    const list = [...(manifest.parameters || [])]
    list.splice(i, 1)
    set('parameters', list.length ? list : undefined)
  }

  const byGroup = {}
  for (const s of spec.sections) {
    if (s.group === 'parameters') continue      // ⛔ 单独渲染，不进分组表
    // ⛔ 这三段有专门的嵌套编辑器（NestedSections.jsx）
    if (NESTED_GROUPS.includes(s.group)) continue
    ;(byGroup[s.group] = byGroup[s.group] || []).push(s)
  }

  const gLabel = (g) => {
    const L = GROUP_LABELS[g]
    return L ? t(L.en, L.zh) : g
  }

  // ---- 字段分组：核心 vs 高级 ----
  const CORE_GROUPS = ['basics', 'runtime', 'call']
  const ADVANCED_GROUPS = ['source', 'models', 'capabilities', 'install', 'output']

  const coreSections = GROUP_ORDER.filter((g) => CORE_GROUPS.includes(g) && byGroup[g])
  const advancedSections = GROUP_ORDER.filter((g) => ADVANCED_GROUPS.includes(g) && byGroup[g])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* ---- 从已有引擎导入 ---- */}
      {installed.length > 0 && (
        <div className="section">
          <div className="section-hdr"><h2>{t('Import from existing engine', '从已有引擎导入')}</h2></div>
          <div className="section-body">
            <p className="field-hint" style={{ marginTop: 0 }}>
              {t('Import core fields (runtime, call, maps, parameters, etc.) from an '
                + 'already-installed engine. This saves you from filling in everything '
                + 'from scratch.',
                '从已安装的引擎导入核心字段（runtime、call、maps、parameters 等），'
                + '省去从头填写所有字段的负担。')}
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select className="control" value={importId}
                onChange={(e) => setImportId(e.target.value)}
                style={{ minWidth: 200 }}>
                <option value="">{t('Select an engine…', '选择一个引擎…')}</option>
                {installed.map((e) => (
                  <option key={e.id} value={e.id}>{e.id}</option>
                ))}
              </select>
              <button className="btn btn-sm btn-primary" type="button"
                disabled={!importId || importing} onClick={handleImport}>
                {importing ? t('Importing…', '导入中…') : t('Import', '导入')}
              </button>
            </div>
            {importErr && (
              <div className="msg msg-danger" style={{ marginTop: 8 }}>
                {importErr}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---- 核心字段（必填）---- */}
      {coreSections.map((g) => (
        <div className="section" key={g}>
          <div className="section-hdr"><h2>{gLabel(g)}</h2></div>
          <div className="section-body">
            {byGroup[g].map((s) => (
              <Field key={s.key} sec={s}
                value={manifest[s.key]}
                onChange={(v) => set(s.key, v)} />
            ))}
          </div>
        </div>
      ))}

      {/* ---- models：权重在哪、哪几个文件算齐 ---- */}
      <div className="section">
        <div className="section-hdr"><h2>{gLabel('models')}</h2></div>
        <div className="section-body">
          <ModelsSection value={manifest.models}
            onChange={(x) => set('models', x)} t={t} />
        </div>
      </div>

      {/* ---- runtime：怎么把引擎拉起来（三段里最必填的一段）---- */}
      <div className="section">
        <div className="section-hdr"><h2>{gLabel('runtime')}</h2></div>
        <div className="section-body">
          <RuntimeSection value={manifest.runtime}
            onChange={(x) => set('runtime', x)} t={t} />
        </div>
      </div>

      {/* ---- call：怎么调它（没有 call 段的引擎走老宿主，也是合法的）---- */}
      <div className="section">
        <div className="section-hdr"><h2>{gLabel('call')}</h2></div>
        <div className="section-body">
          <p className="field-hint" style={{ marginTop: 0 }}>
            {t('Engines without a call section are started by a different, older '
              + 'path — that is a valid shape, not an error.',
              '没有 call 段的引擎由另一条较早的路径启动，这是合法形式，不属于错误。')}
          </p>
          <CallSection value={manifest.call}
            onChange={(x) => set('call', x)} t={t} />
        </div>
      </div>

      {/* ---- 高级字段（可选，折叠）---- */}
      {advancedSections.length > 0 && (
        <details className="expert-block">
          <summary className="expert-summary">
            {t('Advanced settings (optional)', '高级设置（可选）')}
          </summary>
          <div style={{ paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {advancedSections.map((g) => (
              <div className="section" key={g}>
                <div className="section-hdr"><h2>{gLabel(g)}</h2></div>
                <div className="section-body">
                  {byGroup[g].map((s) => (
                    <Field key={s.key} sec={s}
                      value={manifest[s.key]}
                      onChange={(v) => set(s.key, v)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* ---- ⭐ 从源码反射生成（第 4 步：只填表单，不落盘）---- */}
      <ReflectPanel manifest={manifest} onChange={onChange} spec={spec} />

      {/* ---- parameters：界面参数 ---- */}
      <div className="section">
        <div className="section-hdr"><h2>{gLabel('parameters')}</h2></div>
        <div className="section-body">
          <p className="field-hint" style={{ marginTop: 0 }}>
            {t('⚠ These fields all live inside Advanced Settings (collapsed by '
              + 'default); none appear in the main area. Every entry you add is '
              + 'one more thing the user has to look at.',
              '以上参数全部位于 Advanced Settings（默认折叠）内，主区域不会显示。'
              + '每多写一条，用户的界面上就多一格。')}
          </p>
          {(manifest.parameters || []).map((p, i) => (
            <ParamRow key={i} entry={p || {}} index={i} spec={spec}
              onChange={setParam} onDelete={delParam} />
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <button className="btn btn-sm" type="button" onClick={addParam}>
              + {t('Add a parameter', '添加一个参数')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
