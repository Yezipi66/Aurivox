// 第 4 步「推理入口」：既能从候选清单里选，也能直接输入模块名或脚本路径。
//
// 自动识别给不出结论时，入口不能只留一个空白格子让人回忆模块名。
// 清单由 discover 回传，覆盖这台引擎的全部 Python 源文件，按证据强度排序；
// 平台只提供选项，选中哪一个由使用者决定。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { displayEntry, writeEntry } from './entryChoiceField'

export default function EntryChoice ({ manifest, onChange, candidates = [] }) {
  const { t } = useT()
  const opts = Array.isArray(candidates) ? candidates : []
  const value = displayEntry(manifest, opts)
  const engineId = (manifest && manifest.id) || ''
  const listId = 'wizard-entry-candidates'
  const recommended = opts.find((c) => c && c.recommended)
  const pickable = opts.filter((c) => c && (c.file || c.module))

  return (
    <div className="section">
      <div className="section-hdr">
        <h2>{t('Inference entry', '推理入口')}</h2>
        <span className="badge badge-accent">call.argv</span>
        {pickable.length > 0 && (
          <span className="field-hint"
            style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
            {t('Python files found: ', '已发现的 Python 文件：')}{pickable.length}
          </span>
        )}
      </div>
      <div className="section-body">
        {/* 原生 datalist：同一个控件既能从清单里选，也能直接输入，不需要另做一个下拉。 */}
        <input className="control" list={listId} value={value}
          aria-label={t('Inference entry', '推理入口')}
          placeholder={t('Select a file, or type a module name / script path',
            '从清单选择，或输入模块名 / 脚本路径')}
          onChange={(e) => onChange((cur) => writeEntry(cur, e.target.value, opts, engineId))} />
        <datalist id={listId}>
          {pickable.map((c) => (
            <option key={c.file || c.module} value={c.file || c.module}>
              {[c.module, c.recommended ? t('suggested by scan', '扫描建议') : ''].filter(Boolean).join(' · ')}
            </option>
          ))}
        </datalist>
        <div className="field-hint">
          {recommended
            ? t('Suggested: ', '扫描建议：') + (recommended.file || recommended.module) + '。' +
              t('The list contains every Python source file; a selection is written as a -m module or a script path.',
                '清单列出全部 Python 源文件；选中后按 -m 模块名或脚本路径写入。')
            : (pickable.length
              ? t('Recognition gave no conclusion. Pick an entry from the list, or type a module name / script path.',
                '识别未给出结论。请从清单中选一个入口，或直接输入模块名 / 脚本路径。')
              : t('No Python source files were found. A module name or a script path can be entered directly.',
                '没有发现 Python 源文件。可直接输入模块名或脚本路径。'))}
        </div>
      </div>
    </div>
  )
}
