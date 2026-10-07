import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { loadDownloadState, saveDownloadState } from './downloadState'

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

// ⭐ 统一命令构建：展示和执行使用同一个函数
//   display: 用户看到的命令字符串
//   argv: 实际执行的命令数组
//   ⚠️ 两者来自同一个函数，确保逻辑一致
const buildCommand = (c) => {
  if (c.tool === 'snapshot') {
    return {
      display: `python -c "from modelscope import snapshot_download; snapshot_download('${c.repo}', local_dir='checkpoints')"`,
      argv: ['python', '-c', `from modelscope import snapshot_download; snapshot_download('${c.repo}', local_dir='checkpoints')`]
    }
  } else if (c.tool === 'modelscope') {
    return {
      display: `modelscope download --model ${c.repo} --local_dir checkpoints`,
      argv: ['modelscope', 'download', '--model', c.repo, '--local_dir', 'checkpoints']
    }
  } else {
    return {
      display: `hf download ${c.repo} --local-dir=checkpoints`,
      argv: ['hf', 'download', c.repo, '--local-dir=checkpoints']
    }
  }
}

export function StepModels ({ state, onChange, probe }) {
  const { t, lang } = useT()
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

  // ⭐ 下载状态（SSE 流式，照 StepDeps 模式）
  // ⚠️ 声明必须在使用之前 —— 下面的 useEffect 引用了 dlLive，
  //    ⛔ 声明在后面会触发 TDZ（Cannot access 'dlLive' before initialization）
  const [dlLive, setDlLive] = React.useState(null)
  const [dlTail, setDlTail] = React.useState([])
  const [dlBusy, setDlBusy] = React.useState(false)
  const [dlProgress, setDlProgress] = React.useState(null)

  // ⭐ 远端文件列表（来自 /wizard/download/manifest）
  const [manifest, setManifest] = React.useState(null)
  const [probeLoading, setProbeLoading] = React.useState(false)
  const [probeError, setProbeError] = React.useState(null)

  // ⭐ 去重：默认按 repo 去重（同一个仓库只显示一次），勾选后显示全部
  const [dedup, setDedup] = React.useState(true)

  // ⭐ 持久化：从 localStorage 恢复状态
  React.useEffect(() => {
    if (!id) return
    const saved = loadDownloadState(id)
    if (saved) {
      if (saved.manifest) setManifest(saved.manifest)
      if (saved.probeError) setProbeError(saved.probeError)
      if (typeof saved.dedup === 'boolean') setDedup(saved.dedup)
    }
  }, [id])

  // ⭐ 持久化：保存状态到 localStorage
  React.useEffect(() => {
    if (!id) return
    saveDownloadState(id, { manifest, probeError, dedup })
  }, [id, manifest, probeError, dedup])

  React.useEffect(() => { if (id && !r && !busy) load() /* eslint-disable-line */ }, [id])

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

  // ⭐ 远端文件列表：用户点击「嗅探仓库」按钮后加载
  //   ⛔ 不自动加载 —— 用户主动触发，避免不必要的网络请求

  const M = (r && r.manifest) || null
  const upstreamScripts = (probe && probe.downloader) || []
  const upstreamCmds = (probe && probe.downloader_cmds) || []

  const seenRepos = new Set()
  const visibleCmds = upstreamCmds.filter((c) => {
    if (!dedup) return true
    if (seenRepos.has(c.repo)) return false
    seenRepos.add(c.repo)
    return true
  })

  // ⭐ 嗅探仓库：调 /wizard/download/manifest 获取文件列表
  //   ⭐ 追加不覆盖：点击某个仓库的按钮，显示该仓库的文件；
  //     再点击另一个仓库的按钮，追加其文件到列表后面
  //   ⭐ 同仓库去重：同一个仓库重复点击按钮，忽略
  const loadManifest = async (c) => {
    if (!id || !c || !c.repo) {
      setProbeError(t('Repository information is missing. Please check the upstream README.',
        '仓库信息缺失，请检查上游 README。'))
      return
    }
    setProbeLoading(true)
    setProbeError(null)
    try {
      const tool = c.tool === 'modelscope' ? 'modelscope' : 'hf'
      const resp = await fetch(`/wizard/download/manifest?id=${encodeURIComponent(id)}&repo=${encodeURIComponent(c.repo)}&tool=${tool}&root=${encodeURIComponent(window.__PROJECT_ROOT__ || '')}`)
      // ⭐ 守卫：检查响应是否是有效的 JSON（防止 HTML 错误页面导致 JSON 解析失败）
      if (!resp.ok) {
        setProbeError(t('Probe failed: HTTP ${resp.status}', '嗅探失败：HTTP ${resp.status}'))
        return
      }
      const contentType = resp.headers.get('content-type') || ''
      if (!contentType.includes('application/json')) {
        setProbeError(t('Probe failed: invalid response', '嗅探失败：响应格式错误'))
        return
      }
      const j = await resp.json()
      if (j.ok) {
        setManifest((prev) => {
          // 同仓库去重：如果已经嗅探过这个仓库，忽略
          if (prev && prev.some((f) => f.repo === c.repo)) return prev
          // 追加：把新文件加到列表后面，带上 repo 字段
          const newFiles = j.files.map((f) => ({ ...f, repo: c.repo, tool: c.tool }))
          return [...(prev || []), ...newFiles]
        })
      } else {
        // ⭐ 显示错误信息，让用户知道嗅探失败
        setProbeError(j.error || t('Probe failed', '嗅探失败'))
      }
    } catch (e) {
      setProbeError(e.message || t('Probe failed', '嗅探失败'))
    } finally { setProbeLoading(false) }
  }

  // ⭐ manifest 刷新：把新状态合并回旧表，⛔ 不整表覆盖
  //   ⚠️ 刷新响应可能缺 repo/tool（旧后端），而旧表里每一项都带着来源 ——
  //     整表覆盖会把「这个文件属于哪个仓库」抹掉，重下/续传按钮随之失效。
  //   ⭐ 以「仓库 + 文件名」为键：命中就更新状态，⛔ 不动其他仓库的行。
  const mergeManifest = (prev, fresh, repo, tool) => {
    const freshList = (fresh || []).map((f) => ({
      ...f,
      repo: f.repo || repo,
      tool: f.tool || tool,
    }))
    if (!Array.isArray(prev) || prev.length === 0) return freshList
    // ⭐ 用传入的 repo 作为 fallback，确保 prev 里的文件也有 repo
    const key = (f) => `${f.repo || repo}|${f.name}`
    const byKey = new Map(freshList.map((f) => [key(f), f]))
    const merged = prev.map((f) => byKey.get(key(f)) || {
      ...f,
      repo: f.repo || repo,
      tool: f.tool || tool,
    })
    const seen = new Set(prev.map(key))
    for (const f of freshList) if (!seen.has(key(f))) merged.push(f)
    return merged
  }

  // ⭐ 下载全部：遍历所有 missing/partial 文件，逐个下载
  //   ⭐ 用 ref 追踪下载状态，避免闭包读到旧的 state 值
  const dlBusyRef = React.useRef(false)
  const downloadAll = () => {
    if (!manifest || manifest.length === 0) return
    const filesToDownload = manifest.filter((f) => f.status === 'missing' || f.status === 'partial')
    if (filesToDownload.length === 0) return
    dlBusyRef.current = true
    setDlBusyBoth(true); setDlTail([]); setDlLive({ stage: 'start' })
    let idx = 0
    const downloadNext = () => {
      if (idx >= filesToDownload.length) {
        dlBusyRef.current = false
        setDlLive({ stage: 'done', ok: true })
        setDlBusyBoth(false)
        return
      }
      const f = filesToDownload[idx]
      const cmd = { repo: f.repo || '', tool: f.tool || 'hf' }
      idx++
      runDownload(cmd, f)
      // 等待当前文件下载完成后再下载下一个
      const checkDone = setInterval(() => {
        if (!dlBusyRef.current) {
          clearInterval(checkDone)
          downloadNext()
        }
      }, 500)
    }
    downloadNext()
  }

  // ⭐ 下载是「发射后不管」的后台任务 —— 点击后启动下载，不阻塞 UI，
  //   用户可以随时进入第 4 步写 manifest（此时下载还在后台跑）。
  //   ⛔ 不用 await —— await 会阻塞 UI，用户要等下载完成才能做其他事。
  const setDlBusyBoth = (v) => { dlBusyRef.current = v; setDlBusy(v) }
  const runDownload = (c, file) => {
    setDlBusyBoth(true); setDlTail([]); setDlLive({ stage: 'start' })
    // ⭐ 如果有文件信息，使用文件级下载端点（支持断点续传）
    if (file && file.name) {
      fetch('/wizard/download/file', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id,
          root: window.__PROJECT_ROOT__ || '',
          repo: c.repo,
          file: { name: file.name, size: file.size, sha256: file.sha256 },
        }),
      }).then((resp) => {
        if (!resp.ok) { setDlLive({ stage: 'error', error: 'HTTP ' + resp.status }); setDlBusyBoth(false); return }
        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        const pump = () => reader.read().then(({ done, value }) => {
          if (done) { setDlBusyBoth(false); return }
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
            } else if ('percent' in ev) {
              setDlProgress({ file: ev.file || '', percent: ev.percent || 0, downloaded: ev.downloaded || '', total: ev.total || '' })
            } else if ('ok' in ev || 'error' in ev) {
              setDlLive({ stage: 'done', ok: ev.ok, error: ev.error, errorZh: ev.errorZh })
              setDlBusyBoth(false)
              setDlProgress(null)
              // ⭐ 下载完成后自动刷新 manifest（合并刷新，⛔ 不整表覆盖）
              if (ev.ok && id) {
                const refreshTool = c.tool === 'modelscope' ? 'modelscope' : 'hf'
                fetch(`/wizard/download/manifest?id=${encodeURIComponent(id)}&repo=${encodeURIComponent(c.repo)}&tool=${refreshTool}&root=${encodeURIComponent(window.__PROJECT_ROOT__ || '')}`)
                  .then((r) => r.json())
                  .then((j) => { if (j.ok) setManifest((prev) => mergeManifest(prev, j.files, c.repo, refreshTool)) })
                  .catch(() => { /* 读不到 ⇒ 保留旧表 */ })
              }
            }
          }
          pump()
        }).catch((e) => {
          setDlLive({ stage: 'error', error: e.message })
          setDlBusyBoth(false)
        })
        pump()
      }).catch((e) => {
        setDlLive({ stage: 'error', error: e.message })
        setDlBusyBoth(false)
      })
      return
    }
    // ⭐ 路径由后端 unifyDest 统一处理，前端只传原始命令
    //   ⛔ 原来硬编码 `engines/${id}/checkpoints` 正斜杠，在 Windows 上可能有问题
    // ⭐ 使用 buildCommand 统一构建，确保执行和展示一致
    const { argv } = buildCommand(c)
    // ⛔ 不 await —— 下载在后台跑，用户可以随时进入第 4 步
    fetch('/wizard/download', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, root: window.__PROJECT_ROOT__ || '', argv }),
    }).then((resp) => {
      if (!resp.ok) { setDlLive({ stage: 'error', error: 'HTTP ' + resp.status }); setDlBusyBoth(false); return }
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      const pump = () => reader.read().then(({ done, value }) => {
        if (done) { setDlBusyBoth(false); return }
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
          } else if ('percent' in ev) {
            setDlProgress({ file: ev.file || '', percent: ev.percent || 0, downloaded: ev.downloaded || '', total: ev.total || '' })
          } else if ('ok' in ev || 'error' in ev) {
            setDlLive({ stage: 'done', ok: ev.ok, error: ev.error, errorZh: ev.errorZh })
            setDlBusyBoth(false)
            setDlProgress(null)
            // ⭐ 下载完成后自动调 /wizard/download/files 逐文件校验
            //   ⛔ 不依赖 manifest —— 直接列 engines/<id>/checkpoints/ 下的文件
            if (ev.ok && id) {
              fetch(`/wizard/download/files?id=${encodeURIComponent(id)}`)
                .then((r) => r.json())
                .then((j) => { if (j.ok) setFileList(j.files) })
                .catch(() => { /* 读不到 ⇒ 空列表 */ })
            }
          }
        }
        pump()
      }).catch((e) => {
        setDlLive({ stage: 'error', error: e.message })
        setDlBusyBoth(false)
      })
      pump()
    }).catch((e) => {
      setDlLive({ stage: 'error', error: e.message })
      setDlBusyBoth(false)
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

      {/* ---- 下载清单表格：按文件列出 ----
          ⭐ 每个文件一行，显示大小/SHA-256/状态
          ⚠️ emoji 破例：✅已完成 / ⌛下载中 / ❌未下载
             这是一次使用 emoji 的破例，理由见计划文档 §1
             （直观性、国际惯例、语义明确）*/}
      {manifest && manifest.length > 0 && (
        <>
          <div className="plan-kv">
            <span className="pk">{t('Stored at', '存放位置')}</span>
            <span className="pv">
              <code>engines/{id}/checkpoints/</code>
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <button
              className="btn btn-sm"
              type="button"
              disabled={dlBusy}
              onClick={downloadAll}
            >
              {t('Download all', '下载全部')}
            </button>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>{t('File', '文件')}</th>
                <th>{t('Repo', '仓库')}</th>
                <th>{t('Size', '大小')}</th>
                <th>{t('SHA-256', 'SHA-256')}</th>
                <th>{t('Status', '状态')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {manifest.map((f, i) => {
                const cmd = { repo: f.repo || '', tool: f.tool || 'hf' }
                return (
                  <tr key={i}>
                    <td><code>{f.name || ''}</code></td>
                    <td>
                      {f.repo ? (
                        <a
                          href={f.tool === 'modelscope'
                            ? `https://modelscope.cn/models/${f.repo}`
                            : `https://huggingface.co/${f.repo}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {f.repo}
                        </a>
                      ) : t('(unknown)', '（未知）')}
                    </td>
                    <td>
                      {f.size > 0
                        ? `${(f.size / 1024 / 1024).toFixed(1)} MB`
                        : t('(unknown)', '（未知）')}
                    </td>
                    <td>
                      {f.sha256
                        ? <code style={{ fontSize: 11 }}>{f.sha256.slice(0, 16)}...</code>
                        : t('(unknown)', '（未知）')}
                    </td>
                    <td>
                      {f.status === 'ok' && <span title={t('Done', '已完成')}>✅</span>}
                      {f.status === 'partial' && (
                        <span title={
                          lang === 'zh'
                            ? (f.noteZh || '文件不完整，需要续传或重下。')
                            : (f.note || 'The file is incomplete — resume or re-download it.')
                        }>⌛</span>
                      )}
                      {f.status === 'missing' && <span title={t('Missing', '未下载')}>❌</span>}
                    </td>
                    <td>
                      {f.status === 'partial' && (
                        <button className="btn btn-sm" type="button"
                          disabled={dlBusy}
                          onClick={() => runDownload(cmd, f)}>
                          {t('Resume', '续传')}
                        </button>
                      )}
                      {f.status === 'missing' && (
                        <button className="btn btn-sm" type="button"
                          disabled={dlBusy}
                          onClick={() => runDownload(cmd, f)}>
                          {t('Download', '下载')}
                        </button>
                      )}
                      {f.status === 'ok' && (
                        <button className="btn btn-sm" type="button"
                          disabled={dlBusy}
                          onClick={() => runDownload(cmd, f)}>
                          {t('Re-download', '重下')}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}

      {/* ---- 下载命令展示：平台只打印，不代下载 ----
          ⭐ 用户可以看到上游 README 里的原始命令
          ⛔ 平台不执行这些命令 —— 只是展示给用户参考*/}
      {visibleCmds.length > 0 && (
        <div className="section" style={{ marginTop: 8 }}>
          <div className="section-hdr">
            <h2 style={{ fontSize: 13 }}>
              {t('Download commands', '下载命令')}
            </h2>
          </div>
          <div className="section-body">
            <div className="field-hint" style={{ marginTop: 0 }}>
              {t('Run these in the engine folder:', '在引擎目录内执行：')}
            </div>
            {probeError && (
              <div className="msg msg-danger" style={{ marginTop: 4 }}>
                {probeError}
              </div>
            )}
            {visibleCmds.map((c, i) => {
              const { display } = buildCommand(c)
              return (
              <div key={i} className="rc-cmd" style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
                <pre className="rc-cmd-body" style={{ flex: 1, margin: 0 }}>
                  {display}
                </pre>
                <button
                  className="btn btn-sm"
                  type="button"
                  disabled={probeLoading}
                  onClick={() => loadManifest(c)}
                  style={{ flexShrink: 0 }}
                >
                  {probeLoading
                    ? t('Probing…', '嗅探中…')
                    : t('Probe repo', '嗅探仓库')}
                </button>
              </div>
              )
            })}
          </div>
        </div>
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
            {dlProgress
              ? t(`Downloading ${dlProgress.file} (${dlProgress.percent}%)`, `正在下载 ${dlProgress.file} (${dlProgress.percent}%)`)
              : (dlLive && dlLive.stage === 'line'
                ? t('Downloading…', '下载中…')
                : t('Starting…', '启动中…'))}
          </div>
          {dlProgress ? (
            <>
              <div className="wz-progress">
                <div className="wz-progress-bar" style={{ width: `${dlProgress.percent}%` }} />
              </div>
              <div className="field-hint" style={{ marginTop: 4 }}>
                {dlProgress.downloaded}{dlProgress.total ? ` / ${dlProgress.total}` : ''}
              </div>
            </>
          ) : (
            <div className="wz-progress wz-progress-indeterminate">
              <div className="wz-progress-bar" />
            </div>
          )}
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
            : t('Download failed:', '下载失败：') + ' ' + (lang === 'zh' && dlLive.errorZh ? dlLive.errorZh : (dlLive.error || ''))}
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

      {/* ---- 命令：平台只填好占位符打印出来，⛔ 不代下载 ----
          ⛔ 原来这里有 {M && M.commands && ...} 和 {M && (!M.commands || ...)} 两个块，
             但 M 恒为 null（load 里 manifest: null），所以这些块永远不会执行。
             而且 {M.state === null && ...} 会抛 TypeError（M 是 null）。
             现在下载清单来自 probe，不依赖 manifest，所以这些死代码全部删除。*/}

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
