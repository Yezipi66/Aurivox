import React from 'react'
import { useT } from '../../../web/src/lib/i18n'

// 必填区：平台当场会校验的那些格子，全在一个两列网格里。
//
// 为什么合成一个网格：
//   拆成「核心输入」与「运行与能力」两小段，读起来像两类不同重要性的东西，
//   而它们是同一件事：缺任何一格，这张名片都接不上平台。
//     call.bind 三槽位（text / ref_audio / output_path）缺了，平台的三个输入没处去；
//     其余各格缺了，lib/engines/profile.js 加载名片时直接抛错。
//   所以去掉小标题，合成一个网格。
//
// 每格的形状统一成「中文人话 + 键名徽标」：
//   「合成文本」后面跟一个写着 text 的徽标，键名照样看得见，
//   但读起来是人话而不是一串路径。
//
// 键名徽标里写的是「这一格在名片里的键名」：
//   三个输入槽位写的是槽位名（text / ref_audio / output_path），
//   平台固定认这三个词，槽位里的值是引擎那边的参数名。
//   其余各格写的是名片的键路径（runtime.python、capabilities.requires_reference_audio…）。
//   两套词汇不混：槽位名不是名片键，填进去也不会写进名片的顶层。
//
// 排版用项目已有的类（.section / .section-hdr / .section-body / .field /
// .field-label / .field-hint / .control / .form-grid / .badge），不新增 class；
// 不写具体引擎名（有守卫测试）。

// 一格：中文人话 + 键名徽标 + 说明 + 控件。
// 徽标是键名，标签是人话，两者同一个 flex 行里，不靠颜色区分。
// wide：这一格占满一行（格子里的控件不止一个，放半行里挤）。
function Cell ({ label, code, hint, wide, children }) {
  return (
    <div className={`field${wide ? ' form-grid-wide' : ''}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <label className="field-label" style={{ margin: 0 }}>{label}</label>
        <span className="badge badge-accent">{code}</span>
      </div>
      {hint && <div className="field-hint">{hint}</div>}
      {children}
    </div>
  )
}

// 出处那一格的下拉选项：平台的三个词（lib/engines/profile/topkeys.js 的 MEASURED_SOURCES）。
// measured = 本项目量出来的；upstream = 上游文档写的；estimated = 推算或经验值。
const SOURCES = ['measured', 'upstream', 'estimated']

export default function RequiredFields ({ manifest, onChange, autofill, bindSlots }) {
  const { t } = useT()
  const runtime = (manifest && manifest.runtime) || {}
  const caps = (manifest && manifest.capabilities) || {}
  const bind = (manifest && manifest.call && manifest.call.bind) || {}
  const matched = (autofill && autofill.matched) || null
  const candidates = (autofill && autofill.argList) || []
  const scanned = !!autofill

  // 拖到某一格上：绑这一格。cli 形态写开关本身（--text），python 写参数名。
  const [overSlot, setOverSlot] = React.useState(null)
  const dropOn = (key) => (e) => {
    e.preventDefault()
    setOverSlot(null)
    let param
    try { param = JSON.parse(e.dataTransfer.getData('text/plain') || 'null') } catch { return }
    if (param && param.target) setSlot(key, param.target)
  }

  // 改 runtime / capabilities 段里的一个键：只改该段，别处不动。
  const setRuntime = (patch) => {
    const next = { ...runtime, ...patch }
    // 值为 undefined 时删掉这个键，别把 undefined 写进名片。
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
    onChange({ ...manifest, runtime: Object.keys(next).length ? next : undefined })
  }
  const setCaps = (patch) => {
    const next = { ...caps, ...patch }
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
    onChange({ ...manifest, capabilities: Object.keys(next).length ? next : undefined })
  }
  // 改名片顶层的一个键。
  const setTop = (key, v) => {
    const next = { ...manifest }
    if (v === undefined || v === '') delete next[key]
    else next[key] = v
    onChange(next)
  }
  // 改 runtime 段里「出处」那一格。
  const setRuntimeSource = (key, v) => {
    const next = { ...runtime }
    if (v === undefined || v === '') delete next[key]
    else next[key] = v
    onChange({ ...manifest, runtime: next })
  }
  // 改顶层「出处」那一格。
  const setTopSource = (key, v) => {
    const next = { ...manifest }
    if (v === undefined || v === '') delete next[key]
    else next[key] = v
    onChange(next)
  }
  // 改 call.bind 的一个槽位。
  const setSlot = (key, value) => {
    const call = manifest.call || {}
    const nextBind = { ...bind }
    if (value === '') delete nextBind[key]
    else nextBind[key] = value
    onChange({ ...manifest, call: { ...call, bind: nextBind } })
  }
  // 参考音频时长：平台收 null（不限制）或 [最短秒, 最长秒]。
  // 这一格的值是数组或 null，不是标量 ⇒ 单独一个 setter。
  const setClip = (value) => {
    const next = { ...caps }
    if (value === null) next.reference_clip_seconds = null
    else next.reference_clip_seconds = value
    onChange({ ...manifest, capabilities: next })
  }

  const listId = 'core-bind-flaglist'

  // 三个输入槽位：平台的 bind 槽位。每一格也是拖拽落点。
  // 槽位清单来自 /wizard/spec 的 bindSlots（平台 lib/engines/hostProfile.js 的
  // BIND_SLOTS 原样），不在这里手抄。手抄的那份与平台不同步时，
  // 这一格给的槽位名平台根本不认 ⇒ 使用者填完、保存后加载才被拒。
  const SLOT_LABELS = {
    text: { labelEn: 'Text to synthesize', labelZh: '合成文本' },
    ref_audio: { labelEn: 'Reference audio', labelZh: '参考音频' },
    output_path: { labelEn: 'Output path', labelZh: '输出' },
  }
  const SLOT_KEYS = (bindSlots && bindSlots.length)
    ? bindSlots
    : Object.keys(SLOT_LABELS)
  const slots = SLOT_KEYS.map((key) => ({
    key,
    labelEn: (SLOT_LABELS[key] || {}).labelEn || key,
    labelZh: (SLOT_LABELS[key] || {}).labelZh || key,
  }))

  // reference_clip_seconds 那一格的值：null（不限制）或 [最短, 最长]。
  const clip = caps.reference_clip_seconds
  const clipUnlimited = clip === null
  const clipMin = Array.isArray(clip) ? clip[0] : ''
  const clipMax = Array.isArray(clip) ? clip[1] : ''

  return (
    <div className="section">
      <div className="section-hdr"><h2>{t('Required fields', '必填字段')}</h2></div>
      <div className="section-body">
        <div className="form-grid">

          {slots.map((slot) => {
            const val = bind[slot.key] || ''
            const guessed = matched && matched[slot.key] || null
            const isMatched = !!guessed
            const isScanned = scanned && !guessed
            return (
              <Cell key={slot.key}
                label={t(slot.labelEn, slot.labelZh)} code={slot.key}
                hint={isScanned
                  ? t('No engine parameter was recognized for this input. Pick from the candidates or type a parameter name.',
                    '引擎参数中未识别出此输入。从候选中选择，或直接填写参数名。')
                  : null}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    className={`control${isMatched ? ' wz-field-matched' : (isScanned ? ' wz-field-guess' : '')}${overSlot === slot.key ? ' wz-dropzone-over' : ''}`}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOverSlot(slot.key) }}
                    onDragLeave={() => setOverSlot(null)}
                    onDrop={dropOn(slot.key)}
                    list={listId}
                    value={val}
                    placeholder={isScanned ? t('Pick from candidates or type a parameter name', '从候选选择，或输入参数名') : ''}
                    onChange={(e) => setSlot(slot.key, e.target.value)}
                  />
                  {isMatched && (
                    <span className="badge badge-ok">{t('matched by scan', '扫描已匹配')}</span>
                  )}
                  {isScanned && (
                    <span className="badge badge-warn">{t('not matched, specify', '未匹配，需指定')}</span>
                  )}
                </div>
              </Cell>
            )
          })}

          <Cell label={t('Environment directory', '环境目录')}
            code="runtime.python"
            hint={t('this engine’s own environment directory, e.g. engines/<id>/.venv',
              '这台引擎自己的环境目录，如 engines/<id>/.venv')}>
            <input className="control" type="text" placeholder="engines/xxx/.venv"
              value={runtime.python || ''}
              onChange={(e) => setRuntime({ python: e.target.value.trim() })} />
          </Cell>

          <Cell label={t('Start script', '启动脚本')}
            code="runtime.entry"
            hint={t('relative to the engine directory', '相对引擎目录')}>
            <input className="control" type="text"
              value={runtime.entry || ''}
              onChange={(e) => setRuntime({ entry: e.target.value.trim() })} />
          </Cell>

          <Cell label={t('Ready endpoint', '就绪端点')}
            code="runtime.ready_endpoint"
            hint={t('the path polled to decide the engine is up; must start with /',
              '轮询哪个路径判断引擎已就绪，必须以 / 开头')}>
            <input className="control" type="text" placeholder="/health"
              value={runtime.ready_endpoint || ''}
              onChange={(e) => setRuntime({ ready_endpoint: e.target.value.trim() })} />
          </Cell>

          <Cell label={t('Ready timeout (ms)', '就绪等待（毫秒）')}
            code="runtime.ready_timeout_ms"
            hint={t('how long to wait before deciding the engine is not ready',
              '等多久算引擎没就绪')}>
            <input className="control" type="number"
              value={runtime.ready_timeout_ms ?? ''}
              onChange={(e) => setRuntime({
                ready_timeout_ms: e.target.value === '' ? undefined : Number(e.target.value),
              })} />
          </Cell>

          <Cell label={t('Where that number came from', '那个数的出处')}
            code="runtime.ready_timeout_ms_source"
            hint={t('required once the timeout is written', '填了等待时间就必填')}>
            <select className="control"
              value={runtime.ready_timeout_ms_source || ''}
              onChange={(e) => setRuntimeSource('ready_timeout_ms_source',
                e.target.value || undefined)}>
              <option value="">{t('(unset)', '（不写）')}</option>
              {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Cell>

          <Cell label={t('Request timeout (ms)', '单次请求超时（毫秒）')}
            code="timeout_ms"
            hint={t('counted per segment, not per whole piece', '按每一段计，不是整篇')}>
            <input className="control" type="number"
              value={manifest.timeout_ms ?? ''}
              onChange={(e) => setTop('timeout_ms',
                e.target.value === '' ? undefined : Number(e.target.value))} />
          </Cell>

          <Cell label={t('Where that number came from', '那个数的出处')}
            code="timeout_ms_source"
            hint={t('required once the timeout is written', '填了超时时间就必填')}>
            <select className="control"
              value={manifest.timeout_ms_source || ''}
              onChange={(e) => setTopSource('timeout_ms_source', e.target.value || undefined)}>
              <option value="">{t('(unset)', '（不写）')}</option>
              {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Cell>

          <Cell label={t('Longest text per request', '单次请求最长字符数')}
            code="max_chars"
            hint={t('slow engines need a smaller number', '慢引擎要调小，否则单段就撑爆超时')}>
            <input className="control" type="number"
              value={manifest.max_chars ?? ''}
              onChange={(e) => setTop('max_chars',
                e.target.value === '' ? undefined : Number(e.target.value))} />
          </Cell>

          <Cell label={t('Where that number came from', '那个数的出处')}
            code="max_chars_source"
            hint={t('required once the limit is written', '填了上限就必填')}>
            <select className="control"
              value={manifest.max_chars_source || ''}
              onChange={(e) => setTopSource('max_chars_source', e.target.value || undefined)}>
              <option value="">{t('(unset)', '（不写）')}</option>
              {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Cell>

          <Cell label={t('Needs reference audio', '是否需要参考音频')}
            code="capabilities.requires_reference_audio"
            hint={t('whether a request without a reference recording is rejected',
              '没有参考音频的请求要不要被拦下来')}>
            <select className="control"
              value={String(caps.requires_reference_audio ?? '')}
              onChange={(e) => setCaps({
                requires_reference_audio: e.target.value === '' ? undefined : e.target.value === 'true',
              })}>
              <option value="">{t('(unset)', '（不写）')}</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </Cell>

          <Cell label={t('Output sample rate (Hz)', '输出采样率（Hz）')}
            code="capabilities.output_sample_rate"
            hint={t('the platform uses it to build the silence between segments',
              '平台靠它生成段间静音与拼接')}>
            <input className="control" type="number"
              value={caps.output_sample_rate ?? ''}
              onChange={(e) => setCaps({
                output_sample_rate: e.target.value === '' ? undefined : Number(e.target.value),
              })} />
          </Cell>

          <Cell label={t('Reference audio duration (s)', '参考音频时长（秒）')}
            code="capabilities.reference_clip_seconds"
            hint={t('write null for no limit; otherwise the shortest and the longest',
              '不限制就写 null，否则填最短与最长')}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input className="control" type="number" placeholder={t('shortest', '最短')}
                value={clipMin}
                onChange={(e) => {
                  const v = e.target.value === '' ? 0 : Number(e.target.value)
                  const max = Array.isArray(clip) ? clip[1] : 0
                  setClip([v, max])
                }} />
              <input className="control" type="number" placeholder={t('longest', '最长')}
                value={clipMax}
                onChange={(e) => {
                  const v = e.target.value === '' ? 0 : Number(e.target.value)
                  const min = Array.isArray(clip) ? clip[0] : 0
                  setClip([min, v])
                }} />
              {clipUnlimited && (
                <span className="badge badge-muted">null</span>
              )}
              <button className="btn btn-sm" type="button"
                onClick={() => setClip(clipUnlimited ? [3, 10] : null)}>
                {clipUnlimited ? t('set a range', '设一个范围') : t('no limit', '不限制')}
              </button>
            </div>
          </Cell>

        </div>

        {candidates && candidates.length > 0 && (
          <datalist id={listId}>
            {candidates.map((a) => <option key={a.target} value={a.target}>{a.help || ''}</option>)}
          </datalist>
        )}
      </div>
    </div>
  )
}
