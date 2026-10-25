import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { useInstalled } from './useInstalled'
import { useEngineDirs } from './useEngineDirs'
import { manifestForEngineSwitch } from './manifestAutoFill'

// 名片身份条：这是哪台引擎的名片、平台现在知道它什么状况。
//
// 放在中栏顶部而不是左栏：身份跟着名片走，不是跟着参数走。
// 左栏只是「扫到的参数」，中栏才是「这张名片」；两者不是一件东西。
//
// 平台填的是「应该是哪」不是「现在是哪」：
//   runtime.python 与 runtime.checkpoints 是路径（第 2 步往那儿装、第 3 步往那儿下），
//   路径是确定的；但那个解释器现在建好了没有、权重齐了没有，是另一件事，
//   由 install-state 的三态报（models 是 true/false/null 三态）。
// 所以这里显示两件分开的事：路径写在表单里，现状写在这里。

// 状态语气 → 项目的 badge 类名。项目只有这几种 badge，
// 自己再造一套颜色与圆角就成了第二套规范（styleguard 会拦裸 px 圆角）。
const BADGE_TONE = { ok: 'ok', warn: 'warn', muted: 'neutral' }

/**
 * 名片身份条。
 *
 * @param {object} manifest 当前名片
 * @param {Function} onChange 名片变化回调
 * @param {object|null} facts install-state 给的完成状态
 * @param {React.ReactNode} children 额外内容（收起按钮等）
 */
export default function EngineIdentity ({
  manifest, onChange, facts, children,
}) {
  const { t } = useT()
  const { loadOne } = useInstalled()
  const { dirs } = useEngineDirs()
  const [engineId, setEngineId] = React.useState(manifest.id || '')
  const [picking, setPicking] = React.useState(false)
  const [localErr, setLocalErr] = React.useState(null)

  React.useEffect(() => {
    if (!engineId && manifest.id) setEngineId(manifest.id)
  }, [manifest.id, engineId])

  const selectedDir = dirs.find((d) => d.id === engineId)
  const hasManifest = !!selectedDir && selectedDir.manifestPresent === true

  // 选中一台引擎：有名片的先把磁盘原文灌进表单，没名片的直接进扫描态。
  // 两件事都是「打开这台引擎的名片」，区别只在平台已知的那一个判据。
  //
  // 换引擎时上一台的内容要清干净：
  //   磁盘上有名片的 ⇒ 整张换成磁盘上有的（上一台的残留自然没了）。
  //   磁盘上没名片的 ⇒ 用 manifestForEngineSwitch 清掉上一台的段。
  //     不能只改 id：只改 id 会把上一台的 runtime（python 路径、checkpoints、
  //     verify 里的类名）与 call（kind/module/class/method）整段带过去，
  //     存下去就是一张「id 写着新引擎、里面跑上一台」的名片。
  const openEngine = async (id) => {
    if (!id) return
    setEngineId(id)
    setLocalErr(null)
    setPicking(true)
    try {
      const target = dirs.find((d) => d.id === id)
      if (!target || target.manifestPresent !== true) {
        // 没名片：清掉上一台的段，只留 id 与 label，其余交给扫描。
        // label 用新 id：上一台的 label 描述的是上一台，
        //   留着就是一张「id 是新引擎、label 写着上一台」的名片。
        onChange(manifestForEngineSwitch(manifest, id, id))
        return
      }
      const r = await loadOne(id)
      if (!r.ok) { setLocalErr(r.error || t('Failed to read the manifest', '读取名片失败')); return }
      let parsed
      try { parsed = JSON.parse(r.text) } catch (e) {
        setLocalErr(t('The manifest on disk is not valid JSON', '磁盘上的名片不是合法 JSON'))
        return
      }
      onChange(parsed)
    } finally { setPicking(false) }
  }

  // 现状三态：权重是 true（齐了）/ false（缺了）/ null（说不出来）。
  // 「确实缺了」是要补的信号，「说不出来」只是还没查清，两者不一样。
  const models = facts && facts.models
  const weights = models === true
    ? { tone: 'ok', text: t('Weights ready', '权重已就绪') }
    : models === false
      ? { tone: 'warn', text: t('Weights missing', '权重还没下好') }
      : { tone: 'muted', text: t('Weights not checked', '权重还没查过') }

  const env = facts && facts.env
  const envOk = env === true
  const engineState = envOk ? weights : { tone: 'muted', text: t('Engine environment not ready', '引擎环境还没建好') }

  return (
    <div className="section">
      <div className="section-hdr">
        <h2>{t('Manifest for', '正在填的名片')}</h2>
        {children}
      </div>
      <div className="section-body">
        <div className="field">
          <label className="field-label">{t('Engine', '引擎')}</label>
          <select className="control" value={engineId}
            disabled={picking}
            onChange={(e) => openEngine(e.target.value)}>
            <option value="">{t('— pick an engine —', '— 选一台引擎 —')}</option>
            {dirs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.id}{d.manifestPresent ? '' : `（${t('no manifest yet', '还没名片')}）`}
              </option>
            ))}
          </select>
        </div>

        <div className="wz-identity-row">
          <span className={`badge badge-${BADGE_TONE[engineState.tone]}`}>{engineState.text}</span>
          {engineId && (
            <span className="wz-identity-path">
              <code>engines/{engineId}/</code>
            </span>
          )}
          <span className={`badge badge-${hasManifest ? 'ok' : 'neutral'}`}>
            {hasManifest
              ? t('Manifest read from disk', '名片读自磁盘')
              : t('New manifest', '新建名片')}
          </span>
        </div>

        {localErr && <div className="msg msg-danger">{localErr}</div>}
      </div>
    </div>
  )
}
