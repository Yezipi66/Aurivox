// 「推理入口」那一格：既能从候选清单里选，也能直接输入模块名或脚本路径。
//
// 它是必填格：没有入口这台引擎跑不起来，所以排在「必填字段」区的最上面，
//   版式与同区其它格一致（标签 + 键名徽标 + 输入框 + 说明），不另起一段。
// 自动识别给不出结论时也不能只留一个空白格子让人回忆模块名：
//   清单由 discover 回传，覆盖这台引擎的全部 Python 源文件，按证据强度排序；
//   平台只提供选项，选中哪一个由使用者决定。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { displayEntry, writeEntry, readSubcommand, writeSubcommand, writePythonEntry } from './entryChoiceField'

function pyEntryKey (o) {
  if (!o || !o.module || !o.className || !o.method) return ''
  return `${o.module}|${o.className}|${o.method}`
}

export default function EntryChoice ({ manifest, onChange, candidates = [], confidence = null, pythonEntries = [] }) {
  const { t } = useT()
  const opts = Array.isArray(candidates) ? candidates : []
  const value = displayEntry(manifest, opts)
  const engineId = (manifest && manifest.id) || ''
  const listId = 'wizard-entry-candidates'
  const recommended = opts.find((c) => c && c.recommended)
  const pickable = opts.filter((c) => c && (c.file || c.module))
  // 推荐入口同样分档：证据来自打包声明或 README 且强度最高才算确定。
  //   识别没给出结论（无 recommended）时不挂徽标，下面的提示已经说明要人自己选。
  const entryEvidence = recommended && confidence && confidence.entry
  // 形态以名片为准；没写 kind 时按有没有 argv 判，与宿主默认（python）一致。
  const call = (manifest && manifest.call) || {}
  const kind = call.kind || (Array.isArray(call.argv) && call.argv.length ? 'cli' : 'python')
  // 入口挂多个子命令时，由人挑一个。候选里带着这个入口的子命令表（扫描按 help 分组得到）；
  //   选中的词写进命令行，位置固定在模块名或脚本路径之后。
  const picked = opts.find((c) => c && (c.file === value || c.module === value)) || recommended || null
  const groups = picked && Array.isArray(picked.groups) ? picked.groups.filter(Boolean) : []
  const sub = readSubcommand(manifest)
  const pyOpts = Array.isArray(pythonEntries) ? pythonEntries : []
  const pyKey = pyEntryKey({
    module: call.module, className: call.class, method: call.method,
  })

  return (
    <div className={`field${value ? '' : ' wz-unset'}`} style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <label className="field-label" style={{ margin: 0 }}
          title={t('The module or script the host runs. An engine without an entry cannot be started.',
            '宿主运行的那个模块或脚本。没有入口，这台引擎起不来。')}>
          {t('Inference entry', '推理入口')}
        </label>
        <span className="badge badge-accent">{kind === 'python' ? 'call.module' : 'call.argv'}</span>
        {entryEvidence && (
          <span className={`badge ${entryEvidence.level === 'certain' ? 'badge-ok' : 'badge-warn'}`}
            title={t(entryEvidence.reason.en, entryEvidence.reason.zh)}>
            {entryEvidence.level === 'certain'
              ? t('entry confirmed', '入口已确定')
              : t('entry inferred', '入口为推测')}
          </span>
        )}
        {!value && (
          <span className="badge badge-warn">{t('not set, specify', '未指定')}</span>
        )}
      </div>
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
      {kind === 'python' && pyOpts.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          <label className="field-label" style={{ margin: 0 }}
            title={t('Classes found by a static scan of the source. Selecting one writes module, class and method into the manifest; a rescan then reflects its parameters.',
              '静态扫描源码找到的类。选中后把模块、类、方法一起写进名片，重新扫描即可反射出它的参数。')}>
            {t('Python entry', 'Python 入口')}
          </label>
          <select className="control" style={{ maxWidth: 420 }}
            value={pyOpts.some((o) => pyEntryKey(o) === pyKey) ? pyKey : ''}
            onChange={(e) => onChange((cur) => writePythonEntry(
              cur, pyOpts.find((o) => pyEntryKey(o) === e.target.value), engineId))}>
            <option value="">{t('not specified', '未指定')}</option>
            {pyOpts.map((o) => (
              <option key={pyEntryKey(o)} value={pyEntryKey(o)}>
                {`${o.module}.${o.className}.${o.method}`}
              </option>
            ))}
          </select>
        </div>
      )}
      {kind === 'cli' && groups.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
          <label className="field-label" style={{ margin: 0 }}
            title={t('This entry has several subcommands. The chosen one is written into the command line right after the module name.',
              '该入口有多个子命令。选中的那个会写进命令行，位置在模块名之后。')}>
            {t('Subcommand', '子命令')}
          </label>
          <select className="control" style={{ maxWidth: 220 }}
            value={groups.includes(sub) ? sub : ''}
            onChange={(e) => onChange((cur) => writeSubcommand(cur, e.target.value))}>
            <option value="">{t('not specified', '未指定')}</option>
            {groups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
          <span className="field-hint" style={{ margin: 0 }}>
            {t('Found ' + groups.length + ' subcommands on this entry.', '该入口有 ' + groups.length + ' 个子命令。')}
          </span>
        </div>
      )}
      <div className="field-hint">
        {recommended
          ? t('Suggested: ', '扫描建议：') + (recommended.file || recommended.module) + '。' +
            t('The list contains every Python source file; a selection is written as a -m module or a script path.',
              '清单列出全部 Python 源文件；选中后按 -m 模块名或脚本路径写入。')
          : (pickable.length
            ? t('Recognition gave no conclusion. Pick an entry from the list, or type a module name / script path.',
              '识别未给出结论。请从清单中选一个入口，或直接输入模块名 / 脚本路径。')
            : t('Not scanned, or no Python source files were found. A module name or a script path can be entered directly.',
              '未扫描，或没有发现 Python 源文件。可直接输入模块名或脚本路径。'))}
      </div>
    </div>
  )
}
