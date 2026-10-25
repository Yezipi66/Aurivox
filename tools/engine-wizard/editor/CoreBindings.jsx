import React from 'react'
import { useT } from '../../../web/src/lib/i18n'

// 核心输入：平台三个输入对应引擎哪个参数。
//
// 不再单独成一个「核心映射」区：这三格本来就是必填的（缺一格引擎接不上平台），
//   和必填 8 项是同一件事，现在由 RequiredFields 合在「必填字段」里，本组件 bare 渲染。
// 每一格也是拖拽落点：从左栏把参数拖到某一格上，就绑到那一格。
//
// 平台固定需要三个输入：合成文本、参考音频、输出。每个对应引擎的一个参数。
// 控件是 combobox（input + datalist）：
//   · 扫描猜中了 → 绿框 + 「扫描已匹配」徽标，值已写进 call.bind
//   · 没猜中     → 黄框 + 「未匹配，需指定」徽标，从候选挑或手填，确认才写
//   · 没扫描过   → 普通输入框，直接手填
//
// 数据：value = manifest.call.bind[槽位]
//       candidates = 当前子命令的 flag 列表（区 3 扫描结果，来自 onAutoFilled）
//       matched = 扫描认出的 flag（{text, ref_audio, output_path}，null=没认出）

const SLOTS = [
  { key: 'text', labelEn: 'Text to synthesize', labelZh: '合成文本' },
  { key: 'ref_audio', labelEn: 'Reference audio', labelZh: '参考音频' },
  { key: 'output_path', labelEn: 'Output path', labelZh: '输出' },
]

export default function CoreBindings ({ call, onChange, candidates, matched, scanned, bare = false }) {
  const { t } = useT()
  const [overSlot, setOverSlot] = React.useState(null)

  // 拖到某一格上：绑这一格。cli 形态写开关本身（--text），python 写参数名。
  const dropOn = (key) => (e) => {
    e.preventDefault()
    setOverSlot(null)
    let param
    try { param = JSON.parse(e.dataTransfer.getData('text/plain') || 'null') } catch { return }
    if (param && param.target) setSlot(key, param.target)
  }
  const bind = call && call.bind || {}
  const listId = 'core-bind-flaglist'

  const setSlot = (key, value) => {
    const nextBind = { ...bind }
    if (value === '') delete nextBind[key]
    else nextBind[key] = value
    onChange({ ...(call || {}), bind: nextBind })
  }

  const body = (
      <div>
        <p className="field-hint" style={{ marginTop: 0 }}>
          {t('The platform passes three inputs to every engine. Drag a scanned parameter onto each, or type its name.',
            '平台会把这三个输入交给每台引擎。把左栏的参数拖到对应一格，或直接填参数名。')}
        </p>

        {SLOTS.map((slot) => {
          const val = bind[slot.key] || ''
          const guessed = matched && matched[slot.key] || null
          const isMatched = !!guessed
          const isScanned = scanned && !guessed
          return (
            <div className="field" key={slot.key} style={{ marginBottom: 12 }}>
              <label className="field-label">
                {t(slot.labelEn, slot.labelZh)}
                <span className="badge badge-accent" style={{ marginLeft: 6 }}>{slot.key}</span>
              </label>
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
              {isScanned && (
                <div className="field-hint">
                  {t('No engine parameter was recognized for this input. Pick from the candidates or type a parameter name.',
                    '引擎参数中未识别出此输入。从候选中选择，或直接填写参数名。')}
                </div>
              )}
            </div>
          )
        })}

        {candidates && candidates.length > 0 && (
          <datalist id={listId}>
            {candidates.map((a) => <option key={a.target} value={a.target}>{a.help || ''}</option>)}
          </datalist>
        )}
      </div>
  )
  if (bare) return body
  return (
    <div className="section">
      <div className="section-hdr"><h2>{t('Core inputs', '核心输入')}</h2></div>
      <div className="section-body">{body}</div>
    </div>
  )
}
