// 「推理入口」那一格：既能从候选清单里选，也能直接输入模块名或脚本路径。
//
// 它是必填格：没有入口这台引擎跑不起来，所以排在「必填字段」区的最上面，
//   版式与同区其它格一致（标签 + 键名徽标 + 输入框 + 说明），不另起一段。
// 自动识别给不出结论、或结论不适用时，也不能只留一个空白格子让人回忆模块名：
//   清单由 discover 回传，覆盖这台引擎的全部 Python 源文件，按证据分档；
//   平台只提供选项，选中哪一个由使用者决定。
// 原生 datalist 需要点开输入框才看得到，界面上容易被当成一个普通输入框，
//   因此另给一个常显的下拉框。两者都写同一个字段，值只有一份。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { displayEntry, writeEntry, readSubcommand, writeSubcommand, writePythonEntry } from './entryChoiceField'

function pyEntryKey (o) {
  if (!o || !o.module || !o.className || !o.method) return ''
  return `${o.module}|${o.className}|${o.method}`
}

// 分档只用于分组与排序，不删项：识别结论错了的时候，人要能在清单里另挑一个。
// 后端已经给出 tier；旧的候选对象没有这个字段时按现有证据推一档，便于测试与旧数据。
const TIER_LABELS = {
  recommended: ['Suggested by scan', '扫描建议'],
  declared: ['Named in package declarations or README', '打包声明或 README 点名'],
  cli: ['Command line switches found', '扫到命令行开关'],
  source: ['Other Python source files', '其它 Python 源文件'],
  aux: ['Auxiliary scripts (demo / training / data)', '辅助脚本（演示 / 训练 / 数据准备）'],
}
const TIER_KEYS = Object.keys(TIER_LABELS)

function tierOf (c) {
  if (!c) return 'source'
  if (TIER_KEYS.includes(c.tier)) return c.tier
  if (c.recommended) return 'recommended'
  if (c.source === 'declared') return 'declared'
  if (c.aux) return 'aux'
  return c.score > 0 ? 'cli' : 'source'
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
  // 清单里只有模块名、没有文件时，下拉的值要用那一项的模块名；
  //   手填的值不在清单里则落回「未指定」，不假装选中了某一项。
  const chosen = pickable.find((c) => c.file === value || c.module === value)
  const selectValue = chosen ? (chosen.file || chosen.module) : ''
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
      {pickable.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          <label className="field-label" style={{ margin: 0 }}
            title={t('The list covers every Python source file found on disk. Picking one rewrites the launch module; the input above still accepts a typed value.',
              '清单列出盘上找到的全部 Python 源文件。选中后会重写启动模块；上面的输入框仍可直接填写。')}>
            {t('Pick from scanned files', '从扫描到的文件里选')}
          </label>
          <select className="control" style={{ maxWidth: 460 }}
            aria-label={t('Pick from scanned files', '从扫描到的文件里选')}
            value={selectValue}
            onChange={(e) => onChange((cur) => writeEntry(cur, e.target.value, opts, engineId))}>
            <option value="">{value
              ? t('Current value is typed in: ' + value, '当前是手填值：' + value)
              : t('not set, choose from the list', '未指定，从清单里选')}</option>
            {TIER_KEYS.map((k) => {
              const items = pickable.filter((c) => tierOf(c) === k)
              if (!items.length) return null
              return (
                <optgroup key={k} label={t(TIER_LABELS[k][0], TIER_LABELS[k][1])}>
                  {items.map((c) => (
                    <option key={c.file || c.module} value={c.file || c.module}>
                      {c.file || c.module}
                    </option>
                  ))}
                </optgroup>
              )
            })}
          </select>
        </div>
      )}
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
              '清单列出全部 Python 源文件；选中后按 -m 模块名或脚本路径写入。') +
            t('The suggestion may not apply; pick another file from the list below if the engine fails to start.',
              '推荐不一定适用；若引擎无法启动，可从下面的清单里另选。')
          : (pickable.length
            ? t('Recognition gave no conclusion. Pick an entry from the list, or type a module name / script path.',
              '识别未给出结论。请从清单中选一个入口，或直接输入模块名 / 脚本路径。')
            : t('Not scanned, or no Python source files were found. A module name or a script path can be entered directly.',
              '未扫描，或没有发现 Python 源文件。可直接输入模块名或脚本路径。'))}
      </div>
    </div>
  )
}
