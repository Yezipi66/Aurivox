import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { loadDownloadState, saveDownloadState } from './downloadState'
import { DEFAULT_CONCURRENCY } from './downloadQueue'
import { downloadFiles } from './downloadRunner'

// 第 3 步（下载模型）：列出远端仓库的文件清单，逐个下载，并显示每个文件在盘上的状态。
// 清单来自上游仓库 API 与第 1 步探测到的仓库地址，不依赖 manifest。
// 落盘路径统一由后端决定（engines/<id>/checkpoints/），前端只传原始命令。

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

export function StepModels ({ state, onChange, probe, prep, onFixId }) {
  const { t, lang } = useT()
  const [r, setR] = React.useState(null)
  const [err, setErr] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const sessionId = (prep && prep.res && prep.res.id) || ''
  React.useEffect(() => {
    if (sessionId && sessionId !== state.id && onFixId) onFixId(sessionId)
  }, [sessionId, state.id])
  const id = sessionId || state.id

  // 下载清单来自 probe（第 1 步），不依赖 manifest。
  // /wizard/models 内部要调 describeModels → resolveEngineProfile，而它需要 manifest，
  // manifest 却要到第 4 步才写。
  const load = async () => {
    if (!id) return
    setBusy(true); setErr(null)
    try {
      if (!probe) { setErr('No probe data. Complete step 1 first.'); return }
      const cmds = probe.downloader_cmds || []
      const scripts = probe.downloader || []
      setR({ ok: true, manifest: null, status: null, commands: [], downloader_cmds: cmds, downloader: scripts })
      // 清空之前嗅探到的仓库文件
      setManifest(null)
      setProbeError(null)
      setFileList(null)
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  // 下载状态（SSE 流式）。
  // 声明必须在使用之前：下面的 useEffect 引用了 dlLive，
  // 声明在后面会触发 TDZ（Cannot access 'dlLive' before initialization）。
  //
  // 下载活动按文件分槽记在 dlFiles 里：一个文件名对应一条。
  //   为什么不记成一条全局的进度：同时下几个文件时，全局那条会被后到的进度盖掉，
  //   界面上只剩最后一个文件的进度，其余几个看着像没动。
  //   单文件下载也走这张表（只有一个条目），两处逻辑因此是同一套。
  const [dlFiles, setDlFiles] = React.useState({})
  const [dlBusy, setDlBusy] = React.useState(false)
  const [dlSummary, setDlSummary] = React.useState(null)

  // 整轮下载的汇总（单文件下载时是那一个文件的结果）。
  // dlLive 是它的旧名字，保留是为了少改调用点：内容仍是一句话的状态。
  const dlLive = dlSummary

  // 进行中的文件条目：每个文件一条进度。
  //   同时下几个文件时，只有一条全局进度的话，界面上只剩最后一个文件的进度，
  //   其余几个看着像没动。所以进度按文件名分槽，各占一行。
  const dlEntries = Object.entries(dlFiles)

  // 取消：前端只发取消信号，真正的中断由后端做。
  //   前端自己 abort fetch 是不够的：SSE 断了不代表后端的请求停了。
  const dlCancelRef = React.useRef(false)

  // 远端文件列表（来自 /wizard/download/manifest）
  const [manifest, setManifest] = React.useState(null)
  const [probeLoading, setProbeLoading] = React.useState(false)
  const [probeError, setProbeError] = React.useState(null)

  // 去重：默认按 repo 去重（同一个仓库只显示一次），勾选后显示全部
  const [dedup, setDedup] = React.useState(true)

  // 持久化：从会话段恢复状态（sessionStorage，键含 id 与 url）。
  // 懒初始化读一次；换 URL / 换引擎 ⇒ 键变 ⇒ 恢复到的是另一段会话。
  React.useEffect(() => {
    if (!id) return
    const saved = loadDownloadState(id, state.repoUrl || '')
    if (saved) {
      if (saved.manifest) setManifest(saved.manifest)
      if (saved.probeError) setProbeError(saved.probeError)
      if (typeof saved.dedup === 'boolean') setDedup(saved.dedup)
    }
  }, [id, state.repoUrl])

  // 持久化：保存状态到会话段
  React.useEffect(() => {
    if (!id) return
    saveDownloadState(id, state.repoUrl || '', { manifest, probeError, dedup })
  }, [id, state.repoUrl, manifest, probeError, dedup])

  React.useEffect(() => { if (id && !r && !busy) load() /* eslint-disable-line */ }, [id])

  // 断点续传：页面加载时读进度文件，恢复「已下载」状态。不依赖 manifest。
  React.useEffect(() => {
    if (!id) return
    fetch(`/wizard/download/progress?id=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.ok && Array.isArray(j.done) && j.done.length > 0) {
          // 有已完成的命令 → 标记为「已下载」
          setDlSummary({ stage: 'done', ok: true })
        }
      })
      .catch(() => { /* 读不到进度文件 ⇒ 没有已下载的 */ })
  }, [id])

  // 逐文件校验：下载完成后自动调 /wizard/download/files 读文件列表。
  // 不依赖 manifest：直接列 engines/<id>/checkpoints/ 下的文件。
  // 三态：已下载（文件存在且大小>0）/ 未下载（文件不存在）/ 不完整（大小为0）。
  const [fileList, setFileList] = React.useState(null)
  React.useEffect(() => {
    if (!id || !dlLive || dlLive.stage !== 'done') return
    fetch(`/wizard/download/files?id=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((j) => { if (j.ok) setFileList(j.files) })
      .catch(() => { /* 读不到 ⇒ 空列表 */ })
  }, [id, dlLive])

  // 远端文件列表：用户点击「嗅探仓库」按钮后加载。
  // 不自动加载：用户主动触发，避免不必要的网络请求。

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

  // 嗅探仓库：调 /wizard/download/manifest 获取文件列表。
  // 追加不覆盖：点某个仓库的按钮显示该仓库的文件，再点另一个仓库的按钮追加到列表后面。
  // 同仓库去重：同一个仓库重复点击按钮，忽略。
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
      // 守卫：检查响应是否是有效的 JSON（防止 HTML 错误页面导致 JSON 解析失败）
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
        // 显示错误信息，让用户知道嗅探失败
        setProbeError(j.error || t('Probe failed', '嗅探失败'))
      }
    } catch (e) {
      setProbeError(e.message || t('Probe failed', '嗅探失败'))
    } finally { setProbeLoading(false) }
  }

  // manifest 刷新：把新状态合并回旧表，不整表覆盖。
  // 刷新响应可能缺 repo/tool（旧后端），而旧表里每一项都带着来源：
  // 整表覆盖会把「这个文件属于哪个仓库」抹掉，重下与续传按钮随之失效。
  // 以「仓库 + 文件名」为键：命中就更新状态，不动其他仓库的行。
  const mergeManifest = (prev, fresh, repo, tool) => {
    const freshList = (fresh || []).map((f) => ({
      ...f,
      repo: f.repo || repo,
      tool: f.tool || tool,
    }))
    if (!Array.isArray(prev) || prev.length === 0) return freshList
    // 用传入的 repo 作为 fallback，确保 prev 里的文件也有 repo
    const key = (f) => `${f.repo || repo}|${f.name}`
    const byKey = new Map(freshList.map((f) => [key(f), f]))
    const merged = prev.map((f) => {
      const freshFile = byKey.get(key(f))
      if (!freshFile) {
        return {
          ...f,
          repo: f.repo || repo,
          tool: f.tool || tool,
        }
      }
      // 保留旧的 sha256 值（当新值为 null 时）
      return {
        ...freshFile,
        sha256: freshFile.sha256 || f.sha256 || null,
      }
    })
    const seen = new Set(prev.map(key))
    for (const f of freshList) if (!seen.has(key(f))) merged.push(f)
    return merged
  }

  // 下载全部：把没下载完的文件一次性交给执行器，它按并发上限分批派。
  //   用 ref 追踪下载状态，避免闭包读到旧的 state 值。
  const dlBusyRef = React.useRef(false)
  // 暂停只停前端的派单，不终止在途的请求：当前文件下载中杀进程会留下不完整的文件，
  // 而远端下载器自带缓存，重跑同一条命令只补缺的部分。
  // 所以界面上必须写清楚「当前文件下载中，暂停将在当前文件完成后生效」，
  // 不写清楚就是让使用者以为点了就停。
  const dlPausedRef = React.useRef(false)
  const [dlPaused, setDlPaused] = React.useState(false)

  // 某个文件的进度：按文件名分槽，同时下几个文件时互不覆盖。
  const setFileProgress = (name, ev) => {
    setDlFiles((prev) => ({
      ...prev,
      [name]: { ...(prev[name] || {}), percent: ev.percent, downloaded: ev.downloaded, total: ev.total },
    }))
  }

  // 某个文件结束：记下结果，成功就把这一行的状态改成「已下载」。
  const setFileDone = (name, result) => {
    setDlFiles((prev) => ({
      ...prev,
      [name]: { ...(prev[name] || {}), done: true, ok: result && result.ok === true, error: result && result.error },
    }))
    if (result && result.ok && id) {
      // 下载完成后自动刷新清单（合并刷新，不整表覆盖）
      fetch(`/wizard/download/files?id=${encodeURIComponent(id)}`)
        .then((r) => r.json())
        .then((j) => { if (j.ok) setFileList(j.files) })
        .catch(() => { /* 读不到 ⇒ 空列表 */ })
    }
  }

  const downloadAll = () => {
    if (!manifest || manifest.length === 0) return
    const filesToDownload = manifest.filter((f) => f.status === 'missing' || f.status === 'partial')
    if (filesToDownload.length === 0) return
    dlBusyRef.current = true
    dlPausedRef.current = false
    dlCancelRef.current = false
    setDlPaused(false)
    setDlBusyBoth(true)
    setDlSummary({ stage: 'start' })
    setDlFiles({})
    runDownloads(filesToDownload)
  }

  // 执行一批下载：单文件与「下载全部」共用这一条路，界面逻辑因此是同一套。
  const runDownloads = (files) => {
    downloadFiles({
      id,
      root: window.__PROJECT_ROOT__ || '',
      files,
      concurrency: DEFAULT_CONCURRENCY,
      shouldStop: () => dlPausedRef.current || dlCancelRef.current,
      onProgress: setFileProgress,
      onDone: setFileDone,
    }).then((r) => {
      dlBusyRef.current = false
      setDlBusyBoth(false)
      if (dlCancelRef.current) {
        setDlSummary({ stage: 'cancelled' })
      } else if (dlPausedRef.current) {
        setDlSummary({ stage: 'paused' })
      } else if (r.ok) {
        setDlSummary({ stage: 'done', ok: true })
      } else {
        setDlSummary({ stage: 'done', ok: false, error: r.firstError, errorZh: r.firstErrorZh })
      }
    })
  }

  const pauseDownload = () => {
    dlPausedRef.current = true
    setDlPaused(true)
  }

  // 取消：停掉整轮下载。
  //   前端只负责不再派新任务并通知后端；真正的中断由后端做
  //   （前端 abort fetch 只是断了 SSE，后端的请求照跑）。
  const cancelDownload = () => {
    dlCancelRef.current = true
    dlPausedRef.current = true
    setDlPaused(true)
    fetch('/wizard/download/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(() => { /* 取消信号发不出去也不影响界面状态 */ })
  }

  // 删掉一个不完整的文件，让它回到「未下载」。走同一个 checkFileStatus 判据（后端），
  // 不在这里按大小猜；判为 ok 的不会被删。
  const removePartial = async (f) => {
    if (!f || !f.name) return
    try {
      const resp = await fetch('/wizard/download/file', {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id, name: f.name,
          size: f.size || null, sha256: f.sha256 || null,
          root: window.__PROJECT_ROOT__ || '',
        }),
      })
      const j = await resp.json()
      // 缺信息不等于残缺：没有 sha 可比对时后端不删，如实告诉使用者
      if (j.ok && (j.deleted || []).includes(f.name)) {
        setFileList((list) => list.map((x) => (x.name === f.name
          ? { ...x, status: 'missing', size: 0, sha256: null, shaVerified: false }
          : x)))
      } else {
        setErr(lang === 'zh' ? (j.errorZh || j.error || '未能删除该文件。') : (j.error || 'Could not delete this file.'))
      }
    } catch (e) {
      setErr(lang === 'zh' ? '删除失败，请手动删除该文件。' : 'Delete failed; remove the file manually.')
    }
  }

  // 下载是「发射后不管」的后台任务：点击后启动下载，不阻塞 UI，
  // 用户可以随时进入第 4 步写 manifest（此时下载还在后台跑）。
  // 不用 await：await 会阻塞 UI，用户要等下载完成才能做其他事。
  const setDlBusyBoth = (v) => { dlBusyRef.current = v; setDlBusy(v) }
  // 单文件下载：表格里的「下载 / 续传 / 重下」按钮走这里。
  //   与「下载全部」共用 runDownloads，因此进度分槽、取消、收口是同一套逻辑。
  const runDownload = (c, file) => {
    if (!file || !file.name) return
    dlBusyRef.current = true
    dlPausedRef.current = false
    dlCancelRef.current = false
    setDlPaused(false)
    setDlBusyBoth(true)
    setDlSummary({ stage: 'start' })
    setDlFiles({})
    runDownloads([{ ...file, repo: file.repo || c.repo, tool: file.tool || c.tool }])
  }

  // 统一落盘：所有下载命令的 local_dir 都替换成 engines/<id>/checkpoints/。
  // 不删原目录：hf / modelscope 的缓存在那里，删了要重下。
  // 不替用户决定路径：这是平台统一落盘策略，不是用户可选的。

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {err && <div className="msg msg-danger">{err}</div>}
      {!id && (
        <div className="msg msg-info">
          {t('Fill in the link first — the model list comes from the upstream README.',
            '请先填写链接，需要下载的模型从上游 README 中提取。')}
        </div>
      )}

      {/* 下载清单表格：按文件列出，每个文件一行，显示大小 / SHA-256 / 状态 */}
      {manifest && manifest.length > 0 && (
        <>
          <div className="plan-kv">
            <span className="pk">{t('Stored at', '存放位置')}</span>
            <span className="pv">
              <code>engines/{id}/checkpoints/</code>
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8, gap: 8 }}>
            <button
              className="btn btn-sm"
              type="button"
              disabled={dlBusy}
              onClick={downloadAll}
              style={{ flexShrink: 0 }}
            >
              {t('Download all', '下载全部')}
            </button>
            {/* 暂停只停前端的派单，不终止在途的请求。文案必须写清楚
                「当前文件下载中，暂停将在当前文件完成后生效」，不写就是欺骗。 */}
            {dlBusy && (
              <button
                className="btn btn-sm"
                type="button"
                disabled={dlPaused}
                onClick={pauseDownload}
                style={{ flexShrink: 0 }}
              >
                {t('Pause', '暂停')}
              </button>
            )}
            {/* 取消与暂停是两件事：取消会终止在途的请求，
                已经下载完成的文件保留，未完成的文件不保留。 */}
            {dlBusy && (
              <button
                className="btn btn-sm btn-danger"
                type="button"
                disabled={dlCancelRef.current}
                onClick={cancelDownload}
                style={{ flexShrink: 0 }}
              >
                {t('Cancel', '取消')}
              </button>
            )}
          </div>
          {dlBusy && (
            <div className="field-hint" style={{ marginBottom: 8 }}>
              {t(`Downloading up to ${DEFAULT_CONCURRENCY} files at a time. `
                + 'Pausing takes effect after the current files finish — '
                + 'the download requests are not terminated, so resuming reuses '
                + 'what has already been fetched.',
                `同时最多下载 ${DEFAULT_CONCURRENCY} 个文件。`
                + '暂停将在当前这些文件下载完成后生效。'
                + '暂停不会终止下载请求，因此续跑时会复用已下载的部分。')}
            </div>
          )}
          {dlLive && dlLive.stage === 'paused' && (
            <div className="msg msg-info">
              {t('Paused. The remaining files are still marked as not downloaded.',
                '已暂停。剩余文件仍标记为未下载。')}
            </div>
          )}
          {dlLive && dlLive.stage === 'cancelled' && (
            <div className="msg msg-info">
              {t('Cancelled. Files that finished downloading are kept; '
                + 'the ones that did not are marked as not downloaded.',
                '已取消。已下载完成的文件保留，未完成的文件标记为未下载。')}
            </div>
          )}
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
                        ? <code style={{ fontSize: 'var(--fs-11)' }} title={f.sha256}>{f.sha256.slice(0, 16)}...</code>
                        : t('(unknown)', '（未知）')}
                    </td>
                    <td>
                      {f.status === 'ok' && <span className="badge badge-ok" title={t('Done', '已完成')} />}
                      {f.status === 'partial' && (
                        <span title={
                          lang === 'zh'
                            ? (f.noteZh || '文件不完整，需要续传或重下。')
                            : (f.note || 'The file is incomplete — resume or re-download it.')
                        }>⌛</span>
                      )}
                      {f.status === 'missing' && <span className="badge badge-danger" title={t('Missing', '未下载')} />}
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

      {/* 下载命令展示：平台只打印，不代下载。
          用户可以看到上游 README 里的原始命令，平台不执行它们，只是展示给用户参考。*/}
      {visibleCmds.length > 0 && (
        <div className="section" style={{ marginTop: 8 }}>
          <div className="section-hdr">
            <h2 style={{ fontSize: 'var(--fs-13)' }}>
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

      {/* 进度条：每个文件一条。同时下几个文件时，一条全局进度
          会让其余几个看着像没动，所以这里按文件名分槽。 */}
      {dlBusy && (
        <div className="preflight" style={{ marginTop: 8 }}>
          <div className="layer-label">
            {dlEntries.length > 0
              ? t(`Downloading ${dlEntries.length} file(s)…`, `正在下载 ${dlEntries.length} 个文件…`)
              : t('Starting…', '启动中…')}
          </div>
          {dlEntries.length > 0
            ? dlEntries.map(([name, p]) => (
              <div key={name} style={{ marginTop: 6 }}>
                <div className="field-hint" style={{ marginTop: 0 }}>
                  {p.done
                    ? (p.ok
                      ? t(`${name} — done`, `${name} — 完成`)
                      : t(`${name} — failed: ${p.error || ''}`, `${name} — 失败：${p.error || ''}`))
                    : t(`Downloading ${name} (${p.percent || 0}%)`, `正在下载 ${name} (${p.percent || 0}%)`)}
                </div>
                {!p.done && (
                  <div className="wz-progress">
                    <div className="wz-progress-bar" style={{ width: `${p.percent || 0}%` }} />
                  </div>
                )}
              </div>
            ))
            : (
              <div className="wz-progress wz-progress-indeterminate">
                <div className="wz-progress-bar" />
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

      {/* 逐文件校验结果：三态显示 */}
      {fileList && fileList.length > 0 && (
        <div className="preflight" style={{ marginTop: 8 }}>
          <div className="layer-label">{t('Files on disk', '磁盘上的文件')}</div>
          {fileList.map((f, i) => {
            // 三态由后端判（大小 + 上游 sha），不在这里看大小猜：
            // 大小对但 sha 不符的必须报不完整，只看大小会当成好的。
            // shaVerified 为 false 时不能声称「已校验」。
            const state = f.status === 'ok' ? 'ok' : 'partial'
            const checked = f.shaVerified === true
            return (
              <div key={i} className="pf-row">
                <span className={`badge badge-${state}`}>
                  {state === 'ok' ? '✓' : '◐'}
                </span>
                <span className="pf-val"><code>{f.name}</code></span>
                <span className="field-hint" style={{ marginTop: 0 }}>
                  {f.size > 0
                    ? `${(f.size / 1024 / 1024).toFixed(1)} MB`
                    : t('(empty / partial)', '（空 / 不完整）')}
                  {state === 'ok' && checked
                    ? t(' (sha256 verified)', '（SHA-256 已校验）')
                    : state === 'ok'
                      ? t(' (sha256 not provided by the remote)', '（远端未提供 SHA-256，未校验）')
                      : ''}
                </span>
                {state === 'partial' && (
                  <button className="btn btn-sm" onClick={() => removePartial(f)}>
                    {t('Delete partial and re-download', '删除不完整文件并重新下载')}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 上游附带的下载脚本（如果有）。
          平台不执行它们，只是告诉用户「上游自己给了这个脚本」，
          执行是用户自己的事，平台只负责把命令摆出来。*/}
      {upstreamScripts.length > 0 && (
        <div className="section" style={{ marginTop: 4 }}>
          <div className="section-hdr">
            <h2 style={{ fontSize: 'var(--fs-13)' }}>
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

      {/* 命令：平台只填好占位符打印出来，不代下载。
          下载清单来自 probe，不依赖 manifest。*/}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-sm" type="button" onClick={load} disabled={busy || !id}>
          {busy ? t('Checking…', '正在查…') : t('Check again', '再查一次')}
        </button>
        {/* 从头重装本步：只清「哪些下载算做完了」这份记录（models 段），
            不删已下载的模型文件、不删源码与依赖。*/}
        {id && (
          <>
            <button className="btn btn-sm" type="button"
              disabled={dlBusy}
              onClick={() => resetThisStepOf(id)}>
              {t('Reinstall this step from the start', '从头重装本步')}
            </button>
            <span className="field-hint">
              {t('Clears the record of finished downloads in this step only. '
                + 'Downloaded files are kept.',
                '只清除本步的已完成记录，已下载的文件保留。')}
            </span>
          </>
        )}
      </div>
    </div>
  )
}

/** 从头重装本步：清 models 段的进度记录（不删已下载的文件） */
async function resetThisStepOf (id) {
  try {
    await fetch('/wizard/reset-progress', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, section: 'models' }),
    })
  } catch (e) { /* 端点不通 ⇒ 记录还在，不当成已清 */ }
}

// StepVerify 已移出本文件：它现在自己管三项独立验证，各报各的状态。
export { StepVerify } from './StepVerify'

// 流程条只有五步，不设「装完了怎么用」那一步。
// 它属于文档，不占一个流程步骤：一个只放说明、不执行任何动作的格子是流程条上的一格空话，
// 而且它往往要把内部术语（engines/、Manifest、weights[]）摆到界面上。
// 判据：新增步骤前先问它有没有执行任何动作；没有 ⇒ 那是文档。
