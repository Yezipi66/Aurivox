// 第 4 步的名片身份条：选引擎、读参数、保存。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { useInstalled } from './useInstalled'
import { useSaveManifest } from './useSaveManifest'
import { manifestForEngineSwitch } from './manifestAutoFill'
import Select from '../../../web/src/components/common/Select'

// 名片身份条：中栏最上面一行，第 4 步的全部动作都在这一行。
//
//   [引擎 ▾]  [扫描参数 | 读取参数]  engines/<id>/manifest.json            [保存]
//
// 动作按钮只有一个，文字随状态变：
//   没名片的引擎           ⇒ 「扫描参数」：从源码里扫出参数，进左栏。
//   有名片、还没读进来      ⇒ 「读取参数」：把磁盘上这份名片读进表单。
//   读进来之后             ⇒ 回到「扫描参数」：有了名片里的 call.module / runtime.python，
//                            python 反射这时才扫得动（/wizard/discover 依赖它们）。
// 路径在名片「就位」之后才出现：读取成功，或新引擎扫过一次。
//   在那之前显示路径只是在说一个还不存在的东西。
// 保存在最右边，不再用页面底部的独立存盘栏。
//
// 平台填的是「应该是哪」不是「现在是哪」：路径是确定的，
//   但环境建好没有、权重齐没齐，由 install-state 的三态报，徽标里单独说。

const BADGE_TONE = { ok: 'ok', warn: 'warn', muted: 'neutral' }

/**
 * @param {object} manifest 当前名片
 * @param {Function} onChange 名片变化回调
 * @param {object|null} facts install-state 给的完成状态
 * @param {Function} onScan 扫描参数（页面层持有扫描状态）
 * @param {boolean} scanBusy 扫描中
 * @param {boolean} scanned 这台引擎扫过至少一次
 * @param {object|null} diag 校验结果（有硬错时点保存只列问题、不存）
 * @param {Function} onSaved 保存成功回调
 * @param {Function} [onEngineTarget] 换引擎时同步全局目标（wz.id），一台引擎贯穿全流程
 * @param {Array} dirs 引擎目录清单，由 App 统一持有：五步认的是同一份，不在各处各取一次。
 * @param {Function} [onDirsReload] 保存后刷新目录清单（新名片让「尚无名片」标记消失）
 */
export default function EngineIdentity ({
  manifest, onChange, facts, onScan, scanBusy, scanned, diag, onSaved, onEngineTarget,
  dirs, onDirsReload, viewSwitch,
}) {
  const { t } = useT()
  const { loadOne } = useInstalled()
  const [engineId, setEngineId] = React.useState(manifest.id || '')
  const [reading, setReading] = React.useState(false)
  const [loaded, setLoaded] = React.useState(false)   // 磁盘上的名片已读进表单
  const [localErr, setLocalErr] = React.useState(null)
  // 点过「保存」才列出挡着保存的错误。
  //   进第 4 步时名片还是空的，检查器必然报「少了必填项」；
  //   人还什么都没做就先看到一片红，只会加重心智负担。
  //   计数照常在「检查结果」面板里，想看随时能看；这里只在人要保存时说为什么存不了。
  const [triedSave, setTriedSave] = React.useState(false)

  React.useEffect(() => {
    if (!engineId && manifest.id) setEngineId(manifest.id)
  }, [manifest.id, engineId])

  const selectedDir = (dirs || []).find((d) => d.id === engineId)
  const hasManifest = !!selectedDir && selectedDir.manifestPresent === true

  const { save, busy: saving, result } = useSaveManifest(manifest, (j) => {
    // 新建的名片存下去之后，这台引擎就「有名片」了：下拉与覆盖语义都要跟上。
    if (onDirsReload) onDirsReload()
    setLoaded(true)
    if (onSaved) onSaved(j)
  })

  // 选引擎：只换「正在填哪一台」，不读盘上的名片。
  //   一台引擎只有一张名片，读它和使用者点「读取参数」是同一个动作；
  //   替使用者读掉，等于把「读取 / 创建名片」这一步藏起来。
  //   上一台的内容一律清掉（manifestForEngineSwitch），
  //   不能只改 id：那会把上一台的 runtime 与 call 整段带过去。
  //   同时同步全局目标（onEngineTarget）：第 4 步换引擎 = 整条向导换成这台。
  const pickEngine = (id) => {
    setEngineId(id)
    setLoaded(false)
    setLocalErr(null)
    setTriedSave(false)
    if (onEngineTarget) onEngineTarget(id || '')
    if (!id) return
    onChange(manifestForEngineSwitch(manifest, id, id))
  }

  const readManifest = async () => {
    if (!engineId) return
    setReading(true); setLocalErr(null)
    try {
      const r = await loadOne(engineId)
      if (!r.ok) { setLocalErr(r.error || t('Failed to read the manifest', '读取名片失败')); return }
      let parsed
      try { parsed = JSON.parse(r.text) } catch {
        setLocalErr(t('The manifest on disk is not valid JSON', '磁盘上的名片不是合法 JSON'))
        return
      }
      onChange(parsed)
      setLoaded(true)
    } finally { setReading(false) }
  }

  // 没有名片时这一格是「新建名片」：扫描结果直接成为这张新名片的内容，
  //   形态（call.kind）与入口都在这一次扫描里定下来。
  //   有名片但没读进来 ⇒ 「读取参数」。名片就位之后不再有动作按钮：
  //   扫描参数移到中栏「调用方式」右边，离它要改的字段更近。
  const needsCreate = !hasManifest
  const needsRead = hasManifest && !loaded
  const ready = loaded || (!hasManifest && scanned)

  const createManifest = async () => {
    if (!engineId) return
    setLocalErr(null)
    // 先落一张只有身份的名片：扫描结果要写回它，中栏的「扫描参数」也要靠
    //   「有名片」这个状态才出现。
    await save()
    // 让父层状态落地：save 走的是渲染时那一份，扫描的写回要等下一次渲染才进 ref。
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (onScan) await onScan({ writeBack: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // 扫描结果再存一次：这一步才把形态、入口与绑定写进磁盘上的名片。
    await save()
  }

  const hasErrors = !!(diag && diag.summary && diag.summary.errors > 0)

  const models = facts && facts.models
  const weights = models === true
    ? { tone: 'ok', text: t('Weights ready', '权重已就绪') }
    : models === false
      ? { tone: 'warn', text: t('Weights missing', '权重未下载完整') }
      : { tone: 'muted', text: t('Weights not checked', '权重未检查') }
  const envOk = !!(facts && facts.env === true)
  const engineState = envOk ? weights : { tone: 'muted', text: t('Engine environment not ready', '引擎环境未就绪') }

  return (
    <div className="section">
      <div className="section-body">
        <div className="wz-identity-bar">
          <Select className="control wz-identity-engine" value={engineId}
            aria-label={t('Engine', '引擎')}
            disabled={reading || saving}
            onChange={(e) => pickEngine(e.target.value)}>
            <option value="">{t('— pick an engine —', '请选择一台引擎')}</option>
            {(dirs || []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.id}{d.manifestPresent ? '' : `（${t('no manifest yet', '尚无名片')}）`}
              </option>
            ))}
          </Select>

          {needsCreate && (
            <button className="btn btn-sm btn-primary" type="button"
              disabled={!engineId || scanBusy || saving} onClick={createManifest}>
              {scanBusy || saving
                ? t('Creating…', '新建中…')
                : t('Create manifest', '新建名片')}
            </button>
          )}
          {needsRead && (
            <button className="btn btn-sm btn-primary" type="button"
              disabled={!engineId || reading} onClick={readManifest}>
              {reading ? t('Reading…', '读取中…') : t('Read parameters', '读取参数')}
            </button>
          )}

          {ready && (
            <code className="wz-identity-path">{`engines/${engineId}/manifest.json`}</code>
          )}
          {engineId && (
            <span className={`badge badge-${BADGE_TONE[engineState.tone]}`}>{engineState.text}</span>
          )}

          <span className="wz-identity-spacer" />

          {/* 有错也照存：名片可以只写一半，错误只列出来提示，不挡保存。
              只有「保存中」会挡住按钮：防重复提交。没有 id 时点保存会说明
              原因，因为 id 决定写到哪个目录，不是能力门槛。 */}
          {/* 填表 / JSON 的切换挂在保存按钮左边：它是整栏视图的开关，
              属于这一行的页面级动作，不该在表单上方另起一行。 */}
          {viewSwitch}
          <button className="btn btn-sm btn-primary" type="button"
            disabled={saving}
            onClick={() => {
              if (hasErrors) setTriedSave(true)
              if (!manifest || !manifest.id) {
                setLocalErr(t('Give this card an id first; it decides where the file is written.',
                  '先给名片一个 id：它决定文件写到哪个目录。'))
                return
              }
              setLocalErr(null)
              save()
            }}>
            {saving ? t('Saving…', '保存中…') : t('Save', '保存')}
          </button>
        </div>

        {localErr && (
          <div className="msg msg-danger" style={{ marginTop: 'var(--sp-8)' }}>{localErr}</div>
        )}

        {/* 有硬错也照样保存：这里只说明它们会挡住第 5 步，不是保存门槛。 */}
        {triedSave && hasErrors && (
          <div className="msg msg-danger" style={{ marginTop: 'var(--sp-8)' }}>
            <strong>{t(`${diag.summary.errors} problem(s) do not block saving; under the current declaration the matching call path is missing arguments:`,
              `还有 ${diag.summary.errors} 处问题，不影响保存；按当前声明，对应的调用路径会缺参数：`)}</strong>
            {(diag.diagnostics || []).filter((d) => d.level === 'error').slice(0, 5).map((d, i) => {
              const where = d.section || d.field || (d.index !== undefined ? `parameters[${d.index}]` : '')
              return (
                <div key={i}>
                  {where ? <code>{where}</code> : null}{where ? ' — ' : ''}{d.message}
                </div>
              )
            })}
          </div>
        )}

        {result && (
          <div className={`msg ${result.ok ? 'msg-info' : 'msg-danger'}`}>
            {result.ok
              ? <>
                  {result.replaced ? t('Overwrote', '已覆盖') : t('Saved', '已保存')}
                  {' · '}<code>{result.path}</code>
                  {/* 覆盖是允许的，但要说清旧版还在哪：出问题时人得知道去哪儿捞。 */}
                  {result.backup && (
                    <> · {t('previous version kept as ', '旧版另存为 ')}
                      <code>{String(result.backup).split(/[\\/]/).pop()}</code></>
                  )}
                </>
              : <><b>{t('Not saved', '未保存')}</b> · {result.error}</>}
          </div>
        )}
      </div>
    </div>
  )
}
