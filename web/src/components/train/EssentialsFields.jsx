// EssentialsFields.jsx — 训练页三要素
//
// 显示名称、语言、音频文件夹路径。
// 显示名称带两个派生信息：服务器分配的 id 建议（创建时才最终确定）、
// 以及同名音色提醒（同名不会覆盖，会新建一个独立音色）。
import { Select } from '../common/Select'
import { useT } from '../../lib/i18n'
import { LANGUAGES } from './trainConstants'

export function EssentialsFields({ form, setField, proposedId, dupDisplay }) {
  const { t: tr } = useT()
  const displayName = (form.voiceName || '').trim()

  return (
    <div className="essentials-grid">
      <div className="field">
        <label className="field-label">{tr('Display Name', '显示名称')} *</label>
        <input className="control" value={form.voiceName} onChange={e => setField('voiceName', e.target.value)} placeholder={tr('e.g. MyVoice', '例如：MyVoice')} />
        {displayName && (
          <p className="field-hint">
            {tr('Proposed ID:', '建议 ID：')} <code>{proposedId || '…'}</code>
            <span className="field-note"> {tr('(finalized at creation — may differ)', '（在创建时最终确定，可能与此不同）')}</span>
            {dupDisplay.length > 0 && (
              <><br/><span className="pf-warn">{tr(
                `ⓘ ${dupDisplay.length} existing voice${dupDisplay.length > 1 ? 's' : ''} already use this display name (id${dupDisplay.length > 1 ? 's' : ''}: ${dupDisplay.map(v => v.id).join(', ')}). A new distinct voice will be created.`,
                `ⓘ 已有 ${dupDisplay.length} 个音色在使用该显示名称（id：${dupDisplay.map(v => v.id).join(', ')}）。将创建一个新的、独立的音色。`)}</span></>
            )}
          </p>
        )}
      </div>
      <div className="field">
        <label className="field-label">{tr('Language', '语言')} *</label>
        <Select className="control" value={form.language} onChange={e => setField('language', e.target.value)}>
          {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
        </Select>
      </div>
      <div className="field">
        <label className="field-label">{tr('Audio Folder Path', '音频文件夹路径')} *</label>
        <input className="control" value={form.inputDir} onChange={e => setField('inputDir', e.target.value)} placeholder={tr('e.g. D:\\raw_audio\\MyVoice', '例如：D:\\raw_audio\\MyVoice')} />
        <p className="field-hint">{tr('ⓘ Folder path only — point to a folder of audio files. If you have a single audio file, put it inside a folder first, then select that folder.',
          'ⓘ 仅填文件夹路径：指向一个存放音频文件的文件夹。如果只有单个音频文件，请先把它放进一个文件夹，再选择该文件夹。')}</p>
      </div>
    </div>
  )
}
