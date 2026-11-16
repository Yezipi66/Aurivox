// 「推理入口」那一格：一个输入框，既能直接打字，也能从扫到的文件里选。
//
// 它是必填格：没有入口这台引擎跑不起来，所以排在「必填字段」区的最上面，
//   版式与同区其它格一致（标签 + 键名徽标 + 输入框 + 说明），不另起一段。
// 自动识别给不出结论、或结论不适用时，也不能只留一个空白格子让人回忆模块名：
//   候选清单由 discover 回传，覆盖这台引擎的全部 Python 源文件，按证据分档；
//   平台只提供选项，选中哪一个由使用者决定。
//
// 控件用项目统一下拉的那一套（web/src/components/common/Select.jsx），开 editable：
//   外观与其它下拉同框同箭头，值可以直接打字，清单是它的候选。
//   一个值只给一个控件，不另造「输入框 + 按钮 + 面板」。
//   输入框显示的是文件路径（人能对着扫描结果核对），写进名片的是模块名。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import Select from '../../../web/src/components/common/Select'
import { entryText, writeEntry, readSubcommand, writeSubcommand, writePythonEntry } from './entryChoiceField'

function pyEntryKey (o) {
  if (!o || !o.module || !o.className || !o.method) return ''
  return `${o.module}|${o.className}|${o.method}`
}

// 分档只用于排序与标记，不删项：识别结论错了的时候，人要能在清单里另挑一个。
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
  const value = entryText(manifest)
  const engineId = (manifest && manifest.id) || ''
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
  // 当前值命中的那一条候选。推荐是筛选结论，不能当作命中依据。
  const hit = opts.find((c) => c && (c.file === value || c.module === value)) || null
  const isScript = /\.py$/i.test(value)
  const sub = readSubcommand(manifest)
  const pyOpts = Array.isArray(pythonEntries) ? pythonEntries : []
  const pyKey = pyEntryKey({
    module: call.module, className: call.class, method: call.method,
  })

  const [typing, setTyping] = React.useState(null)
  const shown = typing !== null ? typing : (hit ? (hit.file || hit.module) : value)

  // 清单按证据分档排序：推荐在最前，辅助脚本在最后。
  const ordered = TIER_KEYS
    .map((tier) => ({ tier, items: pickable.filter((c) => tierOf(c) === tier) }))
    .filter((g) => g.items.length)
    .flatMap((g) => g.items)

  // 清单里的一行：文件路径 + 它是什么。菜单是页面内的普通 DOM，
  //   不像原生 datalist 那样只留一处主文字，所以身份可以直接写在行里。
  const optionLabel = (c) => {
    const base = c.file || c.module
    const tier = tierOf(c)
    if (tier === 'recommended') return base + t(' (suggested)', '（扫描建议）')
    if (tier === 'aux') return base + t(' (auxiliary script)', '（辅助脚本）')
    if (!c.file) return base + t(' (module name from package declarations)', '（打包声明里的模块名）')
    return base
  }

  // 选完或打完说清「这一项在命令行上写成什么」：文件路径与 -m 模块名不是同一个词，
  //   光看输入框里那个路径核不出命令会长成什么样。辅助脚本另给一句提醒：
  //   演示、训练、数据准备脚本也收参数，运行结果通常不是合成音频。
  const wrote = hit
    ? (tierOf(hit) === 'aux'
      ? t('Auxiliary script (demo / training / data preparation); it may not synthesise audio.',
        '这是辅助脚本（演示 / 训练 / 数据准备），可能不是合成入口。') + ' '
      : '') +
      (hit.module
        ? t('Written into the command line as -m ' + hit.module,
          '写进命令行的是 -m ' + hit.module)
        : t('Run as the script at this path.', '按这个路径当脚本运行。'))
    : (isScript
      ? t('Run as the script at this path.', '按这个路径当脚本运行。')
      : t('Not in the scan result; passed to the engine as a module name.',
        '不在扫描结果里，按模块名原样交给引擎。'))

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
      {/* 一个控件装住这个值：外观是项目下拉的那一套，值可以直接打字。
          编辑中按原样显示：名片里存模块名、显示出文件路径，两者不是同一个词，
          收不住这份原样文字的话，打到一半命中候选会被换成整条路径，光标跟着跳走。 */}
      <Select editable value={shown}
        title={value || undefined}
        placeholder={t('A module name or a script path, e.g. pkg.cli',
          '模块名或脚本路径，如 pkg.cli')}
        onChange={(e) => {
          const next = e.target.value
          setTyping(next)
          onChange((cur) => writeEntry(cur, next, opts, engineId))
        }}
        inputProps={{
          'aria-label': t('Inference entry', '推理入口'),
          onBlur: () => setTyping(null),
        }}>
        {ordered.map((c) => (
          <option key={c.file || c.module} value={c.file || c.module}>{optionLabel(c)}</option>
        ))}
      </Select>
      {value && <div className="field-hint">{wrote}</div>}
      {kind === 'python' && pyOpts.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          <label className="field-label" style={{ margin: 0 }}
            title={t('Classes found by a static scan of the source. Selecting one writes module, class and method into the manifest; a rescan then reflects its parameters.',
              '静态扫描源码找到的类。选中后把模块、类、方法一起写进名片，重新扫描即可反射出它的参数。')}>
            {t('Python entry', 'Python 入口')}
          </label>
          <Select className="control" style={{ maxWidth: 420 }}
            aria-label={t('Python entry', 'Python 入口')}
            value={pyOpts.some((o) => pyEntryKey(o) === pyKey) ? pyKey : ''}
            onChange={(e) => onChange((cur) => writePythonEntry(
              cur, pyOpts.find((o) => pyEntryKey(o) === e.target.value), engineId))}>
            <option value="">{t('not specified', '未指定')}</option>
            {pyOpts.map((o) => (
              <option key={pyEntryKey(o)} value={pyEntryKey(o)}>
                {`${o.module}.${o.className}.${o.method}`}
              </option>
            ))}
          </Select>
        </div>
      )}
      {kind === 'cli' && groups.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
          <label className="field-label" style={{ margin: 0 }}
            title={t('This entry has several subcommands. The chosen one is written into the command line right after the module name.',
              '该入口有多个子命令。选中的那个会写进命令行，位置在模块名之后。')}>
            {t('Subcommand', '子命令')}
          </label>
          <Select className="control" style={{ maxWidth: 220 }}
            aria-label={t('Subcommand', '子命令')}
            value={groups.includes(sub) ? sub : ''}
            onChange={(e) => onChange((cur) => writeSubcommand(cur, e.target.value))}>
            <option value="">{t('not specified', '未指定')}</option>
            {groups.map((g) => <option key={g} value={g}>{g}</option>)}
          </Select>
          <span className="field-hint" style={{ margin: 0 }}>
            {t('Found ' + groups.length + ' subcommands on this entry.', '该入口有 ' + groups.length + ' 个子命令。')}
          </span>
        </div>
      )}
      <div className="field-hint">
        {recommended
          ? t('Suggested: ', '扫描建议：') + (recommended.file || recommended.module) + '。' +
            t('The arrow on the right of the field (or the ↓ key) lists every Python source file; a selection is written as a -m module or a script path.',
              '输入框右侧的箭头（或按 ↓）可展开全部 Python 源文件；选中后按 -m 模块名或脚本路径写入。') +
            t(' The suggestion may not apply; pick another file from the list, or type a value directly, if the engine fails to start.',
              '推荐不一定适用；若引擎无法启动，可在清单里另选，或直接改上面的值。')
          : (pickable.length
            ? t('Recognition gave no conclusion. The arrow on the right of the field lists every candidate; a value that is not in the list can also be typed directly.',
              '识别未给出结论。输入框右侧的箭头可展开全部候选；不在其中的也能直接打进去。')
            // 名片里已写了入口、这次还没扫描：清单为空是「没扫」，不是「没找到源文件」。
            //   两者说法必须分开，否则对着一条能跑的命令说「没有 Python 源文件」。
            : (value
              ? t('No list yet: this engine has not been scanned. The entry stays as ' + value +
                ' from the manifest; scanning lists every Python source file and its parameters.',
                '清单待扫描：这台引擎这次还没有扫描。入口沿用名片里的 ' + value +
                '；扫描后可列出全部 Python 源文件与参数。')
              : t('Not scanned, or no Python source files were found. A module name or a script path can be typed above.',
                '未扫描，或没有发现 Python 源文件。可在上面直接输入模块名或脚本路径。')))}</div>
    </div>
  )
}
