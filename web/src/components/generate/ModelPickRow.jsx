// ModelPickRow.jsx — 生成页的模型选择行
//
// 从 GenerateTab.jsx 搬出：音色 + 各模型位的下拉，摆在同一紧凑行里。
// 下拉有几个、每个下拉里装什么，全部由名片决定：
// 名片没写模型位就一个下拉都不长（不是长两个），位名也不在这里写死。
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
          {/* 下拉有几个，是这台引擎的名片说的，这里一个引擎名字都
              不许出现。名片没写模型位 ⇒ 一个下拉都不长（不是长两个）。
              每个下拉里按角色分组，底模那一组由候选计算排在最前。 */}
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
        {/* 这句话以前写的是「在这里切换不会生效」，那是实话，但它
            描述的是一个 bug，不是一个特性：能点、点完什么都不发生的下拉，
            比不给选更糟。现在平台会带着选中的那一份把引擎重开一次，所以
            它真的生效了，代价是要等。⇒ 这里改成说清那个代价。
            别退回旧文案：那等于把已经修好的功能重新说成坏的。 */}
        {relaunchHint && (
          <div className="field-hint" style={{ marginTop: 4 }}>
            {t('Changing the model above restarts this engine with it — the first generation after a change takes longer while the model loads.',
               '在上面换模型会让这台引擎带着它重新启动一次，换过之后的第一次生成需要更长时间，等它把模型装进内存。')}
          </div>
        )}
        {/* 盘上放了模型、下拉却是空的，而且没有一个字解释
            为什么，「这个角色没有模型」「放错了一层」「目录名不是权重位名」
            三件事在界面上长得一模一样。静默是这个仓库最难查的一种坏法。
            这里不加指示灯（顶栏那笔账刚清过）：话说在它出问题的
               那个下拉旁边，看完就没用了，不该占一个常驻格子。
            前端不判断也不拼话：整句是后端生成的，它才知道名片写了什么。 */}
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
