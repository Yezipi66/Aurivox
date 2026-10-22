import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { RuntimeSection, CallSection, ModelsSection } from './NestedSections'
import { useInstalled } from './useInstalled'
import RequiredEight from './RequiredEight'
import CliGenPanel from './CliGenPanel'
import CoreBindings from './CoreBindings'

// 名片填表：按分组渲染每一项，高危字段当场挂徽标，参数区是可增删的行。
// 分组与字段清单来自 /wizard/spec（fieldmeta 是唯一权威），不手写清单。
// 渲染只用项目已有的类（.section / .field / .field-label / .field-hint / .control /
// .param-grid / .plan-warn / .rc-cmd / .expert-block / .expert-summary / .badge / .msg），
// 不自造 mf-* / pr-*。

// 分组标题：用平台的词汇，不自己造中文名。
// 不用「怎么起进程」这种说法：平台自己的界面从不这么叫它。
// 造一套「更friendly」的说法等于造第二套词汇，用户学的是这边的词、填的是平台的键，两边不匹配。
// 显示键名，说明放在 fieldmeta 的 howto 里。
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

// 彻底不渲染的键：id / label / contract_version。
// autoFill 已经自动填好（id=目录名、label 默认=id、contract_version=2），
// 摆在用户脸上纯属噪音。从 byGroup 构建时直接过滤掉，任何层级都不出现。
const HIDDEN_KEYS = ['id', 'label', 'contract_version']

// 这三段是嵌套结构，有专门的编辑器（NestedSections.jsx），
// 不能「一个键一个 input」：那样只显示说明、填不了值。
// call 的完整编辑器常驻 L1 核心绑定区；runtime 归 L2、models 归 L3。
// 三个编辑器无条件渲染，不靠 spec 平铺字段判空。
const NESTED_GROUPS = ['runtime', 'call', 'models']

// 段容器键本身：这些键的值是对象或数组（不是标量），
// 绝不能走平铺 Field（input 会把对象渲染成 [object Object]，改了就毁数据）。
// runtime/call/models 有专门嵌套编辑器（NestedSections）；
// capabilities/weights/upstream/install 是嵌套对象或数组，各有归属区或专门处理；
// parameters/maps 归「界面参数区」（下方单独渲染，不进这里）。
// 这些键跳过平铺渲染，但它们组内的平铺子字段（runtime 组的
// max_chars/base_url_env、capabilities 组的开关等）照常渲染。
const CONTAINER_KEYS = [
  'runtime', 'call', 'models', 'weights', 'capabilities',
  'upstream', 'install', 'parameters', 'maps',
]

// 顶层哪些键是「简单值」 直接给个输入框；哪些是对象/数组  展开写
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
      {/* 键名 + 填错不报错徽标同一行（内联 flex，照 TrainingTab 的写法）*/}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <label className="field-label" style={{ margin: 0 }} title={sec.howto}>
          <code>{sec.key}</code>
        </label>
        {sec.danger === 'silent' && (
          <span className="badge badge-warn">
            {t('no error if wrong', '填错不报错')}
          </span>
        )}
        {sec.danger === 'block' && (
          <span className="badge badge-danger">
            {t('blocks loading', '填错装不上')}
          </span>
        )}
      </div>
      <div className="field-hint">{sec.howto}</div>
      {/* 警告按 sec.danger 分三档：block→msg-danger 红框 / silent→msg-warn 黄框 / info→field-hint 灰字 */}
      {sec.warn && (
        <div className={
          sec.danger === 'block' ? 'msg msg-danger'
            : sec.danger === 'silent' ? 'msg msg-warn'
              : 'field-hint'
        }> {sec.warn}</div>
      )}
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
      {sec.structure && (
        <div className="rc-cmd">
          <pre className="rc-cmd-body">{sec.structure}</pre>
        </div>
      )}
    </div>
  )
}

// 参数区：可增删的行
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

      {/* .param-grid：项目给「一堆小字段」准备的（2 列，gap 10px，
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

      {/* 折叠用项目的 .expert-block + .expert-summary
          （不用裸 <details>：那个没有边框和间距，跟整页其它折叠长得不一样）*/}
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
        {/* repeat 填错不报错：设了没效果。silent 档用黄框（msg-warn）*/}
        <p className="msg msg-warn">
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

// 从源码反射生成 parameters[] 草稿 + 映射候选（第 4 步）。
// 只填表单，不直接写 manifest.json；映射候选只给候选，人点选之后才写 maps。

// 主组件操作流：
// ① 顶部：从 CLI 扫描生成（新建/读取名片 → 扫描参数 → 参数表 → 自动填）
// ② 中部：手工编辑（导入已有 / 核心字段 runtime+call+models / 反射生成）
// ③ 折叠：高级设置（source/capabilities/install/output）+ 参数区 parameters
export default function ManifestForm ({ manifest, onChange, spec }) {
  const { t } = useT()
  const { installed } = useInstalled()

  // 扫描状态：CliGenPanel 扫成功后回调 onScanDone(true)，核心绑定区展开并滚动定位。
  // 这不是 CliGenPanel 的内部状态：主组件要据此开合 L1 的绑定区，所以上提到这里。
  const [scanDone, setScanDone] = React.useState(false)
  const bindRef = React.useRef(null)

  // autofill 状态：CliGenPanel 扫成功后回调 onAutoFilled，把匹配记录传上来，
  // L1 的 CoreBindings 靠它渲染「扫描已匹配 / 未匹配，需指定」。
  // matched = { text, ref_audio, output_path }（null 表示没认出）
  // candidates = 当前子命令的 flag 列表（combobox 候选）
  // 必须放在早返回（!spec）之前，否则 Hooks 顺序会乱（Rendered more hooks）。
  const [autofill, setAutofill] = React.useState(null)

  // 扫描成功后绑定区自动展开并滚动定位。用 useEffect 等 DOM 渲染完再滚，
  // 不在回调里直接滚（那时还没挂载）。
  React.useEffect(() => {
    if (scanDone && bindRef.current) {
      bindRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [scanDone])

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

  // byGroup 构建：嵌套段（runtime/call/models）保留在 byGroup 里，嵌套编辑器无条件渲染。
  // 但「段容器键本身」（runtime/call/models/weights/capabilities…值非标量）
  // 要从平铺渲染里剔除，否则 Field 会把对象渲染成 [object Object]。
  const byGroup = {}
  for (const s of spec.sections) {
    if (s.group === 'parameters') continue
    if (HIDDEN_KEYS.includes(s.key)) continue
    if (CONTAINER_KEYS.includes(s.key)) continue
    ;(byGroup[s.group] = byGroup[s.group] || []).push(s)
  }

  const gLabel = (g) => {
    const L = GROUP_LABELS[g]
    return L ? t(L.en, L.zh) : g
  }

  // 三级分组：
  // L1 核心（常驻展开）：扫描面板 + call 全量编辑器 + 必填 8 项
  // L2 常用可选（折叠，有值时提示）：runtime 嵌套编辑器 + capabilities 平铺键
  // L3 审计高级（永远折叠）：models 嵌套编辑器 + source/install/output 平铺键
  // 首屏只出 L1。
  //
  // call 段的归属：完整编辑器（CallSection）常驻在 L1 核心绑定区，L2 不再重复放 call，
  // 否则一个 call 两个编辑器，改一处另一处不同步。
  const L2_GROUPS = ['runtime', 'capabilities']
  const L3_GROUPS = ['source', 'models', 'install', 'output']

  // L2/L3 的嵌套段（runtime / models）用 NestedSections 的全量编辑器，
  // 平铺键（upstream / max_chars_source / base_url_env / output_formats 等）用 Field。
  // 一个组可能既有嵌套段又有平铺键，分开渲染。
  // 嵌套段无条件渲染，不依赖 byGroup[g] 判空：嵌套段写死在 JSX 里
  // （L2=RuntimeSection、L3=ModelsSection，call 的 CallSection 在 L1 常驻），
  // 与 spec 有没有平铺字段无关。平铺字段仍走 byGroup 判空。
  const l2Flat = L2_GROUPS.filter((g) => byGroup[g])
  const l3Flat = L3_GROUPS.filter((g) => byGroup[g])

  // 「有值时提示」：L2/L3 折叠标题上挂徽标，一眼看出这折叠里已有内容。
  // 键路径要取对：args/cwd 在 runtime 下、streaming 在 capabilities 下，不是顶层键，
  // 取顶层会永远取空，徽标永不出现。
  const hasVal = (paths) => paths.some((path) => {
    const v = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), manifest)
    return v !== undefined && v !== null && v !== ''
  })

  // 核心绑定区（call.bind）在 L1 常驻展开。扫描成功不改变其开合，只触发滚动定位
  // （见上方 useEffect）。不用 bindOpen 变量控制 details：绑定区是 L1，不是折叠项。

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* L1 ① 扫描面板：第一屏只做这个（选引擎 + 扫描 + 自动填） */}
      <CliGenPanel manifest={manifest} onChange={onChange}
        onScanDone={() => setScanDone(true)}
        onAutoFilled={({ matched, argList }) => setAutofill({ matched, argList })} />

      {/* L1 ② 核心绑定区：核心映射（combobox + 匹配状态） */}
      <div ref={bindRef}>
        <CoreBindings call={manifest.call} onChange={(x) => set('call', x)}
          candidates={autofill && autofill.argList || []}
          matched={autofill && autofill.matched || null}
          scanned={!!autofill} />
      </div>

      {/* L1 ③ 必填 8 项（平台当场抛错的那 8 个） */}
      <RequiredEight manifest={manifest} onChange={onChange} />

      {/* ---- L2 常用可选（折叠，有值时提示）---- */}
      <details className="expert-block" open={false}>
        <summary className="expert-summary">
          {t('Common options (optional)', '常用可选')}
          {hasVal(['runtime.args', 'runtime.cwd', 'capabilities.streaming']) && (
            <span className="badge badge-info" style={{ marginLeft: 6 }}>
              {t('has values', '已有内容')}
            </span>
          )}
        </summary>
        <div style={{ paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {l2Flat.map((g) => (
            <div className="section" key={g}>
              <div className="section-hdr"><h2>{gLabel(g)}</h2></div>
              <div className="section-body">
                {byGroup[g].map((s) => (
                  <Field key={s.key} sec={s} value={manifest[s.key]} onChange={(v) => set(s.key, v)} />
                ))}
              </div>
            </div>
          ))}
          {/* L2 嵌套段：runtime（全量嵌套编辑器）。
              无条件渲染 RuntimeSection：嵌套字段（python/entry/args/
              ready_endpoint/ready_timeout_ms/verify…）都要能改。 */}
          <div className="section">
            <div className="section-hdr"><h2>{gLabel('runtime')}</h2></div>
            <div className="section-body">
              <RuntimeSection value={manifest.runtime} onChange={(x) => set('runtime', x)} t={t} />
            </div>
          </div>
          {/* L2 嵌套段：call 其余字段（kind/module/class/method/init_args/returns）。
              CoreBindings 只负责 bind 三槽位，call 的其它字段在这里编辑。 */}
          <div className="section">
            <div className="section-hdr"><h2>{gLabel('call')}</h2></div>
            <div className="section-body">
              <CallSection value={manifest.call} onChange={(x) => set('call', x)} t={t} />
            </div>
          </div>
        </div>
      </details>

      {/* ---- L3 审计高级（永远折叠）---- */}
      <details className="expert-block" open={false}>
        <summary className="expert-summary">
          {t('Audit / advanced (rarely needed)', '审计与高级（多数用不到）')}
          {hasVal(['upstream', 'install', 'models', 'weights', 'base_url_env']) && (
            <span className="badge badge-info" style={{ marginLeft: 6 }}>
              {t('has values', '已有内容')}
            </span>
          )}
        </summary>
        <div style={{ paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {l3Flat.map((g) => (
            <div className="section" key={g}>
              <div className="section-hdr"><h2>{gLabel(g)}</h2></div>
              <div className="section-body">
                {byGroup[g].map((s) => (
                  <Field key={s.key} sec={s} value={manifest[s.key]} onChange={(v) => set(s.key, v)} />
                ))}
              </div>
            </div>
          ))}
          {/* L3 嵌套段：models（全量嵌套编辑器）。
              无条件渲染 ModelsSection：嵌套字段（required/hint/
              source.url/source.command）都要能改。 */}
          <div className="section">
            <div className="section-hdr"><h2>{gLabel('models')}</h2></div>
            <div className="section-body">
              <ModelsSection value={manifest.models} onChange={(x) => set('models', x)} t={t} />
            </div>
          </div>
          {/* 界面参数区：参数表（永远折叠） */}
          <div className="section">
            <div className="section-hdr"><h2>{gLabel('parameters')}</h2></div>
            <div className="section-body">
              <p className="field-hint" style={{ marginTop: 0 }}>
                {t(' These fields all live inside Advanced Settings (collapsed by default); none appear in the main area.',
                  '以上参数全部位于 Advanced Settings（默认折叠）内，主区域不会显示。')}
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
      </details>
    </div>
  )
}
