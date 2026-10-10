import React from 'react'
import { useT } from '../../../web/src/lib/i18n'

// ============================================================================
//  NESTED SECTION —— 嵌套段的填表（runtime / call / models）
//
//  ⭐ 为什么单独一个文件
//  这三段不是「几个键」，而是**嵌套结构**：
//    runtime.verify.sys_path[] / imports[].class …
//    call.init_args{} / bind{三槽位} / methods{每个方法一套} / args[]
//    models.required[] / source.command[]
//  ⇒ 一个键一个 input 画不出来。
//
//  ⛔⛔ 但**不照抄任何一张真名片** —— 真名片形状各不相同，
//  照抄 = 第二份事实，必然漂移。⇒ 这里按**形状分类**，每种形状一个编辑器。
//
//  ⭐ 排版全部用项目类：.field / .field-label / .field-hint / .control /
//    .plan-warn / .badge / .table / .expert-block / .expert-summary
//    ⛔⛔ 之前自造的 .nx-row/.nx-label/.nx-ctl/.nx-obj/.nx-obj-row/.nx-lineno
//      全项目 CSS 里一个定义都没有 ⇒ 那一大块是纯裸奔。
//
//  ⛔⛔ 纪律：不许出现任何具体引擎名。
// ============================================================================

// ---------------------------------------------------------------------------
// 一行：键名 + 说明 + 控件
// ⭐ 第 3 章警告三级（RFC）：按 danger 分色，不再一律拍成黄。
//   BLOCK（平台会抛错、装不上）→ .msg-danger 红框
//   SILENT（设了没效果、填错不报错）→ .msg-warn 黄框
//   INFO（纯提示）→ .field-hint 灰字（不是框）
//   ⛔ 只用平台现成类，不新增 class、不 inline style。
// ---------------------------------------------------------------------------
// warn 文案按 danger 档位套不同的平台类（第 3 章）
const WARN_BOX = {
  block: 'msg-danger',   // 红框：真会阻断加载
  silent: 'msg-warn',    // 黄框：设了没效果
  info: 'field-hint',    // 灰字：纯提示
}
function Row ({ label, hint, warn, children, danger }) {
  const { t } = useT()
  return (
    <div className="field">
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <label className="field-label" style={{ margin: 0 }}><code>{label}</code></label>
        {danger === 'silent' && (
          <span className="badge badge-warn">
            {t('no error if wrong', '填错不报错')}
          </span>
        )}
        {danger === 'block' && (
          <span className="badge badge-danger">
            {t('blocks loading', '填错装不上')}
          </span>
        )}
      </div>
      {hint && <div className="field-hint">{hint}</div>}
      {/* ⭐ 按 danger 分色：block 红框 / silent 黄框 / info 灰字 */}
      {warn && <div className={WARN_BOX[danger] || 'msg-warn'}>⚠ {warn}</div>}
      {children}
    </div>
  )
}

/** 逗号分隔 ↔ 数组 */
function ArrayField ({ value, onChange, placeholder, t }) {
  return (
    <input className="control" type="text"
      value={Array.isArray(value) ? value.join(', ') : (value || '')}
      placeholder={placeholder || t('comma separated', '逗号分隔')}
      onChange={(e) => {
        const raw = e.target.value.trim()
        onChange(raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : undefined)
      }} />
  )
}

// ⭐ ArgsField —— call.args 编辑器（cli 形态）：一张 {name:{flag,style}} 的表格。
//   ⛔ 不能套 ArrayField（那是字符串数组）也不能套 ObjectField（value 是对象不是标量）。
//   每行：name（键）/ flag（--flag）/ style（value|boolean）/ 删除。可新增行。
function ArgsField ({ value, onChange, t }) {
  const v = (value && typeof value === 'object') ? value : {}
  const rows = Object.entries(v).map(([name, a]) => ({
    name,
    flag: (a && a.flag) || '',
    style: (a && a.style) || 'value',
  }))
  const emit = (next) => {
    const obj = {}
    for (const r of next) {
      if (!r.name) continue
      obj[r.name] = { flag: r.flag, style: r.style }
    }
    onChange(Object.keys(obj).length ? obj : undefined)
  }
  return (
    <div>
      {/* ⭐ 用项目的 .table（与 ObjectField/LinesField 一致），⛔ 不再裸 table + inline style */}
      <table className="table">
        <thead>
          <tr>
            <th>name</th>
            <th>flag</th>
            <th>style</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <input className="control" type="text" value={r.name}
                  onChange={(e) => {
                    const next = rows.slice(); next[i] = { ...r, name: e.target.value }; emit(next)
                  }} />
              </td>
              <td>
                <input className="control" type="text" value={r.flag} placeholder="--flag"
                  onChange={(e) => {
                    const next = rows.slice(); next[i] = { ...r, flag: e.target.value }; emit(next)
                  }} />
              </td>
              <td>
                <select className="control" value={r.style}
                  onChange={(e) => {
                    const next = rows.slice(); next[i] = { ...r, style: e.target.value }; emit(next)
                  }}>
                  <option value="value">value</option>
                  <option value="boolean">boolean</option>
                </select>
              </td>
              <td>
                <button className="btn btn-sm" type="button"
                  onClick={() => emit(rows.filter((_, j) => j !== i))}>
                  {t('del', '删')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn btn-sm" type="button" style={{ marginTop: 4 }}
        onClick={() => emit([...rows, { name: '', flag: '--', style: 'value' }])}>
        {t('Add flag', '加一个参数')}
      </button>
    </div>
  )
}

/** key → value 的浅对象（init_args 这类）—— ⭐ 用项目的 .table 画「键 值 ×」三列 */
function ObjectField ({ value, onChange, t }) {
  const obj = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {}
  const rows = Object.entries(obj)
  const [k, setK] = React.useState('')
  const [v, setV] = React.useState('')
  return (
    <table className="table">
      <tbody>
        {rows.map(([kk, vv]) => (
          <tr key={kk}>
            <td style={{ width: '30%' }}><code>{kk}</code></td>
            <td>
              <input className="control" type="text" value={String(vv)}
                onChange={(e) => onChange({ ...obj, [kk]: e.target.value })} />
            </td>
            <td style={{ width: 48 }}>
              <button className="btn btn-sm" type="button"
                onClick={() => {
                  const next = { ...obj }; delete next[kk]; onChange(next)
                }}>×</button>
            </td>
          </tr>
        ))}
        <tr>
          <td>
            <input className="control" type="text" placeholder={t('key', '键名')}
              value={k} onChange={(e) => setK(e.target.value)} />
          </td>
          <td>
            <input className="control" type="text" placeholder={t('value', '值')}
              value={v} onChange={(e) => setV(e.target.value)} />
          </td>
          <td>
            <button className="btn btn-sm" type="button"
              onClick={() => {
                if (!k.trim()) return
                onChange({ ...obj, [k.trim()]: v })
                setK(''); setV('')
              }}>+</button>
          </td>
        </tr>
      </tbody>
    </table>
  )
}

/** 逐行字符串数组（args / command 这类）—— 同样用 .table：序号 值 × */
function LinesField ({ value, onChange, t }) {
  const lines = Array.isArray(value) ? value : []
  const [line, setLine] = React.useState('')
  return (
    <table className="table">
      <tbody>
        {lines.map((l, i) => (
          <tr key={i}>
            <td style={{ width: 48, color: 'var(--muted)', fontSize: 11 }}>{i + 1}</td>
            <td>
              <input className="control" type="text" value={String(l)}
                onChange={(e) => {
                  const next = [...lines]; next[i] = e.target.value; onChange(next)
                }} />
            </td>
            <td style={{ width: 48 }}>
              <button className="btn btn-sm" type="button"
                onClick={() => onChange(lines.filter((_, j) => j !== i))}>×</button>
            </td>
          </tr>
        ))}
        <tr>
          <td />
          <td>
            <input className="control" type="text"
              placeholder={t('add a line', '加一行')} value={line}
              onChange={(e) => setLine(e.target.value)} />
          </td>
          <td>
            <button className="btn btn-sm" type="button"
              onClick={() => {
                if (!line.trim()) return
                onChange([...lines, line.trim()]); setLine('')
              }}>+</button>
          </td>
        </tr>
      </tbody>
    </table>
  )
}

// ---------------------------------------------------------------------------
// runtime.verify —— 装没装 / 起不来得来，就看它
// ---------------------------------------------------------------------------
function VerifyField ({ value, onChange, t }) {
  const v = (value && typeof value === 'object') ? value : {}
  const set = (patch) => onChange({ ...v, ...patch })
  const sysPath = Array.isArray(v.sys_path) ? v.sys_path : []
  const imports = Array.isArray(v.imports) ? v.imports : []
  const [np, setNp] = React.useState({ module: '', class: '', methods: '' })

  return (
    <>
      <Row label="sys_path"
        hint={t('paths the engine needs on sys.path (relative to the project root)',
          '引擎运行前需要加进 sys.path 的目录（相对项目根）')}
        danger="silent">
        <ArrayField value={sysPath} t={t} onChange={(a) => set({ sys_path: a })} />
      </Row>

      <Row label="imports"
        hint={t('what the platform should import to decide whether the engine is '
          + 'installed — module, class, and the method names',
          '平台依据 import 的模块、类、方法名判断该引擎是否已安装')}>
        <table className="table">
          <tbody>
            {imports.map((im, i) => (
              <tr key={i}>
                <td>
                  <input className="control" type="text" placeholder="module"
                    value={im.module || ''}
                    onChange={(e) => {
                      const next = [...imports]
                      next[i] = { ...im, module: e.target.value }
                      set({ imports: next })
                    }} />
                </td>
                <td>
                  <input className="control" type="text" placeholder="class"
                    value={im.class || ''}
                    onChange={(e) => {
                      const next = [...imports]
                      next[i] = { ...im, class: e.target.value }
                      set({ imports: next })
                    }} />
                </td>
                <td>
                  <input className="control" type="text" placeholder="method, method"
                    value={Array.isArray(im.methods)
                      ? im.methods.join(', ') : (im.methods || '')}
                    onChange={(e) => {
                      const next = [...imports]
                      next[i] = { ...im, methods: e.target.value
                        .split(',').map((s) => s.trim()).filter(Boolean) }
                      set({ imports: next })
                    }} />
                </td>
                <td style={{ width: 48 }}>
                  <button className="btn btn-sm" type="button"
                    onClick={() => set({ imports: imports.filter((_, j) => j !== i) })}
                  >×</button>
                </td>
              </tr>
            ))}
            <tr>
              <td>
                <input className="control" type="text" placeholder="module"
                  value={np.module}
                  onChange={(e) => setNp({ ...np, module: e.target.value })} />
              </td>
              <td>
                <input className="control" type="text" placeholder="class"
                  value={np.class}
                  onChange={(e) => setNp({ ...np, class: e.target.value })} />
              </td>
              <td>
                <input className="control" type="text" placeholder="method, method"
                  value={np.methods}
                  onChange={(e) => setNp({ ...np, methods: e.target.value })} />
              </td>
              <td>
                <button className="btn btn-sm" type="button"
                  onClick={() => {
                    if (!np.module.trim()) return
                    const one = { module: np.module.trim() }
                    if (np.class.trim()) one.class = np.class.trim()
                    if (np.methods.trim()) {
                      one.methods = np.methods.split(',').map((s) => s.trim()).filter(Boolean)
                    }
                    set({ imports: [...imports, one] })
                    setNp({ module: '', class: '', methods: '' })
                  }}>+</button>
              </td>
            </tr>
          </tbody>
        </table>
      </Row>
    </>
  )
}

// ---------------------------------------------------------------------------
// call.bind —— 槽位，对应平台的固定词表
// ---------------------------------------------------------------------------
function BindField ({ value, onChange, t }) {
  const v = (value && typeof value === 'object') ? value : {}
  const set = (k, val) => {
    const next = { ...v }
    if (val === '') delete next[k]
    else next[k] = val
    onChange(Object.keys(next).length ? next : undefined)
  }
  // 平台词表是固定的那几个 —— ⛔ 那属于平台，不属于名片，这里只提示不强制
  const SLOTS = ['text', 'ref_audio', 'ref_text', 'ref_lang', 'text_lang', 'out']
  return (
    <>
      {SLOTS.map((slot) => (
        <Row key={slot} label={slot}
          hint={slot === 'text'
            ? t('required. Maps the input text to an argument name',
              '必填。将输入文本映射到上游对应的参数名')
            : t('maps to an argument name upstream; leave empty when this engine '
              + 'has no such concept',
              '映射到上游哪个参数名；这台引擎没这个概念就留空')}>
          <input className="control" type="text" value={v[slot] || ''}
            placeholder={t('argument name', '参数名')}
            onChange={(e) => set(slot, e.target.value.trim())} />
        </Row>
      ))}
      {/* ⭐ 映射错误不会报错 = 设了没效果 ⇒ SILENT 黄框（第 3 章）*/}
      <p className="msg msg-warn">
        {t('Confirm which upstream argument each of the 3 core inputs goes to: '
          + 'the text to synthesize / the reference audio / the output. '
          + 'The platform has already matched them automatically; just check them.',
          '确认 3 个核心输入对应上游哪个参数：要合成的文字 / 参考音频 / 输出。机器已自动匹配，核对即可。')}
      </p>
    </>
  )
}

/** call.methods —— 每个方法一套 bind/时序 */
function MethodsField ({ value, onChange, t }) {
  const v = (value && typeof value === 'object') ? value : {}
  const names = Object.keys(v)
  const [name, setName] = React.useState('')
  return (
    <>
      {names.map((n) => {
        const m = v[n] || {}
        return (
          <details key={n} className="expert-block" open>
            <summary className="expert-summary"><code>{n}</code></summary>
            <div style={{ paddingTop: 8 }}>
              <Row label="method" hint={t('the upstream method name', '上游方法名')}>
                <input className="control" type="text" value={m.method || ''}
                  onChange={(e) => onChange({ ...v, [n]: { ...m, method: e.target.value } })} />
              </Row>
              <Row label="requires_ref_audio">
                <select className="control" value={String(m.requires_ref_audio ?? '')}
                  onChange={(e) => onChange({ ...v, [n]: { ...m,
                    requires_ref_audio: e.target.value === ''
                      ? undefined
                      : e.target.value === 'true' } })}>
                  <option value="">{t('(unset)', '（不写）')}</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              </Row>
              <Row label="call_time"
                hint={t('argument names this method accepts at call time',
                  '这个方法在调用时接受哪些参数（参数名列表）')}
                danger="silent">
                <ArrayField value={m.call_time} t={t}
                  onChange={(a) => onChange({ ...v, [n]: { ...m, call_time: a } })} />
              </Row>
              <Row label="bind" hint={t('slot bindings for this method only',
                '只在这个方法里生效的槽位绑定')}>
                <div style={{ paddingLeft: 8 }}>
                  <BindField value={m.bind}
                    onChange={(b) => onChange({ ...v, [n]: { ...m, bind: b } })} t={t} />
                </div>
              </Row>
            </div>
          </details>
        )
      })}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <input className="control" type="text" style={{ width: 'auto', minWidth: 180 }}
          placeholder={names.length === 0
            ? t('zero_shot (default)', 'zero_shot（默认）')
            : t('method id', '方法 id')}
          value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn btn-sm" type="button"
          onClick={() => {
            // ⭐ 第一个方法默认叫 zero_shot（零样本，最常用的合成方式）。
            //   ⛔ 纯 UX 默认：换了方法反射会当场重算参数，不影响任何判断。
            //   ⚠ 只兜第一个（names 还空着）—— 之后让用户自己命名。
            const k = (name.trim() || (names.length === 0 ? 'zero_shot' : '')).trim()
            if (!k || v[k]) return
            onChange({ ...v, [k]: {} }); setName('')
          }}>+</button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// 三段的编辑器
// ---------------------------------------------------------------------------
export function RuntimeSection ({ value, onChange, t }) {
  const v = (value && typeof value === 'object') ? value : {}
  const set = (k, val) => {
    const next = { ...v }
    if (val === undefined || val === '') delete next[k]
    else next[k] = val
    onChange(Object.keys(next).length ? next : undefined)
  }
  return (
    <>
      <Row label="python"
        hint={t('the engine’s own environment directory (e.g. engines/<id>/.venv)',
          '这台引擎自己的环境目录（如 engines/<id>/.venv）')}
        warn={t('use the engine’s own environment directory (e.g. engines/<id>/.venv). '
          + 'An absolute path will not save.',
          '填引擎自己的环境目录（如 engines/<id>/.venv），填绝对路径存不了。')}
        danger="block">
        <input className="control" type="text" value={v.python || ''}
          placeholder="engines/xxx/.venv"
          onChange={(e) => set('python', e.target.value.trim())} />
      </Row>
      <Row label="entry" hint={t('the script that starts the engine (relative to the engine dir)',
        '启动引擎的脚本（相对引擎目录）')}>
        <input className="control" type="text" value={v.entry || ''}
          onChange={(e) => set('entry', e.target.value.trim())} />
      </Row>
      <Row label="args" hint={t('command-line arguments; {placeholders} are filled by the platform',
        '命令行参数；{占位符} 由平台替换')}
        danger="silent">
        <LinesField value={v.args} onChange={(a) => set('args', a)} t={t} />
      </Row>
      <Row label="ready_endpoint"
        hint={t('the path polled to decide the engine is up (must start with /)',
          '轮询哪个路径判断引擎已就绪（必须以 / 开头）')}>
        <input className="control" type="text" value={v.ready_endpoint || ''}
          placeholder="/health"
          onChange={(e) => set('ready_endpoint', e.target.value.trim())} />
      </Row>
      <Row label="ready_timeout_ms"
        hint={t('how long to wait before giving up', '等多久算超时')}
        danger="silent">
        <input className="control" type="number" value={v.ready_timeout_ms ?? ''}
          onChange={(e) => set('ready_timeout_ms',
            e.target.value === '' ? undefined : Number(e.target.value))} />
      </Row>
      <Row label="ready_timeout_ms_source"
        hint={t('required: where that number came from — measured or estimated',
          '必填：需说明该数值的来源（实测或估算）')}
        warn={t('saving is rejected: this number must say where it came from '
          + '(measured / estimated / upstream).',
          '保存时会被打回：这个数字必须说明来源（实测/估算/上游）。')}
        danger="block">
        <select className="control" value={v.ready_timeout_ms_source || ''}
          onChange={(e) => set('ready_timeout_ms_source', e.target.value || undefined)}>
          <option value="">{t('(unset)', '（不写）')}</option>
          <option value="measured">measured</option>
          <option value="estimated">estimated</option>
        </select>
      </Row>
      <Row label="checkpoints" hint={t('where the weights live (relative to project root)',
        '权重放在哪（相对项目根）')} danger="silent">
        <input className="control" type="text" value={v.checkpoints || ''}
          placeholder="models/tts/xxx"
          onChange={(e) => set('checkpoints', e.target.value.trim())} />
      </Row>
      <details className="expert-block">
        <summary className="expert-summary">
          {t('verify (the platform imports these to check installation)',
            'verify（平台靠 import 这些来判断装没装）')}
        </summary>
        <div style={{ paddingTop: 8 }}>
          <VerifyField value={v.verify} onChange={(x) => set('verify', x)} t={t} />
        </div>
      </details>
    </>
  )
}

export function CallSection ({ value, onChange, t }) {
  const v = (value && typeof value === 'object') ? value : {}
  const set = (k, val) => {
    const next = { ...v }
    if (val === undefined || val === '') delete next[k]
    else next[k] = val
    onChange(Object.keys(next).length ? next : undefined)
  }
  return (
    <>
      <Row label="kind"
        hint={t('python = call a class; cli = run a command',
          'python = 调一个类；cli = 跑一条命令')}>
        <select className="control" value={v.kind || ''}
          onChange={(e) => set('kind', e.target.value || undefined)}>
          <option value="">{t('(unset)', '（不写）')}</option>
          <option value="python">python</option>
          <option value="cli">cli</option>
        </select>
      </Row>
      {v.kind !== 'cli' && (<>
        <Row label="module" hint={t('the python module to import', '要 import 的 python 模块')}>
          <input className="control" type="text" value={v.module || ''}
            onChange={(e) => set('module', e.target.value.trim())} />
        </Row>
        <Row label="class" hint={t('the class inside that module', '模块里的哪个类')}>
          <input className="control" type="text" value={v.class || ''}
            onChange={(e) => set('class', e.target.value.trim())} />
        </Row>
        <Row label="method"
          hint={t('the method to call (single-method engines)', '调哪个方法（单方法引擎用）')}>
          <input className="control" type="text" value={v.method || ''}
            onChange={(e) => set('method', e.target.value.trim())} />
        </Row>
        <Row label="init_args"
          hint={t('arguments for the constructor; {checkpoints} is filled by the platform',
            '构造函数的参数；{checkpoints} 由平台替换')}>
          <ObjectField value={v.init_args} onChange={(o) => set('init_args', o)} t={t} />
        </Row>
      </>)}
      <Row label="bind"
        hint={t('which upstream argument each platform input word goes to',
          '平台的每个输入词对应上游哪个参数')}>
        <BindField value={v.bind} onChange={(b) => set('bind', b)} t={t} />
      </Row>
      {v.kind === 'cli' && (
        <>
          <Row label="argv"
            hint={t('the command to run, comma-separated. {engine_python} / {engine_dir} / {root} are filled by the platform',
              '要跑的命令，逗号分隔。{engine_python} / {engine_dir} / {root} 由平台替换')}>
            <ArrayField value={v.argv} onChange={(a) => set('argv', a)} t={t}
              placeholder="{engine_python}, -m, module, synth" />
          </Row>
          <Row label="args"
            hint={t('every command-line flag, one per row. name = key, flag = the --flag, style = value/boolean',
              '每个命令行参数一行。name = 键，flag = --flag，style = value/boolean')}>
            <ArgsField value={v.args} onChange={(a) => set('args', a)} t={t} />
          </Row>
        </>
      )}
      <Row label="returns"
        hint={t('file / bytes / generator — what the method gives back',
          'file / bytes / generator，方法的返回形式')}
        warn={t('a wrong value here fails at call time, not at load time',
          '此处填写错误将在调用时触发，而非加载时')}
        danger="silent">
        <select className="control" value={v.returns || ''}
          onChange={(e) => set('returns', e.target.value || undefined)}>
          <option value="">{t('(unset)', '（不写）')}</option>
          <option value="bytes">bytes</option>
          <option value="file">file</option>
          <option value="generator">generator</option>
        </select>
      </Row>
      <details className="expert-block">
        <summary className="expert-summary">
          {t('methods (engines with several synthesis methods)',
            'methods（一个引擎有多个合成方法时）')}
        </summary>
        <div style={{ paddingTop: 8 }}>
          <p className="field-hint" style={{ marginTop: 0 }}>
            {t('Each method needs its own bind and its own call_time. '
              + 'The platform has a single requires_reference_audio switch at the top '
              + 'level — per-method needs can only be expressed here.',
              '每个方法要各自的 bind 和 call_time。'
              + '顶层的 requires_reference_audio 只有一个总开关，分方法的需求只能在此表达。')}
          </p>
          <MethodsField value={v.methods} onChange={(m) => set('methods', m)} t={t} />
        </div>
      </details>
    </>
  )
}

export function ModelsSection ({ value, onChange, t }) {
  const v = (value && typeof value === 'object') ? value : {}
  const set = (k, val) => {
    const next = { ...v }
    if (val === undefined || val === '') delete next[k]
    else next[k] = val
    onChange(Object.keys(next).length ? next : undefined)
  }
  const src = (v.source && typeof v.source === 'object') ? v.source : {}
  return (
    <>
      <Row label="required"
        hint={t('the files that count as «the weights are there» — the platform '
          + 'can only answer yes/no against this list',
          '用于判断 Checkpoint 是否完整的文件清单，平台据此回答有无')}
        warn={t('this works without it, but then the platform cannot help you check '
          + 'whether the weight files are all present. Listing the key files is recommended.',
          '不填也能用，但平台没法帮你确认权重文件齐不齐。建议列出关键文件。')}
        danger="silent">
        <ArrayField value={v.required} onChange={(a) => set('required', a)} t={t} />
      </Row>
      <Row label="hint" hint={t('shown to the user when the weights are missing',
        '权重缺失时给用户看的说明')}>
        <textarea className="control" rows={2} value={v.hint || ''}
          onChange={(e) => set('hint', e.target.value)} />
      </Row>
      <Row label="source.url" hint={t('where the weights are published', '权重发布在哪儿')}>
        <input className="control" type="text" value={src.url || ''}
          placeholder="https://huggingface.co/..."
          onChange={(e) => set('source', { ...src, url: e.target.value })} />
      </Row>
      <Row label="source.command"
        hint={t('a ready-to-run download command; {checkpoints} is filled by the platform',
          '可直接照抄的下载命令；{checkpoints} 由平台替换')}
        danger="silent">
        <LinesField value={src.command} t={t}
          onChange={(a) => set('source', { ...src, command: a })} />
      </Row>
      {/* ⭐ 平台不代下载 = 纯行为说明 ⇒ INFO 灰字（第 3 章）*/}
      <p className="field-hint" style={{ marginTop: 6 }}>
        {t('The platform does not download anything. It only prints this command '
          + 'with the path filled in. Downloading is the user\'s job.',
          '平台不执行下载，仅填入路径后显示该命令，下载需自行完成。')}
      </p>
    </>
  )
}
