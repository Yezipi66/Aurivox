// TrainingPresetPicker.jsx — 训练预设选择
//
// 从 TrainingTab.jsx 搬出：内置预设 + 用户自存快照的选择器。
// 预设只是往 form.* 里填值（纯前端），不落服务端。
// 自存预设可以「另存为新预设 / 更新 / 删除」。
import { Select } from '../common/Select'
import { useT } from '../../lib/i18n'
import { TRAIN_PRESETS } from './trainConstants'

export function TrainingPresetPicker({ form, applyPreset, onSaveAsNew, onUpdate, onDelete }) {
  const { t: tr } = useT()

  const curTP = form.preset || 'default'
  const isSavedTP = curTP.startsWith('saved:')
  const savedTPName = isSavedTP ? curTP.slice(6) : null
  const savedTP = (form.trainSavedPresets || [])
  const canSnapshot = curTP === 'custom' || isSavedTP

  return (
    <div className="preset-grid preset-grid-single">
      <div className="field">
        <label className="field-label">{tr('Training Preset', '训练预设')}</label>
        <Select className="control" value={curTP} onChange={e => applyPreset(e.target.value)}>
          {TRAIN_PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          {savedTP.length > 0 && (
            <optgroup label={tr('Saved presets', '已保存预设')}>
              {savedTP.map(s => <option key={`saved:${s.name}`} value={`saved:${s.name}`}>{tr('Saved', '已保存')}: {s.name}</option>)}
            </optgroup>
          )}
        </Select>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          {canSnapshot && (
            <button type="button" className="btn btn-sm" onClick={onSaveAsNew}>
              {isSavedTP ? tr('Save as new preset', '另存为新预设') : tr('Save as preset', '保存为预设')}
            </button>
          )}
          {isSavedTP && (
            <button type="button" className="btn btn-sm btn-primary" onClick={onUpdate}>{tr('Update preset', '更新预设')}</button>
          )}
          {isSavedTP && (
            <button type="button" className="btn btn-sm btn-danger" onClick={onDelete}>{tr('Delete preset', '删除预设')}</button>
          )}
        </div>
        <p className="field-hint">{isSavedTP
          ? tr(`Saved preset “${savedTPName}”. Edit any parameter below, then Update to save your changes back to it.`,
            `已保存预设“${savedTPName}”。可在下方修改任意参数，然后点“更新预设”把改动写回该预设。`)
          : (() => {
            const p = TRAIN_PRESETS.find(p => p.key === curTP) || {}
            return tr(p.hint, p.hintZh)
          })()}</p>
        <p className="field-note">{tr('S1 adapts semantic rhythm and prosody and may overfit earlier on small datasets. S2 receives more training epochs for acoustic and timbre adaptation.',
          'S1 学习语义层面的节奏与韵律，在小数据集上更容易过拟合。S2 使用更多训练 epoch 来适配音质与音色。')}</p>
        <p className="field-note">{tr('More training does not always produce better results. Keep earlier checkpoints and compare them before choosing a model.',
          '训练更久不一定效果更好。请保留较早的 checkpoint，先对比再决定用哪个模型。')}</p>
      </div>
    </div>
  )
}
