import React from 'react'
import { useT } from '../../../web/src/lib/i18n'

// ============================================================================
//  STEP WEIGHTS + STEP VERIFY + STEP READY —— 第 3 / 5 / 6 步
//
//  ⭐ 排版照抄项目的：命令用 .rc-cmd + .rc-cmd-body（等宽可换行），
//    列表用 .table，提示用 .msg-*，小标题用 .layer-label。
//    ⛔ 不再自造 .step-block / .ed-bar / .plan-cmd（那三个全项目没定义）。
//
//  ⭐ Weights 这一步⛔ 一个字节都不下载：
//    「平台不替你下载，但会把你名片里写的那条命令填好占位符直接打印给你」
//
//  ⭐ ready 是**三态**：true=齐了 · false=缺了 · null=**说不出来**
//    ⇒ null 既不是齐也不是缺，糊成任何一个都是撒谎。
//
//  ⛔⛔ 纪律：不许出现任何具体引擎名。
// ============================================================================

// ---------------------------------------------------------------------------
// probe 是第 1 步探测的原始结果 —— 上游自己的下载入口就在那里面。
//   ⇒ 这一步优先展示**上游自己给的**方式，⛔ 平台不另造一套。
//   判据：界面上出现的下载命令必须能在 probe.downloader / downloader_cmds 里找到出处。
export function StepModels ({ state, onChange, probe }) {
  const { t } = useT()
  const [r, setR] = React.useState(null)
  const [err, setErr] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const id = state.id

  // ⭐ 下载清单来自 probe（第 1 步），不依赖 manifest
  //   Owner 2026-10-06：「下载模型就是下载模型，和名片没有任何关系」
  //   ⛔ 原来调 /wizard/models 是错的 —— 那个端点内部调 describeModels →
  //     resolveEngineProfile → 需要 manifest，而 manifest 第 4 步才写。
  //   ✅ 现在直接用 probe.downloader_cmds（第 1 步从 README 提取的下载命令）
  const load = async () => {
    if (!id) return
    setBusy(true); setErr(null)
    try {
      if (!probe) { setErr('No probe data. Complete step 1 first.'); return }
      const cmds = probe.downloader_cmds || []
      const scripts = probe.downloader || []
      setR({ ok: true, manifest: null, status: null, commands: [], downloader_cmds: cmds, downloader: scripts })
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  React.useEffect(() => { if (id && !r && !busy) load() /* eslint-disable-line */ }, [id])

  // ⭐ 下载状态（SSE 流式，照 StepDeps 模式）
  // ⚠️ 声明必须在使用之前 —— 第 68 行的 useEffect 引用了 dlLive，
  //    ⛔ 声明在后面会触发 TDZ（Cannot access 'dlLive' before initialization）
  const [dlLive, setDlLive] = React.useState(null)
  const [dlTail, setDlTail] = React.useState([])
  const [dlBusy, setDlBusy] = React.useState(false)

  // ⭐ 断点续传：页面加载时读进度文件，恢复「已下载」状态
  //   ⛔ 不依赖 manifest —— 下载就是下载，和名片没有任何关系
  React.useEffect(() => {
    if (!id) return
    fetch(`/wizard/download/progress?id=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.ok && Array.isArray(j.done) && j.done.length > 0) {
          // 有已完成的命令 → 标记为「已下载」
          setDlLive({ stage: 'done', ok: true })
        }
      })
      .catch(() => { /* 读不到进度文件 ⇒ 没有已下载的 */ })
  }, [id])

  // ⭐ 逐文件校验：下载完成后自动调 /wizard/download/files 读文件列表
  //   ⛔ 不依赖 manifest —— 直接列 engines/<id>/checkpoints/ 下的文件
  //   ⭐ 三态：已下载（文件存在且大小>0）/ 未下载（文件不存在）/ 半截（大小为0）
  const [fileList, setFileList] = React.useState(null)
  React.useEffect(() => {
    if (!id || !dlLive || dlLive.stage !== 'done') return
    fetch(`/wizard/download/files?id=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((j) => { if (j.ok) setFileList(j.files) })
      .catch(() => { /* 读不到 ⇒ 空列表 */ })
  }, [id, dlLive])

  const M = (r && r.manifest) || null
  const upstreamScripts = (probe && probe.downloader) || []
  const upstreamCmds = (probe && probe.downloader_cmds) || []

  // ⭐ 去重：默认按 repo 去重（同一个仓库只显示一次），勾选后显示全部
  const [dedup, setDedup] = React.useState(true)
  const seenRepos = new Set()
  const visibleCmds = upstreamCmds.filter((c) => {
    if (!dedup) return true
    if (seenRepos.has(c.repo)) return false
    seenRepos.add(c.repo)
    return true
  })

  // ⭐ 下载是「发射后不管」的后台任务 —— 点击后启动下载，不阻塞 UI，
  //   用户可以随时进入第 4 步写 manifest（此时下载还在后台跑）。
  //   ⛔ 不用 await —— await 会阻塞 UI，用户要等下载完成才能做其他事。
  const runDownload = (c) => {
    setDlBusy(true); setDlTail([]); setDlLive({ stage: 'start' })
    const dest = `engines/${id}/checkpoints`
    let argv
    if (c.tool === 'snapshot') {
      argv = ['python', '-c',
        `from modelscope import snapshot_download; snapshot_download('${c.repo}', local_dir='${dest}')`]
    } else if (c.tool === 'modelscope') {
      argv = ['modelscope', 'download', '--model', c.repo, '--local_dir', dest]
    } else {
      argv = ['hf', 'download', c.repo, `--local-dir=${dest}`]
    }
    // ⛔ 不 await —— 下载在后台跑，用户可以随时进入第 4 步
    fetch('/wizard/download', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, root: window.__PROJECT_ROOT__ || '', argv }),
    }).then((resp) => {
      if (!resp.ok) { setDlLive({ stage: 'error', error: 'HTTP ' + resp.status }); setDlBusy(false); return }
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      const pump = () => reader.read().then(({ done, value }) => {
        if (done) { setDlBusy(false); return }
        buf += decoder.decode(value, { stream: true })
        let sep
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, sep); buf = buf.slice(sep + 2)
          const dl = raw.split('\n').find((l) => l.startsWith('data: '))
          if (!dl) continue
          let ev
          try { ev = JSON.parse(dl.slice(6)) } catch (e) { continue }
          if ('text' in ev) {
            setDlLive((s) => ({ ...(s || {}), stage: 'line', err: ev.err }))
            setDlTail((t) => [...t.slice(-39), ev.text])
          } else if ('ok' in ev || 'error' in ev) {
            setDlLive({ stage: 'done', ok: ev.ok, error: ev.error })
            setDlBusy(false)
          }
        }
        pump()
      }).catch((e) => {
        setDlLive({ stage: 'error', error: e.message })
        setDlBusy(false)
      })
      pump()
    }).catch((e) => {
      setDlLive({ stage: 'error', error: e.message })
      setDlBusy(false)
    })
  }

  // ⭐ 统一落盘：所有下载命令的 local_dir 都替换成 engines/<id>/checkpoints/
  //   ⛔ 不删原目录 —— hf/modelscope 的缓存在那里，删了要重下。
  //   ⛔ 不替用户决定路径 —— 这是平台统一落盘策略，不是用户可选的。


  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {err && <div className="msg msg-danger">{err}</div>}
      {!id && (
        <div className="msg msg-info">
          {t('Fill in the link first — the model list comes from the upstream README.',
            '请先填写链接，需要下载的模型从上游 README 中提取。')}
        </div>
      )}

      {/* ---- 一张表：模型名 / 存到哪 / 有没有
          ⛔ 不给几行散着的命令：下哪个、下到哪、缺哪个都要从命令里读出来，
             而使用者要的是那张表。*/}
      {M && (
        <>
          <div className="plan-kv">
            <span className="pk">{t('Stored at', '存放位置')}</span>
            <span className="pv">
              <code>{M.where || t('(the manifest does not say)',
                '（名片未指定）')}</code>
            </span>
            {M.from && (
              <>
                <span className="pk">{t('Download from', '下载来源')}</span>
                <span className="pv"><code>{M.from}</code></span>
              </>
            )}
          </div>

          {/* ⭐ 下载清单表格：模型名 / 仓库链接 / 大小 / SHA-256 / 状态 */}
          {visibleCmds.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('Model', '模型')}</th>
                  <th>{t('Repo', '仓库')}</th>
                  <th>{t('Size', '大小')}</th>
                  <th>{t('SHA-256', 'SHA-256')}</th>
                  <th>{t('Status', '状态')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visibleCmds.map((c, i) => {
                  const item = M.items.find((it) => it.name === c.repo)
                  const have = item ? item.have : null
                  return (
                    <tr key={i}>
                      <td><code>{c.repo}</code></td>
                      <td>
                        <a href={`https://huggingface.co/${c.repo}`} target="_blank" rel="noreferrer">
                          {t('HF', 'HF')}
                        </a>
                        {' / '}
                        <a href={`https://modelscope.cn/models/${c.repo}`} target="_blank" rel="noreferrer">
                          {t('MS', 'MS')}
                        </a>
                      </td>
                      <td>{t('(unknown)', '（未知）')}</td>
                      <td>{t('(unknown)', '（未知）')}</td>
                      <td>
                        {have === true
                          ? <span className="badge badge-ok">{t('Present', '已就位')}</span>
                          : have === false
                            ? <span className="badge badge-warn">{t('Missing', '缺')}</span>
                            : <span className="muted">{t('(unknown)', '（未知）')}</span>}
                      </td>
                      <td>
                        <button className="btn btn-sm" type="button"
                          onClick={() => runDownload(c)}>
                          {t('Download', '下载')}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          {/* 去重复选框 */}
          {upstreamCmds.length > 1 && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
              <input type="checkbox" checked={dedup}
                onChange={(e) => setDedup(e.target.checked)} />
              <span>{t('Deduplicate by repo', '按仓库去重')}</span>
            </label>
          )}

          {/* 进度条 */}
          {dlBusy && (
            <div className="preflight" style={{ marginTop: 8 }}>
              <div className="layer-label">
                {dlLive && dlLive.stage === 'line'
                  ? t('Downloading…', '下载中…')
                  : t('Starting…', '启动中…')}
              </div>
              <div className="wz-progress wz-progress-indeterminate">
                <div className="wz-progress-bar" />
              </div>
              {dlTail.length > 0 && (
                <div className="rc-cmd-body" style={{ marginTop: 4, maxHeight: 120, overflowY: 'auto' }}>
                  <pre style={{ margin: 0, fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                    {dlTail.join('\n')}
                  </pre>
                </div>
              )}
            </div>
          )}
          {dlLive && dlLive.stage === 'done' && (
            <div className={`msg ${dlLive.ok ? 'msg-info' : 'msg-danger'}`}>
              {dlLive.ok
                ? t('Download finished. Re-check to verify.', '下载完成，请重新检查确认。')
                : t('Download failed:', '下载失败：') + ' ' + (dlLive.error || '')}
            </div>
          )}

          {/* ⭐ 逐文件校验结果：三态显示 */}
          {fileList && fileList.length > 0 && (
            <div className="preflight" style={{ marginTop: 8 }}>
              <div className="layer-label">{t('Files on disk', '磁盘上的文件')}</div>
              {fileList.map((f, i) => {
                const state = f.size > 0 ? 'ok' : 'partial'
                return (
                  <div key={i} className="pf-row">
                    <span className={`badge badge-${state}`}>
                      {state === 'ok' ? '✓' : '◐'}
                    </span>
                    <span className="pf-val"><code>{f.name}</code></span>
                    <span className="field-hint" style={{ marginTop: 0 }}>
                      {f.size > 0
                        ? `${(f.size / 1024 / 1024).toFixed(1)} MB`
                        : t('(empty / partial)', '（空 / 半截）')}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          {/* ── 上游附带的下载脚本（如果有）──
              ⛔ 平台不执行它们 —— 只是告诉用户「上游自己给了这个脚本」。
              执行是用户自己的事，平台只负责把命令摆出来。*/}
          {upstreamScripts.length > 0 && (
            <div className="section" style={{ marginTop: 4 }}>
              <div className="section-hdr">
                <h2 style={{ fontSize: 13 }}>
                  {t('Scripts the project ships', '上游附带脚本')}
                </h2>
              </div>
              <div className="section-body">
                <div className="field-hint" style={{ marginTop: 0 }}>
                  {t('Run it in the engine folder:', '在引擎目录内执行：')}
                </div>
                {upstreamScripts.map((d) => (
                  <div key={d.file} className="rc-cmd" style={{ marginTop: 4 }}>
                    <pre className="rc-cmd-body">{`python ${d.file}`}</pre>
                  </div>
                ))}
              </div>
            </div>
          )}

          {M.state === null && (
            <div className="msg msg-danger">
              {t('Cannot tell — the manifest does not say which files are required.',
            '无法判断，Manifest 未指定必需文件。')}
            </div>
          )}
        </>
      )}

      {/* ---- 命令：平台只填好占位符打印出来，⛔ 不代下载 ---- */}
      {M && M.commands && M.commands.length > 0 && (
        <>
          <p className="field-hint" style={{ marginTop: 0 }}>
            {t('Run this yourself:', '请自行执行：')}
          </p>
          <div className="rc-cmd">
            <pre className="rc-cmd-body">{M.commands.join('\n')}</pre>
          </div>
        </>
      )}
      {M && (!M.commands || M.commands.length === 0) && (
        <div className="msg msg-danger">
          {t('No download command. Follow the project README.',
            '没有下载命令。请参照项目 README。')}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-sm" type="button" onClick={load} disabled={busy || !id}>
          {busy ? t('Checking…', '正在查…') : t('Check again', '再查一次')}
        </button>
      </div>
    </div>
  )
}


// ⛔ StepVerify 已移出本文件：原实现（自动跑前三道 + 无条件上报 verified）
//   会让第 5 步一进入就变成对勾，且形状与裁决的三块独立结果不符。
//   实现与理由见 ./StepVerify.jsx 头部。
export { StepVerify } from './StepVerify'

// ---------------------------------------------------------------------------
//  ⛔ 流程条只有五步，⛔ 不设「装完了怎么用」那一步。
//     它属于文档，不占一个流程步骤 —— 一个只放说明、不执行任何动作的格子
//     是流程条上的一格空话，且它往往要把内部术语（engines/、Manifest、
//     weights[]）摆到界面上。
//     判据：新增步骤前先问它有没有执行任何动作；没有 ⇒ 那是文档。
