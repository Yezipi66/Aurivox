// 名片表单编辑器：根据 fieldmeta 分组渲染字段输入，并把值交给调用方处理。
// 渲染只依赖项目现有的 UI 组件与类名，不自造字段含义。
// 本文件不负责合成逻辑，只负责界面层的输入与结构。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { RuntimeSection, CallSection, ModelsSection } from './NestedSections'
import RequiredEight from './RequiredEight'
import CoreBindings from './CoreBindings'
import ParamDropZone from './ParamDropZone'
import ParamRow from './ParamRow'
import { shouldAutoFillCheckpoints, withAutoFilledCheckpoints } from './manifestAutoFill'

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

// 彻底不渲染的键：id / label / contract_version。
// autoFill 已经自动填好（id=目录名、label 默认=id、contract_version=2），
// 摆在用户脸上纯属噪音。从 byGroup 构建时直接过滤掉，任何层级都不出现。
const HIDDEN_KEYS = ['id', 'label', 'contract_version']

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

// 从源码反射生成 parameters[] 草稿 + 映射候选（第 4 步）。
// 只填表单，不直接写 manifest.json；映射候选只给候选，人点选之后才写 maps。

// 主组件操作流：
// ① 核心绑定区：平台三个输入对应引擎哪个参数
// ② 必填 8 项：平台当场校验的那几个键
// ③ 界面参数区：左栏扫到的参数拖到这里，成为名片的一条界面参数
// ④ 折叠：常用可选（runtime/capabilities）与审计高级（source/models/install/output）
//
// 扫描发生在左栏（EngineScanZone），扫描结果由页面层持有并传进来。
export default function ManifestForm ({
  manifest, onChange, spec, checkpointsPath, autofill, selectedParam,
}) {
  const { t } = useT()

  // runtime.checkpoints 自动填成第 3 步的下载落点。
  //
  // 为什么自动填：第 3 步把权重下到哪儿是后端定的（core/checkpointsPath.js），
  //   第 4 步的名片要声明同一处。不自动填的话，使用者得自己把这两个界面里的
  //   路径对上，而两个路径长得极像（engines/<id>/checkpoints 与 models/tts/<id>），
  //   填错时当场没有报错，症状是「第 3 步说下好了、第 5 步说目录不存在」。
  //
  // 只在两个条件下填：引擎 id 已经定了（否则算不出路径），且这一格要么空着，
  //   要么指着一台别的引擎（换引擎时留下的上一台残留）。
  //   使用者填过、指的又是当前这台，就不动他填的。
  //   落盘路径由后端送来，前端不自己拼。
  // 判定与填值在 manifestAutoFill.js 里，是纯函数，可以单独测。
  React.useEffect(() => {
    if (!shouldAutoFillCheckpoints(manifest, checkpointsPath)) return
    onChange(withAutoFilledCheckpoints(manifest, checkpointsPath))
    // onChange 不进依赖：它每次渲染都是新函数，进了就变成一直触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkpointsPath, manifest && manifest.id, manifest && manifest.runtime && manifest.runtime.checkpoints])

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
  // L1 核心（常驻展开）：核心绑定区 + 必填 8 项 + 界面参数区
  // L2 常用可选（折叠，有值时提示）：runtime 嵌套编辑器 + capabilities 平铺键 + call 其余字段
  // L3 审计高级（永远折叠）：models 嵌套编辑器 + source/install/output 平铺键
  // 首屏只出 L1。
  //
  // call 段的归属：CoreBindings 只管 bind 三槽位，call 的其余字段在 L2 的
  // CallSection 里编辑。一个 call 两处编辑，但管的是不同的字段，不冲突。
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

  // 「有值时提示」：L2/L3 折叠标题上挂徽标，表示该折叠内已有内容。
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

      {/* L1 ① 核心绑定区：核心映射（combobox + 匹配状态） */}
      <CoreBindings call={manifest.call} onChange={(x) => set('call', x)}
        candidates={autofill && autofill.argList || []}
        matched={autofill && autofill.matched || null}
        scanned={!!autofill} />

      {/* L1 ② 必填 8 项（平台当场抛错的那 8 个） */}
      <RequiredEight manifest={manifest} onChange={onChange} />

      {/* L1 ③ 界面参数区：左栏扫到的参数拖到这里，成为名片的一条界面参数 */}
      <ParamDropZone manifest={manifest} onChange={onChange}
        params={manifest.parameters || []} selectedParam={selectedParam}
        spec={spec} ParamRow={ParamRow} />

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
              <RuntimeSection value={manifest.runtime} onChange={(x) => set('runtime', x)} t={t}
                checkpointsPath={checkpointsPath} />
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
        </div>
      </details>
    </div>
  )
}
