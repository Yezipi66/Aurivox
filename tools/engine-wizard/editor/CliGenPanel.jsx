import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { useInstalled } from './useInstalled'

// ============================================================================
//  CLI GEN PANEL —— 走命令行（cli 形态）的「扫描 → 自动填 → 手编」
//
// 操作流（Owner 2026-10-10 定）：
//   进来 → [读取名片]（改已有引擎）或 [新建名片]（默认新建）
//   新建后 → [扫描参数] → 列出上游命令行的 flag 表（官方说明 / 必填选填 / 类型）
//   → 平台**自动填**一批进名片（bind 三槽位 + args，不要求用户逐个勾）
//   → 用户手动编辑补改 → 最下面 [保存]
//
// 渐进披露（RFC 第 2 章）：mode 流转 idle → scan → read
//   · idle：两个入口（读取 / 新建）各自清晰
//   · scan：选引擎 → 扫描；扫描控件行定高（子命令 select 扫描前占位、
//     扫描后填值，只换内容不换高度，禁止布局跳变）
//   · read：读取磁盘原文后进编辑态（P0 成果，不许改回空壳）
//   · 扫描成功 → 回调 onScanDone() 主组件展开核心绑定区并滚动定位
//
// 这条路扫上游命令行 --flag，flag 即参数，官方 help 直接挂它上面
//   不用读函数签名、不用猜 flag↔参数对应。
//
// 纪律：只填表单不落盘（落盘是 SaveBar 的事）；help 原样递出不改写。
// ============================================================================

// ---------------------------------------------------------------------------
// computeAutoFill —— 纯函数：把扫描到的参数转成 call 段建议值
//
// 为什么纯函数（外援点名「autoFill 闭包陷阱」）：
//   旧实现 autoFill 读闭包里的 manifest.call，而 doScan 里 setScan(j) 是
//   异步的。用户快速切子命令时 scan 还是上一次的旧值，用旧 args 填新子命令。
//   现在：入参全部显式（allArgs / sub / currentCall），返回建议值 + 匹配记录，
//    不读任何组件 state，不直接 onChange。
//
// 返回：
//   { call,        // 建议的 call 段（kind=cli + argv + bind + args）
//     matched,     // { text, ref_audio, output_path } 扫描认出的 flag（null=没认出）
//     argList }    // 该子命令下全部参数（区 3 渲染用）
//   或 null（该子命令没有参数）
// ---------------------------------------------------------------------------
export function computeAutoFill (allArgs, sub, currentCall) {
  const args = (allArgs || []).filter((a) => (sub === '(root)' ? !a.subcommand : a.subcommand === sub))
  if (!args.length) return null

  const call = { ...(currentCall || {}), kind: 'cli' }
  // argv 骨架每次从固定前缀重建（不累加旧子命令，否则切子命令会堆
  // infer/synth 多个）。_MODULE_ 待用户补或来自 suggested_call。
  const oldArgv = call.argv || []
  const idxModule = oldArgv.indexOf('_MODULE_')
  const prefix = idxModule >= 0 ? oldArgv.slice(0, idxModule + 1) : oldArgv.slice(0, 3)
  call.argv = (prefix.length ? prefix : ['{engine_python}', '-m', '_MODULE_'])
    .concat(sub && sub !== '(root)' ? [sub] : [])

  // 三槽位：按官方 flag 名认（text→--text/--prompt-text，ref→--voice/--ref-audio…）
  const byName = Object.fromEntries(args.map((a) => [a.name, a]))
  const findFlag = (...names) => {
    for (const n of names) if (byName[n]) return byName[n].flag
    return null
  }

  const matched = {
    text: findFlag('text', 'tts_text', 'prompt_text', 'gen_text'),
    ref_audio: findFlag('voice', 'ref_audio', 'prompt_wav', 'ref_wav', 'spk', 'speaker', 'reference_audio'),
    output_path: findFlag('output', 'output_path', 'out', 'save_path'),
  }

  call.bind = call.bind || {}
  //  只填空，不覆盖用户已手填的值
  if (!call.bind.text && matched.text) call.bind.text = matched.text
  if (!call.bind.ref_audio && matched.ref_audio) call.bind.ref_audio = matched.ref_audio
  if (!call.bind.output_path && matched.output_path) call.bind.output_path = matched.output_path

  // 其余 flag 全进 args
  call.args = call.args || {}
  const argList = []
  for (const a of args) {
    if (!call.args[a.name]) call.args[a.name] = { flag: a.flag, style: a.style }
    argList.push({ name: a.name, flag: a.flag, style: a.style, required: a.required, help: a.help, is_tool: a.is_tool })
  }
  return { call, matched, argList }
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

  // 拉 engines/ 下所有文件夹（含还没名片的）——「新建名片」入口靠它列出
  // 第 1 步克隆来、还没写名片的引擎。与 installed（只有名片的）是两份数据。
  React.useEffect(() => {
    fetch('/wizard/installed?all=1').then((r) => r.json())
      .then((j) => setAllDirs(j.engines || []))
      .catch(() => {})
  }, [])

  React.useEffect(() => { if (!engineId && manifest.id) setEngineId(engineId || manifest.id) }, [manifest.id])

  // 读取：选一台**已有名片**的引擎 → 先把磁盘名片原文灌进表单，再进编辑态。
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
  const applyAutoFill = (j, sub) => {
    const result = computeAutoFill(j.args, sub, manifest.call)
    if (!result) { if (onAutoFilled) onAutoFilled({ sub, matched: null, argList: [] }); return }
    const next = { ...manifest, call: result.call }
    if (!next.id && engineId) next.id = engineId
    if (!next.label && (next.id || engineId)) next.label = next.id || engineId
    if (next.contract_version === undefined) next.contract_version = 2
    onChange(next)
    if (onAutoFilled) onAutoFilled({ sub, matched: result.matched, argList: result.argList })
  }

  // 扫描 + 自动填：一步到位 —— 扫出参数表，同时把能对应的填进名片 call 段
  const doScan = async () => {
    if (!engineId) return
    setBusy(true); setErr(null); setScan(null)
    try {
      const r = await fetch('/wizard/cli-args', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: engineId, subcommand: subcmd || undefined }),
      })
      const j = await r.json()
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return }
      setScan(j)
      const inferSubs = (j.subcommands || []).filter(s => /synth|infer|tts|generate/i.test(s))
      const pickedSub = subcmd || inferSubs[0] || (j.subcommands || [])[0] || ''
      setSubcmd(pickedSub)
      applyAutoFill(j, pickedSub)
      // 扫描成功 → 回调主组件：展开核心绑定区 + 滚动定位（RFC 第 2 章）。
      // 回调放在自动填之后，让名片先填上再展开，绑定区一进来就有值。
      if (onScanDone) onScanDone()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  // 切子命令：用**当前 scan 结果**重算（ 不是闭包旧值）
  const changeSub = (sub) => {
    setSubcmd(sub)
    if (scan) applyAutoFill(scan, sub)
  }

  const args = (scan && scan.args || []).filter(a => !subcmd || a.subcommand === subcmd || (subcmd === '(root)' && !a.subcommand))

  return (
    <div className="section">
      <div className="section-hdr"><h2>{t('Generate manifest from CLI', '从命令行生成名片')}</h2></div>
      <div className="section-body">
        <p className="field-hint" style={{ marginTop: 0 }}>
          {t('Scan the engine’s command-line tool. Flags are listed with their official descriptions, and recognized ones are filled into the manifest automatically.',
            '扫描引擎的命令行工具。列出每个参数和官方说明，能认出来的自动填进名片。')}
        </p>

        {/* ① 两个入口：读取（改已有）/ 新建（接新引擎）—— 各自选自己的引擎，不共用下拉 */}
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

        {/* ② 扫描参数（自动填）—— 只走「新建」这条路。
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
                <label className="field-label">{t('Subcommand', '子命令')}</label>
                <select className="control" value={subcmd} disabled={!scan}
                  onChange={(e) => changeSub(e.target.value)}>
                  <option value="">
                    {scan
                      ? t('— pick a subcommand —', '— 选一个子命令 —')
                      : t('(appears after scanning)', '（扫描后出现）')}
                  </option>
                  {(scan && scan.subcommands || []).map(s => <option key={s} value={s}>{s}</option>)}
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
            不用 className="control"（那是输入框类，不是表格类）。 */}
        {scan && scan.ok && args.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <strong className="field-label">{t(`Parameters (${args.length})`, `参数（${args.length} 个）`)}</strong>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('Flag', '参数')}</th>
                  <th>{t('Type', '类型')}</th>
                  <th>{t('Req', '必填')}</th>
                  <th>{t('Official description', '官方说明')}</th>
                </tr>
              </thead>
              <tbody>
                {args.map(a => (
                  <tr key={a.name}>
                    <td><code>{a.flag}</code>{a.is_tool && <span className="badge badge-neutral" style={{ marginLeft: 6 }}>{t('tool', '工具')}</span>}</td>
                    <td>{a.style}</td>
                    <td>{a.required ? t('Required', '必填') : ''}</td>
                    <td>{a.help || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="field-hint" style={{ marginTop: 6 }}>
              {t('Recognized flags are already filled into the call section below. Edit anything the scan missed, then Save.',
                '能认出来的参数已自动填进下面的 call 段。扫描没覆盖的手动补，然后保存。')}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
