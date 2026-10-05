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

  const load = async () => {
    if (!id) return
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`/wizard/models?id=${encodeURIComponent(id)}`)
      const j = await res.json()
      if (!j.ok && j.code === 'NO_PROFILE') { setErr(j.error); return }
      setR(j)
      // ⛔ null（说不出来）**不写进 facts** ⇒ 界面上这一步不会变成「已完成」
      if (j.status && j.status.ready !== null && j.status.ready !== undefined) {
        onChange({ weightsReady: j.status.ready })
      }
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  React.useEffect(() => { if (id && !r && !busy) load() /* eslint-disable-line */ }, [id])

  const M = (r && r.manifest) || null
  // ⭐ 上游自己的下载入口（两种形态，见 core/wizardbridge.js 的探测）
  const upstreamScripts = (probe && probe.downloader) || []
  const upstreamCmds = (probe && probe.downloader_cmds) || []
  // 目标目录用户可改 —— ⛔ 不锁死成上游随手取的名
  const [dlDirs, setDlDirs] = React.useState({})
  const setDlDir = (i, v) => setDlDirs((m) => ({ ...m, [i]: v }))
  const dirOf = (c, i) => (dlDirs[i] === undefined ? (c.dir || '') : dlDirs[i])
  // ⭐ 按工具拼命令 —— 参数写法两个工具不一样（--local-dir= vs --local_dir）
  const renderCmd = (c, dir) => {
    const d = String(dir || '').trim()
    if (c.tool === 'modelscope') {
      return `modelscope download --model ${c.repo}${d ? ` --local_dir ${d}` : ''}`
    }
    return `${c.tool} download ${c.repo}${d ? ` --local-dir=${d}` : ''}`
  }

  // ⛔ **下到哪由使用者定**：平台不填默认路径、不替使用者决定、
  //   ⛔ 也不校验那个目录合不合规。平台只做一件事 ——
  //   把命令里的 --local-dir / --local_dir 换成使用者填的值。
  //   ⛔ 两种写法都要认：hf 是 --local-dir=，modelscope 是 --local_dir（少一个横杠）。
  //   判据：改目录后，命令里的路径参数与输入框同值。
  const [dest, setDest] = React.useState('')
  // ⭐ 只改**下载工具**命令里的目录参数；⛔ 其他命令（上游脚本）一个字都不动。
  //   ⛔ 之前这里给任何命令都补 --local-dir ⇒ 「python download_models.py」
  //      会被塞成「python download_models.py --local-dir=…」，
  //      而那个脚本根本不认这个参数（实测）。
  const rewriteDir = (cmd) => {
    const v = dest.trim()
    if (!v) return cmd
    const isDownloader = /^\s*(?:uv\s+tool\s+run\s+)?(?:hf|huggingface-cli|modelscope)\b/.test(cmd)
    if (!isDownloader) return cmd
    const hasDir = /--local[-_]dir/.test(cmd)
    return hasDir
      ? cmd
        .replace(/--local[-_]dir=\S+/g, `--local-dir=${v}`)
        .replace(/(--local_dir)(\s+)\S+/g, `$1$2${v}`)
      // README 那条命令本来没带目录参数 ⇒ 补一个（用的就是这个工具的参数名）
      : cmd + ` --local-dir=${v}`
  }


  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {err && <div className="msg msg-danger">{err}</div>}
      {!id && (
        <div className="msg msg-info">
          {t('Fill in the link first — the model list comes from the manifest.',
            '请先填写链接，需要下载的模型在 Manifest 中声明。')}
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

          <table className="table">
            <tbody>
              {M.items.map((it, i) => (
                <tr key={i}>
                  <th><code>{it.name || t('(not named)', '（未命名）')}</code></th>
                  <td>
                    {it.need ? (
                      it.have
                        ? <span className="badge badge-ok">{t('Present', '已就位')}</span>
                        : <span className="badge badge-warn">{t('Missing', '缺')}</span>
                    ) : (
                      <span className="muted">{it.why}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* ── ⭐ 上游自己的下载入口 ──────────────────────────
              两条口径：
              ① 「从现在开始，模型不再需要统一管理」
                 ⇒ ⛔ 平台不统一下载，模型归各引擎自己管。
              ② 「四条命令让用户自己选，下载之前可以探测一下有什么，
                 用户可以自选目录，也就是 --local-dir=checkpoints 这里
                 改一个 --local-dir=path/set/by/user 的事，魔搭那个也是同理的」
                 ⇒ ⭐ 命令**拆成三段**（工具 / 模型 / 目标目录），
                   ⭐ 目标目录是一个**输入框**，用户想改就改；
                   ⭐ 几个模型列成表让用户**自己选**下哪个。

              ⚠ 原样丢整条命令是**错的** —— 原样就等于把目标目录
                写死成上游随手取的名（checkpoints / checkpoints_2）。
              ⚠ 探测（每个模型目录里有什么）留给第 5 步的检查，
                ⛔ 这一步不下载任何东西，所以不必先探测。*/}
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

          {upstreamCmds.length > 0 && (
            <div className="section" style={{ marginTop: 4 }}>
              <div className="section-hdr">
                <h2 style={{ fontSize: 13 }}>{t('How the upstream downloads', '下载方式')}</h2>
              </div>
              <div className="section-body">
                <div className="field-hint" style={{ marginTop: 0 }}>
                  {t('From the project README. Change the folder if you want:',
                    '摘自项目 README。存放位置可自行修改：')}
                </div>

                {upstreamCmds.map((c, i) => (
                  <div key={i} style={{ marginBottom: 10 }}>
                    <div className="plan-kv">
                      <span className="pk">{t('Model', '模型')}</span>
                      <span className="pv"><code>{c.repo}</code></span>
                      <span className="pk">{t('Tool', '工具')}</span>
                      <span className="pv"><code>{c.tool}</code></span>
                    </div>
                    <div className="field" style={{ marginTop: 4 }}>
                      <label className="field-label"
                        htmlFor={`wz-dl-dir-${i}`}>
                        {t('Save into', '存到')}
                      </label>
                      <input id={`wz-dl-dir-${i}`} className="control" type="text"
                        value={dlDirs[i] === undefined ? (c.dir || '') : dlDirs[i]}
                        onChange={(e) => setDlDir(i, e.target.value)} />
                    </div>
                    <div className="rc-cmd">
                      <pre className="rc-cmd-body">{renderCmd(c, dirOf(c, i))}</pre>
                    </div>
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

export function StepVerify ({ state, onChange }) {
  const { t } = useT()
  const [r, setR] = React.useState(null)
  const [audio, setAudio] = React.useState(null)
  const [busy, setBusy] = React.useState('')
  const id = state.id

  const runChecks = async () => {
    setBusy('checks')
    try {
      const res = await fetch('/wizard/verify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, deep: false }),
      })
      const j = await res.json()
      setR(j)
      onChange({ verified: true, verifyOk: j.ok === true })
    } finally { setBusy('') }
  }

  const runAudio = async (level) => {
    setBusy('audio')
    try {
      const res = await fetch('/wizard/verify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, audio: level }),
      })
      setAudio(await res.json())
    } finally { setBusy('') }
  }

  React.useEffect(() => { if (id && !r) runChecks() /* eslint-disable-line */ }, [id])

  const checks = (r && r.checks) ? Object.values(r.checks) : []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {checks.map((c) => {
        // ⛔ ready:null 不算失败，但**也不算通过** —— 原文说清
        const ok = c.ready === undefined ? c.ok : c.ready === true
        const label = { env_shallow: t('Installed', '装没装'),
          env_deep: t('Starts', '起不起来'),
          checkpoints: t('Weights', '权重齐不齐'),
          audio: t('Speaks', '出不出声') }[c.key] || c.key
        const note = c.note || (c.problems && c.problems[0]) || ''
        return (
          <div key={c.key} className={`msg ${ok ? 'msg-info' : 'msg-danger'}`}>
            <b>{ok ? '✓' : '✗'} {label}</b>
            {note && <div className="field-hint">{note}</div>}
          </div>
        )
      })}

      {r && r.problems && r.problems.length > 0 && (
        <div className="msg msg-danger">{r.problems.join('; ')}</div>
      )}

      <div className="layer-label">{t('Fourth check: does it speak', '第四道：出不出声')}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-sm" type="button"
          disabled={busy === 'audio'} onClick={() => runAudio('B')}>
          {t('B level (fast, no audio)', 'B 级（快，不出声）')}
        </button>
        <button className="btn btn-sm" type="button"
          disabled={busy === 'audio'} onClick={() => runAudio('A')}>
          {t('A level (really synthesise)', 'A 级（真跑一次合成）')}
        </button>
        <button className="btn btn-sm" type="button"
          disabled={busy === 'checks'} onClick={runChecks}>
          {busy === 'checks' ? t('Checking…', '正在查…') : t('Run the first three again', '重跑前三道')}
        </button>
      </div>

      {audio && !audio.ok && (
        <div className="msg msg-danger">
          {audio.error}
          {audio.expected_shape && (
            <div className="field-hint">
              {t("The request body uses this engine's own dialect:",
                '请求体用这台引擎的方言：')} <code>{audio.expected_shape}</code>
            </div>
          )}
        </div>
      )}
      {audio && audio.ok && (
        <div className="msg msg-info">{audio.note || t('Done.', '完成。')}</div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
//  ⛔ 流程条只有五步，⛔ 不设「装完了怎么用」那一步。
//     它属于文档，不占一个流程步骤 —— 一个只放说明、不执行任何动作的格子
//     是流程条上的一格空话，且它往往要把内部术语（engines/、Manifest、
//     weights[]）摆到界面上。
//     判据：新增步骤前先问它有没有执行任何动作；没有 ⇒ 那是文档。
