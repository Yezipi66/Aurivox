import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { useInstalled } from './useInstalled'

//  CLI GEN PANEL：扫描引擎参数并自动填进名片（cli 与 python 两条路共用）
//
// 操作流：
//   进来 → [读取名片]（改已有引擎）或 [新建名片]（默认新建）
//   新建后 → [扫描参数] → 调 /wizard/discover 自动探测引擎形态
//     · cli 路：列出上游命令行的 flag 表（官方说明 / 必填选填 / 类型）
//     · python 路：列出函数签名参数（按加载期 / 调用期分组）
//   → 平台自动填一批进名片（bind 三槽位 + args，不要求用户逐个勾）
//   → 用户手动编辑补改 → 最下面 [保存]
//
// mode 流转 idle → scan → read：
//   · idle：两个入口（读取 / 新建）各自清晰
//   · scan：选引擎 → 扫描；扫描控件行定高（group select 扫描前占位、
//     扫描后填值，只换内容不换高度，禁止布局跳变）
//   · read：读取磁盘原文后进编辑态（P0 成果，不许改回空壳）
//   · 扫描成功 → 回调 onScanDone() 主组件展开核心绑定区并滚动定位
//
// 只填表单不落盘（落盘是 SaveBar 的事）；help 原样递出不改写；
//   探不到时如实显示 notes，不假装。

// computeAutoFill：纯函数：把扫描到的参数转成 call 段建议值
//
// 为什么纯函数：
//   旧实现 autoFill 读闭包里的 manifest.call，而 doScan 里 setScan(j) 是
//   异步的。用户快速切子命令时 scan 还是上一次的旧值，用旧 args 填新子命令。
//   现在：入参全部显式（params / currentCall），返回建议值 + 匹配记录，
//    不读任何组件 state，不直接 onChange。
//
// 入参 params：统一形状 [{source, name, target, kind, style, help, required, group, is_tool}]
//   · cli 路：name 是开关去掉横线的部分，target 是开关本身，进 call.args
//   · python 路：name 与 target 同名，都是上游方法的参数名，不进 call.args
//   · 两路各有一张词表：kind 是给界面看的类型名（str/boolean/array），
//     style 是名片的 args 段认的写法词（value/boolean/repeat）。两者不是一张表。
//
// 返回：
//   { call,        // 建议的 call 段
//     matched,     // { text, ref_audio, output_path } 扫描认出的参数（null=没认出）
//     argList,     // 当前 group 下全部参数（区 3 渲染用）
//     notes }      // 平台替名片做不了的决定，如实报给用户
//   或 null（没有参数）
export function computeAutoFill (params, currentCall) {
  if (!params || !params.length) return null

  const call = { ...(currentCall || {}) }
  const notes = []

  // kind 是名片自己的权威，这里只在这条路单独成立时才改它。
  //   探测是同时扫两条路、再把结果合并成一张表的：表里混着两种来源，
  //   「有 cli 参数就置 cli」于是对一张混合表恒真，
  //   python 名片被改写成 cli 形态之后，它的参数名不再是带横线的开关，
  //   存下去当场被拒。两种来源都在 ⇒ 保持名片原值并说明情况。
  const hasCli = params.some((p) => p.source === 'cli')
  const hasPy = params.some((p) => p.source === 'python')
  if (hasCli && hasPy) {
    // 返回两种语言而不是一句写死的中文：这两条会显示在界面上，
    //   归一由组件按当前语言取，这个纯函数手上没有翻译表。
    notes.push({
      en: 'Both command line flags and Python signature parameters were found. The manifest kind was left as it is: confirm whether this engine runs through the command line or through the Python class.',
      zh: '同时发现了命令行开关和 Python 函数签名参数。名片里的 kind 保持原样：请确认这台引擎走命令行还是走 Python 类。',
    })
  } else if (hasCli) {
    call.kind = 'cli'
  } else if (hasPy) {
    call.kind = 'python'
  }

  // args 是 cli 形态才有的那一段，python 名片里写它，存的时候直接被拒。
  //   argv 同理（cli 形态的启动命令）。
  if (call.kind === 'cli') {
    // argv 骨架每次从固定前缀重建（不累加旧子命令，否则切子命令会堆
    // infer/synth 多个）。_MODULE_ 待用户补或来自 suggested_call。
    const oldArgv = call.argv || []
    const idxModule = oldArgv.indexOf('_MODULE_')
    const prefix = idxModule >= 0 ? oldArgv.slice(0, idxModule + 1) : oldArgv.slice(0, 3)
    call.argv = (prefix.length ? prefix : ['{engine_python}', '-m', '_MODULE_'])

    // 只收 cli 来源的参数：python 参数名不是开关，写进去就是一条认不出的开关。
    call.args = call.args || {}
    for (const p of params) {
      if (p.source !== 'cli' || call.args[p.name]) continue
      const entry = { flag: p.target }
      // style 用参数自带的那个写法词。统一层的 kind 是类型名
      //   （str / array），不是名片的写法词，写进去这张名片就存不下来。
      if (p.style) entry.style = p.style
      call.args[p.name] = entry
    }
  }

  // 三槽位：候选名对的是 name（不带横线的那个词），
  //  写进 bind 的是 target（cli 路是开关，python 路是参数名）。
  // 索引必须建在 name 上：建在 target 上时，cli 路的 target 是带横线的
  //   开关，而候选名不带横线，两边永远对不上，三槽位恒空。
  const byName = {}
  const ambiguous = []
  for (const p of params) {
    if (byName[p.name] === undefined) { byName[p.name] = p; continue }
    if (byName[p.name].target !== p.target) ambiguous.push(p.name)
  }
  const findSlot = (...names) => {
    for (const n of names) if (byName[n]) return byName[n].target
    return null
  }

  const matched = {
    text: findSlot('text', 'tts_text', 'prompt_text', 'gen_text'),
    ref_audio: findSlot('voice', 'ref_audio', 'prompt_wav', 'ref_wav', 'spk', 'speaker', 'reference_audio'),
    output_path: findSlot('output', 'output_path', 'out', 'save_path'),
  }

  if (ambiguous.length) {
    notes.push({
      en: `The same name appeared in both sources with different values: ${ambiguous.join(', ')}. The first one was used: confirm each slot by hand.`,
      zh: `同名参数在两种来源里指向的值不一样：${ambiguous.join('、')}。已按先出现的那个填，请逐项确认。`,
    })
  }

  // 复制一份再填：浅拷贝出来的 call 里 bind 还是同一个对象，
  //   就地写会把名片原稿也改了（用户取消编辑时撤不回去）。
  call.bind = { ...(call.bind || {}) }
  //  只填空，不覆盖用户已手填的值
  if (!call.bind.text && matched.text) call.bind.text = matched.text
  if (!call.bind.ref_audio && matched.ref_audio) call.bind.ref_audio = matched.ref_audio
  if (!call.bind.output_path && matched.output_path) call.bind.output_path = matched.output_path

  return { call, matched, argList: params, notes }
}

export default function CliGenPanel ({ manifest, onChange, onScanDone, onAutoFilled }) {
  const { t } = useT()
  const { installed, loadOne } = useInstalled()
  const [allDirs, setAllDirs] = React.useState([])   // engines/ 下所有文件夹（含没名片）
  const [mode, setMode] = React.useState(manifest.id ? 'scan' : 'idle')
  const [engineId, setEngineId] = React.useState(manifest.id || '')
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState(null)
  const [scan, setScan] = React.useState(null)
  const [subcmd, setSubcmd] = React.useState('')
  const [readPick, setReadPick] = React.useState('')   // 「读取」入口选中的引擎
  const [newPick, setNewPick] = React.useState('')      // 「新建」入口选中的文件夹
  // 自动填阶段的说明（两种来源混在一起、同名参数指向不同值这类）。
  // 单独一条通道，不并进 scan.notes：那是探测端点的说明，
  //   两者一次扫描同时产生，并进去每切一次分组就会重复追加一遍。
  const [autoNotes, setAutoNotes] = React.useState([])

  // 拉 engines/ 下所有文件夹（含还没名片的）：「新建名片」入口靠它列出
  // 第 1 步克隆来、还没写名片的引擎。与 installed（只有名片的）是两份数据。
  React.useEffect(() => {
    fetch('/wizard/installed?all=1').then((r) => r.json())
      .then((j) => setAllDirs(j.engines || []))
      .catch(() => {})
  }, [])

  React.useEffect(() => { if (!engineId && manifest.id) setEngineId(engineId || manifest.id) }, [manifest.id])

  // 读取：选一台已有名片的引擎 → 先把磁盘名片原文灌进表单，再进编辑态。
  //  绝对不许只进扫描空壳：那样表单里只剩 cli 扫描结果，
  //    原有的 models / runtime / install / call 全被冲掉，点保存就是毁数据。
  // 读取和新建是两条不同的路：读出来的是什么就是什么，不自动清空已有字段。
  const startRead = async (id) => {
    if (!id) return
    setBusy(true); setErr(null); setScan(null); setSubcmd('')
    try {
      const r = await loadOne(id)
      if (!r.ok) { setErr(r.error || t('Failed to read the manifest', '读取名片失败')); return }
      let parsed
      try { parsed = JSON.parse(r.text) } catch (e) {
        setErr(t('The manifest on disk is not valid JSON', '磁盘上的名片不是合法 JSON')); return
      }
      // 灌进表单：以磁盘原文为准（唯一真相），不在这里补默认值、不清字段。
      onChange(parsed)
      setEngineId(id)
      setReadPick(id)
      // 进了编辑态（不是扫描）：用户想再扫可以自己点「扫描参数」。
      setMode('read')
    } finally { setBusy(false) }
  }
  // 新建：选一台 engines/ 下的文件夹（含还没名片的），进扫描
  const startNew = (id) => { if (!id) return; setEngineId(id); setMode('scan'); setScan(null); setErr(null); setSubcmd('') }

  // 应用一次自动填结果：写回名片 + 上报匹配记录（区 1 渲染用）
  const applyAutoFill = (params) => {
    const result = computeAutoFill(params, manifest.call)
    if (!result) { if (onAutoFilled) onAutoFilled({ matched: null, argList: [], notes: [] }); return }
    const next = { ...manifest, call: result.call }
    if (!next.id && engineId) next.id = engineId
    if (!next.label && (next.id || engineId)) next.label = next.id || engineId
    if (next.contract_version === undefined) next.contract_version = 2
    onChange(next)
    // 自动填过程中的说明走独立的一条通道：并进 scan.notes 的话，
    // 每切一次分组就会把同一句话再并一遍。
    setAutoNotes(result.notes || [])
    if (onAutoFilled) onAutoFilled({ matched: result.matched, argList: result.argList, notes: result.notes })
  }

  // 扫描 + 自动填：一步到位：调 /wizard/discover 自动探测形态，扫出参数表，
  //  同时把能对应的填进名片 call 段
  const doScan = async () => {
    if (!engineId) return
    setBusy(true); setErr(null); setScan(null); setAutoNotes([])
    try {
      const r = await fetch('/wizard/discover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: engineId }),
      })
      const j = await r.json()
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return }
      setScan(j)
      const inferGroups = (j.groups || []).filter(s => /synth|infer|tts|generate|call/i.test(s))
      const pickedGroup = subcmd || inferGroups[0] || (j.groups || [])[0] || ''
      setSubcmd(pickedGroup)
      const params = (j.params || []).filter(p => !pickedGroup || p.group === pickedGroup)
      applyAutoFill(params)
      // 扫描成功 → 回调主组件：展开核心绑定区 + 滚动定位（RFC 第 2 章）。
      // 回调放在自动填之后，让名片先填上再展开，绑定区一进来就有值。
      if (onScanDone) onScanDone()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  // 切分组：用当前 scan 结果重算（ 不是闭包旧值）
  const changeSub = (sub) => {
    setSubcmd(sub)
    if (scan) {
      const params = (scan.params || []).filter(p => !sub || p.group === sub)
      applyAutoFill(params)
    }
  }

  const args = (scan && scan.params || []).filter(p => !subcmd || p.group === subcmd)

  return (
    <div className="section">
      <div className="section-hdr"><h2>{t('Generate manifest from CLI', '从命令行生成名片')}</h2></div>
      <div className="section-body">
        <p className="field-hint" style={{ marginTop: 0 }}>
          {t('Scan the engine to discover its parameters. CLI flags or Python signature parameters are listed with their official descriptions, and recognized ones are filled into the manifest automatically.',
            '扫描引擎发现参数。列出 CLI flag 或 Python 函数签名参数及官方说明，能认出来的自动填进名片。')}
        </p>

        {/* ① 两个入口：读取（改已有）/ 新建（接新引擎）：各自选自己的引擎，不共用下拉 */}
        {mode === 'idle' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* 读取名片：改一台已有名片的引擎 */}
            <div className="field">
              <label className="field-label">{t('Read manifest (edit an engine that already has one)', '读取名片（改一台已经有名片的引擎）')}</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select className="control" value={readPick}
                  onChange={(e) => setReadPick(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
                  <option value="">{t('— pick an engine —', '— 选一台引擎 —')}</option>
                  {(installed || []).map(e => <option key={e.id} value={e.id}>{e.id}</option>)}
                </select>
                <button className="btn btn-sm" type="button" disabled={!readPick}
                  style={{ flexShrink: 0 }}
                  onClick={() => startRead(readPick)}>{t('Read', '读取')}</button>
              </div>
            </div>
            {/* 新建名片：接一台新引擎（engines/ 下还没名片的文件夹）*/}
            <div className="field">
              <label className="field-label">{t('New manifest (build one for an engine cloned in step 1)', '新建名片（给第 1 步克隆来的引擎建一张名片）')}</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select className="control" value={newPick}
                  onChange={(e) => setNewPick(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
                  <option value="">{t('— pick a folder under engines/ —', '— 选 engines/ 下的一个文件夹 —')}</option>
                  {allDirs.map(e => <option key={e.id} value={e.id}>
                    {e.id}{e.manifestPresent ? '' : `（${t('no manifest yet', '还没名片')}）`}
                  </option>)}
                </select>
                <button className="btn btn-sm btn-primary" type="button" disabled={!newPick}
                  style={{ flexShrink: 0 }}
                  onClick={() => startNew(newPick)}>{t('New', '新建')}</button>
              </div>
            </div>
          </div>
        )}

        {/* ② 扫描参数（自动填）：只走「新建」这条路。
            定高纪律：这一行固定 minHeight（一次布局），子命令 select
            扫描前是占位、扫描后填值，只换内容不换高度，禁止布局跳变。 */}
        {mode === 'scan' && (
          <>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', minHeight: 76 }}>
              <div className="field" style={{ flex: 1, minWidth: 0 }}>
                <label className="field-label">{t('Engine id', '引擎 id')}</label>
                <select className="control" value={engineId} onChange={(e) => setEngineId(e.target.value)}>
                  <option value="">{t('— pick an engine —', '— 选一台引擎 —')}</option>
                  {(allDirs || []).map(e => <option key={e.id} value={e.id}>{e.id}{e.manifestPresent ? '' : `（${t('no manifest yet', '还没名片')}）`}</option>)}
                </select>
              </div>
              <div className="field" style={{ flex: 1, minWidth: 0 }}>
                <label className="field-label">{t('Group', '分组')}</label>
                <select className="control" value={subcmd} disabled={!scan}
                  onChange={(e) => changeSub(e.target.value)}>
                  <option value="">
                    {scan
                      ? t('— pick a group —', '— 选一个分组 —')
                      : t('(appears after scanning)', '（扫描后出现）')}
                  </option>
                  {(scan && scan.groups || []).map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div style={{ flexShrink: 0, paddingBottom: 2 }}>
                <button className="btn btn-sm btn-primary" type="button" disabled={busy || !engineId} onClick={doScan}>
                  {busy ? t('Scanning…', '扫描中…') : (scan ? t('Rescan', '重新扫描') : t('Scan parameters', '扫描参数'))}
                </button>
              </div>
            </div>
            {err && <div className="msg msg-danger">{err}</div>}
          </>
        )}

        {/* ②′ 读取名片后：确认表单里是磁盘原文，需要的话也可以再扫一次。
            定高纪律：与 scan 行同高（一次布局），返回/扫描按钮位置不变。 */}
        {mode === 'read' && (
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button className="btn btn-sm" type="button" onClick={() => setMode('idle')}>
              {t('Back', '返回')}
            </button>
            <button className="btn btn-sm btn-primary" type="button" disabled={busy || !engineId} onClick={doScan}>
              {busy ? t('Scanning…', '扫描中…') : t('Scan parameters', '扫描参数')}
            </button>
          </div>
        )}

        {/* ③ 参数表（扫出来给用户看，已自动填的标出来）
            用项目的 .table（width/border-collapse/font-size/th/td 都齐），
            不用 className="control"（那是输入框类，不是表格类）。
            适配两种 source：cli 显示 flag，python 显示参数名。 */}
        {scan && scan.ok && args.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <strong className="field-label">{t(`Parameters (${args.length})`, `参数（${args.length} 个）`)}</strong>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('Parameter', '参数')}</th>
                  <th>{t('Type', '类型')}</th>
                  <th>{t('Req', '必填')}</th>
                  <th>{t('Official description', '官方说明')}</th>
                </tr>
              </thead>
              <tbody>
                {args.map(a => (
                  <tr key={a.name}>
                    <td><code>{a.target}</code>{a.is_tool && <span className="badge badge-neutral" style={{ marginLeft: 6 }}>{t('tool', '工具')}</span>}</td>
                    <td>{a.kind}</td>
                    <td>{a.required ? t('Required', '必填') : ''}</td>
                    <td>{a.help || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="field-hint" style={{ marginTop: 6 }}>
              {t('Recognized parameters are already filled into the call section below. Edit anything the scan missed, then Save.',
                '能认出来的参数已自动填进下面的 call 段。扫描没覆盖的手动补，然后保存。')}
            </p>
          </div>
        )}

        {/* ③′ notes：探测说明如实显示（如"引擎环境未就绪"），不假装 */}
        {scan && scan.notes && scan.notes.length > 0 && (
          <div className="msg msg-info" style={{ marginTop: 10 }}>
            {scan.notes.map((n, i) => <div key={i}>{n}</div>)}
          </div>
        )}

        {/* ③″ 自动填阶段的说明：平台替名片做不了决定的地方，如实告诉用户 */}
        {autoNotes.length > 0 && (
          <div className="msg msg-warn" style={{ marginTop: 10 }}>
            {autoNotes.map((n, i) => <div key={i}>{t(n.en, n.zh)}</div>)}
          </div>
        )}
      </div>
    </div>
  )
}
