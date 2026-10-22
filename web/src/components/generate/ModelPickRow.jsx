// 生成页的模型选择行：音色下拉与各模型位的下拉，摆在同一行里。
// 下拉有几个、每个下拉里有哪些候选，全部由引擎名片决定；本组件不写死位名。
// 候选分组、选中项与提示文案都由调用方算好，本组件只负责显示与交互。
import { Select } from '../common/Select'
import { itemLabel } from '../../lib/modelPickers.pure.js'
import { voiceOptionLabel } from './GenerateBits'
import { useT } from '../../lib/i18n'

export function ModelPickRow({
  selectedVoice,
  onSelectVoice,
  voiceOptions,
  weightSlots,
  groupsBySlot,
  selWeights,
  onSelectWeight,
  modelSummary,
  relaunchHint,
  modelNotes,
  incompleteItems,
}) {
  const { t } = useT()

  return (
    <>
      <div className="field">
        <div className="gen-model-row">
          <div className="gen-model-col">
            <label className="field-label">Voice</label>
            <Select className="control" value={selectedVoice} onChange={e => onSelectVoice(e.target.value)}>
              {voiceOptions.map(v => <option key={v.id} value={v.id}>{voiceOptionLabel(v)}</option>)}
              {voiceOptions.length === 0 && <option value="">{t('No voices available', '没有可用的音色')}</option>}
            </Select>
          </div>
          {/* 下拉的数量与内容由这台引擎的名片决定，本文件不写具体引擎名。
              名片没写模型位就不长下拉（不是长两个）。
              每个下拉按角色分组，底模那一组排在最前。 */}
          {weightSlots.map(s => {
            const groups = groupsBySlot[s.name] || []
            if (!groups.length) return null
            return (
              <div className="gen-model-col" key={s.name}>
                <label className="field-label" title={s.help || ''}>{s.label || s.name}</label>
                <Select className="control" value={selWeights[s.name] || ''}
                  onChange={e => onSelectWeight(s.name, e.target.value)}>
                  {groups.map(g => (
                    <optgroup key={g.voiceId} label={g.displayName}>
                      {g.items.map(c => (
                        <option key={c.path} value={c.path}>{itemLabel(c)}</option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              </div>
            )
          })}
        </div>
        {modelSummary && (
          <div className="gen-model-summary" title={modelSummary}>{modelSummary}</div>
        )}
        {/* 换启动时载入的模型位会让这台引擎带着它重启一次，
            换过之后的第一次生成需要等模型载入。 */}
        {relaunchHint && (
          <div className="field-hint" style={{ marginTop: 4 }}>
            {t('Changing the model above restarts this engine with it — the first generation after a change takes longer while the model loads.',
               '在上面换模型会让这台引擎带着它重新启动一次，换过之后的第一次生成需要更长时间，等它把模型装进内存。')}
          </div>
        )}
        {/* 盘上放了模型而下拉是空的时，用一句话说明原因。
            「这个角色没有模型」「放错了一层」「目录名不是权重位名」三件事
            在界面上长得一模一样，静默是最难查的一种坏法。
            提示就放在出问题的那个下拉旁边，不占常驻格子。
            整句由后端生成，前端不判断也不拼话。 */}
        {modelNotes.map((n, i) => (
          <div className="field-hint" key={`${n.engine}-${n.code}-${i}`}
               style={{ marginTop: 4, color: 'var(--warn, #d08700)' }}>
            {n.text}
          </div>
        ))}
        {incompleteItems.map((it, i) => (
          <div className="msg msg-error" key={`missing-${it.path}-${i}`}
               style={{ marginTop: 4 }}
               title={(it.missing || []).join('\n')}>
            {it.missing_text}
          </div>
        ))}
      </div>
    </>
  )
}
