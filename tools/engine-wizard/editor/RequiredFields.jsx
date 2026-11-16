// 必填区：引擎目录、启动脚本、模型权重等。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { launchConventions, withRuntimePatch, withLaunchConventions } from './optionalKeys'
import { readWeights, writeWeights, TOKEN } from './weightsField'
import { readTextVia, withTextVia } from './textEntryField'
import EntryChoice from './EntryChoice'
import Select from '../../../web/src/components/common/Select'

// 必填区：名片里只有这 6 格必须人答（模型权重是 2026-10 补的第 6 格），其余平台推得出或有保守默认
// （lib/engines/profile.js 的 DEFAULTS 与 defaulted）。
//
// 两行，按「值从哪来」分：
//   第 1 行  合成文本 / 参考音频 / 参考文本 / 输出：平台的输入槽位（call.bind），
//            扫描通常认得出，用户确认即可；也是拖拽落点。
//            参考文本是可选格：扫描只能尽量认，认不出时给一句提示、由用户拖进来，不算缺项；
//            格子右侧的清除按钮把它从 bind 里删掉（宿主收到参考文本也不往上游传）。
//   第 2 行  引擎目录 / 启动脚本：按本仓库惯例代填，可改。
//            模型权重：引擎从哪个参数读权重。值默认 {checkpoints}（第 3 步的下载落点），
//            参数名要人指定（可从左栏拖构造参数进来）；引擎自行定位权重就勾下方复选框。
//            名片里写进 call.init_args（cli 形态写进 call.argv），不另起一个键，
//            读写见 weightsField.js，缺没缺由平台 hostProfile.js 的 weightsProblem 判。
// 网格用 auto-fit，中栏被拖窄时自动折成单列，不写死列数。
//
// 每格是「中文人话 + 键名徽标」。槽位格的徽标写槽位名（text / ref_audio / ref_text / output_path），
// 平台固定认这几个词，格子里填的是引擎那边的参数名；第 2 行的徽标写名片键路径。
// 排版用项目已有的类；不写具体引擎名（有守卫测试）。
//
// 填参数名的格子都走项目统一下拉的那一套（web/src/components/common/Select.jsx）开 editable：
//   外观与其它下拉同框同箭头，值可以直接打字，扫描到的参数名是它的候选。
//   同一区里不许再出现第二种「输入框 + 候选」写法（原生 datalist 即为一种）。

// unset：这一格还没有值，也就是这项能力还没声明。整格弱化显示，
//   让人一眼看出哪些还空着；仍然可编辑，点进去就恢复正常。
function Cell ({ label, code, hint, badge, unset, children }) {
  return (
    <div className={`field${unset ? ' wz-unset' : ''}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <label className="field-label" style={{ margin: 0 }}>{label}</label>
        <span className="badge badge-accent">{code}</span>
        {badge}
      </div>
      {/* 说明放在控件下面：放上面时有说明的那格输入框会比同行的矮一截，两格对不齐。 */}
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  )
}

export default function RequiredFields ({ manifest, onChange, autofill, bindSlots,
  entryCandidates, entryConfidence, pythonEntries }) {
  const { t } = useT()
  const runtime = (manifest && manifest.runtime) || {}
  const call = (manifest && manifest.call) || {}
  const bind = call.bind || {}
  // argv 里已写着 {text} / {output_path} 这类占位符的槽位。
  //   同一个槽位在 argv 里有占位符、又在 bind 里给开关，宿主会拒收整张名片
  //   （lib/engines/hostProfile.js 与 validate.js 都拦）。所以这两处是一对互斥的去处：
  //   一个值要么按位置给，要么按开关给。这一区必须认出前者，否则会一直催人填一个
  //   填了就会被拒的格子。
  const argvSlots = new Set()
  for (const word of (Array.isArray(call.argv) ? call.argv : [])) {
    for (const m of String(word).matchAll(/\{(text|ref_audio|ref_text|output_path)\}/g)) {
      argvSlots.add(m[1])
    }
  }
  const matched = (autofill && autofill.matched) || null
  const confidence = (autofill && autofill.confidence) || null
  const candidates = (autofill && autofill.argList) || []
  const scanned = !!autofill
  const id = manifest && manifest.id
  const conv = id ? launchConventions(id) : null

  // 拖到某一格上：绑这一格。cli 形态写开关本身（--text），python 写参数名。
  const [overSlot, setOverSlot] = React.useState(null)
  const dropOn = (key) => (e) => {
    e.preventDefault()
    setOverSlot(null)
    let param
    try { param = JSON.parse(e.dataTransfer.getData('text/plain') || 'null') } catch { return }
    if (param && param.target) setSlot(key, param.target)
  }

  // 写名片一律交函数（基于最新值合并），不交整份对象：
  //   同一次提交里别的自动填（如 ManifestForm 的权重路径）也在写名片，
  //   各自拿渲染时的快照整份写回，后写的会把先写的整段冲掉。
  const setRuntime = (patch) => onChange((cur) => withRuntimePatch(cur, patch))
  // 空格与空串同一个意思：这一格不声明。名片是「能力 + 开关名」的清单，
  //   一个空白开关名既接不上前端控件，也会在命令行上变成一个空白词。
  //   所以先 trim 再判空，空就删掉这个键。
  const setSlot = (key, value) => onChange((cur) => {
    const c = (cur && cur.call) || {}
    const nextBind = { ...(c.bind || {}) }
    const v = String(value == null ? '' : value).trim()
    if (!v) delete nextBind[key]
    else nextBind[key] = v
    return { ...cur, call: { ...c, bind: nextBind } }
  })

  // 输出是文件还是目录：有的引擎收完整文件名，有的只收目录、文件名它自己起。
  //   扫描按落点开关的名字推（见 scanAutofill），这里让人能改。
  //   这是逃生口：名字不可靠（叫 --output 却收目录的引擎确实存在），
  //   推断只是默认值，最终以这里选的为准。
  const setReturns = (value) => onChange((cur) => {
    const c = (cur && cur.call) || {}
    return { ...cur, call: { ...c, returns: value } }
  })

  // 文本走标准输入：有的命令行程序只从 stdin 读正文，压根没有 --text 这类开关。
  //   宿主认 call.text_via="stdin"；它与 bind.text 互斥（见 textEntryField.js）。
  //   勾上时那一格的输入框让位：这一格不再填参数名。
  const textViaStdin = readTextVia(call)
  const setTextVia = (on) => onChange((cur) => {
    const c = (cur && cur.call) || {}
    return { ...cur, call: withTextVia(c, on) }
  })

  // 引擎目录与启动脚本两格都空着 ⇒ 按惯例代填。
  // 只在两格都没写时填：读进来的名片写过任何一格就不动；值可见可改。
  //   依赖里带上两格本身：只盯 id 时，代填一旦被别处冲掉就再也补不回来。
  //   使用者只清空一格不会重填（另一格还在）；两格都清空就按惯例再填回来。
  React.useEffect(() => {
    if (!conv) return
    onChange((cur) => withLaunchConventions(cur, conv))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, runtime.python === undefined && runtime.entry === undefined])

  // 模型权重这一格
  const weights = readWeights(call)
  const isCli = (call.kind || 'python') === 'cli'
  const setWeights = (patch) => onChange((cur) => {
    const c = (cur && cur.call) || {}
    return { ...cur, call: writeWeights(c, { ...readWeights(c), ...patch }) }
  })
  const dropWeights = (e) => {
    e.preventDefault()
    setOverSlot(null)
    let param
    try { param = JSON.parse(e.dataTransfer.getData('text/plain') || 'null') } catch { return }
    if (param && param.target) setWeights({ name: param.target, self: false })
  }

  // 候选清单：扫描认出来的每个参数一行。菜单是页面内的普通 DOM，
  //   参数名与它自己的说明可以摆在同一行；输入框里显示的仍是这一个值本身。
  const candidateOptions = candidates.map((a) => (
    <option key={a.target} value={a.target} title={a.help || undefined}>
      {a.target}
      {a.help ? <span style={{ opacity: 0.6, marginLeft: 8 }}>{a.help}</span> : null}
    </option>
  ))

  // 槽位清单来自 /wizard/spec 的 bindSlots（平台 hostProfile.js 的 BIND_SLOTS 原样），不手抄。
  const SLOT_LABELS = {
    text: { labelEn: 'Text to synthesize', labelZh: '合成文本' },
    ref_audio: { labelEn: 'Reference audio', labelZh: '参考音频' },
    ref_text: { labelEn: 'Reference text', labelZh: '参考文本', optional: true },
    output_path: { labelEn: 'Output', labelZh: '输出' },
  }
  const SLOT_KEYS = (bindSlots && bindSlots.length)
    ? bindSlots
    : Object.keys(SLOT_LABELS)
  // 参考文本的声明（ref_text）不在这一区：它与 seed 平分第一行，收在
  //   「可选能力」区（OptionalCapabilities）里。
  //   同一份 bind 数据只留一个编辑口。SLOT_LABELS 仍留着它的条目：
  //   fallback 清单要逐字等于平台的 BIND_SLOTS，少一项就成了手抄的第二份。
  const slots = SLOT_KEYS.filter((key) => key !== 'ref_text').map((key) => ({
    key,
    labelEn: (SLOT_LABELS[key] || {}).labelEn || key,
    labelZh: (SLOT_LABELS[key] || {}).labelZh || key,
    optional: !!(SLOT_LABELS[key] || {}).optional,
  }))

  // 输出槽位只在「引擎把音频写进文件」时才要（call.returns 缺省就是 file，hostProfile.js 同口径）。
  // 输出槽位只在「引擎收路径」时才要：file 收完整文件名，dir 收一个由引擎自己起名的目录。
  //   只有引擎直接返回音频（bytes / generator）时才不需要这一格。
  const returns = call.returns || 'file'
  const slotNeeded = (key) => key !== 'output_path' || (returns !== 'bytes' && returns !== 'generator')

  // 必填优先展示：还没填上的必填槽位排到最前面。
  //   平台能自动填的（扫描已匹配 / 按惯例代填）已经填上了，剩下的那一格才是真需要人的；
  //   让它排第一，而不是混在已经填好的格子中间被略过。
  //   可选格不参与（空着不算缺项，别把它顶到前面去）。
  const needsHuman = (s) => slotNeeded(s.key) && !s.optional && !bind[s.key]
    && !(s.key === 'text' && textViaStdin) && !argvSlots.has(s.key)
  const orderedSlots = [...slots].sort((a, b) => Number(needsHuman(b)) - Number(needsHuman(a)))

  const defaultedBadge = (v, conventional) => (v && conventional && v === conventional)
    ? <span className="badge badge-muted">{t('prefilled, editable', '平台代填，可改')}</span>
    : null

  // 这两格也是扫描按名字推的。只在值仍是推断值时挂推测徽标：人改过就不该继续说它是推测。
  const returnsInferred = !!(confidence && confidence.returns && returns === confidence.returns.value)
  const weightsInferred = !!(confidence && confidence.weights && !weights.self &&
    weights.name && weights.name === confidence.weights.flag)

  return (
    <div className="section">
      <div className="section-hdr">
        <h2>{t('Required fields', '必填字段')}</h2>
        {/* 栏头是 uppercase，这句要按正常大小写排，所以单独把 textTransform 关掉。
            它说的是这一区真正的规矩：留空不是「还没填」，是「这台引擎没有这项能力」。 */}
        <span className="field-hint"
          style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0,
            fontWeight: 400, textAlign: 'right' }}>
          {t('Most zero-shot TTS engines need the inputs below. A field left blank means the engine does not have that capability: no control is created for it, and the parameter is never sent. Such a field is shown in grey in this wizard.',
            '多数零样本 TTS 引擎都需要下列输入。某项留空即表示这台引擎不具备该能力：平台不为其生成控件，也不下发该参数，该项在本向导内以灰色显示。')}
        </span>
      </div>
      <div className="section-body">
        {/* 推理入口排在最前：它也是必填，缺了这台引擎起不来。
            版式跟同区其它格一样（标签 + 键名徽标 + 输入框 + 说明），不再单占一段。 */}
        <EntryChoice manifest={manifest || {}} onChange={onChange}
          candidates={entryCandidates || []} confidence={entryConfidence || null}
          pythonEntries={pythonEntries || []} />

        <div className="form-grid wz-required-row">
          {orderedSlots.map((slot) => {
            const val = bind[slot.key] || ''
            const guessed = matched && matched[slot.key] || null
            // 文本走标准输入：这一格已经有答案（不是参数名），也不算缺项。
            const viaStdin = slot.key === 'text' && textViaStdin
            // 这一格的值已经在命令行词序那边按位置给了。此处只作说明，不再收一份。
            const viaArgv = argvSlots.has(slot.key)
            // 自动填的值分两档：规范同名、证据落在入口文件里且没有竞争候选才算确定。
            //   拿不到 confidence 时按推测处理：不谎称确定。
            const ev = confidence && confidence.bind ? confidence.bind[slot.key] : null
            const isCertain = !viaStdin && !viaArgv && !!guessed && !!ev && ev.level === 'certain'
            // 可选格清空后不再挂状态徽标：格子是空的，徽标不能说它匹配上了。
            //   文本改走标准输入时同理：扫描匹配到的是个开关名，而这一格已经不用开关了。
            const isMatched = !viaStdin && !viaArgv && !!guessed && (!slot.optional || !!val)
            // 可选格空着不算缺：不挂「需指定」，只在格子下面给一句提示。
            const unset = scanned && !guessed && !val && slotNeeded(slot.key)
              && !slot.optional && !viaStdin && !viaArgv
            const optionalEmpty = slot.optional && !val
            const input = (
              <Select
                editable
                className={`${isCertain ? 'wz-field-matched' : ((isMatched || unset) ? 'wz-field-guess' : '')}${overSlot === slot.key ? ' wz-dropzone-over' : ''}`}
                style={slot.optional ? { flex: 1, minWidth: 0 } : undefined}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOverSlot(slot.key) }}
                onDragLeave={() => setOverSlot(null)}
                onDrop={dropOn(slot.key)}
                value={val}
                disabled={!slotNeeded(slot.key) || viaStdin || viaArgv}
                title={val || undefined}
                placeholder={viaStdin
                  ? t('text goes in through standard input', '正文走标准输入')
                  : (viaArgv
                    ? t('supplied by a positional argument in the command words', '由命令行词序里的位置参数供值')
                    : (unset || optionalEmpty
                      ? t('Pick from candidates or type a parameter name', '从候选中选择，或输入参数名') : ''))}
                onChange={(e) => setSlot(slot.key, e.target.value)}
                inputProps={{ 'aria-label': t(slot.labelEn, slot.labelZh) }}>
                {candidateOptions}
              </Select>
            )
            return (
              <Cell key={slot.key}
                unset={!val && !viaArgv}
                label={t(slot.labelEn, slot.labelZh)} code={slot.key}
                badge={<>
                  {viaArgv &&
                    <span className="badge badge-muted">
                      {t('supplied positionally', '位置参数供值')}
                    </span>}
                  {isMatched
                    ? <span className={`badge ${isCertain ? 'badge-ok' : 'badge-warn'}`}
                        title={ev ? t(ev.reason.en, ev.reason.zh) : undefined}>
                        {isCertain ? t('confirmed by scan', '扫描已确定') : t('inferred, confirm', '推测，请核对')}
                      </span>
                    : (unset
                      ? <span className="badge badge-warn">{t('not matched, specify', '未匹配，需指定')}</span>
                      : (slot.optional ? <span className="badge badge-muted">{t('optional', '可选')}</span> : null))}
                  {slot.key === 'output_path' && returnsInferred &&
                    <span className="badge badge-warn"
                      title={t(confidence.returns.reason.en, confidence.returns.reason.zh)}>
                      {t('output form inferred', '输出形态为推测')}
                    </span>}
                </>}
                hint={viaArgv
                  ? t('This value already travels as a positional argument in Command words. '
                    + 'A value goes one way only: if this engine takes a switch instead, '
                    + 'remove {' + slot.key + '} from Command words first, then fill this field.',
                    '这个值已经按位置参数写在「命令行词序」里。一个值只有一个去处：'
                    + '这台引擎若改用开关收它，请先从命令行词序里删掉 {' + slot.key + '}，再回来填这一格。')
                  : viaStdin
                  ? t('The host writes the text into the subprocess\'s standard input. '
                    + 'No text switch appears on the command line.',
                    '宿主把正文写进子进程的标准输入，命令行上不出现任何文本开关。')
                  : slot.key === 'output_path' && !slotNeeded(slot.key)
                    ? t('not needed: the engine returns the audio directly', '不需要：引擎直接返回音频')
                    : (optionalEmpty
                      ? t('The platform matches this as best it can and may not recognize it. If it stays empty, drag the matching parameter here.',
                        '平台只做尽力匹配，未必能识别。留空时可将对应参数拖入此格。')
                      : null)}>
                {slot.optional
                  ? (
                    <div style={{ display: 'flex', gap: 6 }}>
                      {input}
                      <button type="button" className="btn btn-sm"
                        disabled={!val}
                        title={t('Clear this slot', '清除这一格')}
                        onClick={() => setSlot(slot.key, '')}>
                        {t('Clear', '清除')}
                      </button>
                    </div>
                  )
                  : slot.key === 'output_path'
                    ? (
                      <>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 6, alignItems: 'center' }}>
                          {input}
                          {/* 文件 / 目录：扫描按开关名推一个默认值，这里是逃生口。
                              两列 grid 把右边钉死 120px：用 flex 时下拉会按最长选项
                              撑开自己，左边的输入框跟着缩，切换时整块位置都在动。 */}
                          <Select className="control"
                            value={returns}
                            title={t('Does this engine take a file name, or a directory it names itself?',
                              '这台引擎收的是文件名，还是由它自己起名的目录？')}
                            onChange={(e) => setReturns(e.target.value)}>
                            <option value="file">{t('file', '文件')}</option>
                            <option value="dir">{t('directory', '目录')}</option>
                          </Select>
                        </div>
                        {/* save_dir 与 output_dir 并非同义。这条提醒常驻这里：
                            名字是本页唯一的判据，而这个判据本身有反例。 */}
                        <div className="field-hint" style={{ color: 'var(--warning)', marginTop: 6 }}>
                          {t('This project treats save_dir as where training writes the weights, and output or output_dir as inference output. Some engines differ (Spark-TTS uses save_dir for output), so the parameter name decides here.',
                            '本项目默认 save_dir 是训练产出的权重落点，output 与 output_dir 才是推理输出。也有引擎不这样（Spark-TTS 用 save_dir 作输出目录），故此处按参数名判断。')}
                        </div>
                      </>
                    )
                    : slot.key === 'text' && isCli
                      ? (
                        <>
                          {input}
                          {/* 标准输入是命令行的第二种文本入口，不是参数名：
                              勾上就把这一格让给宿主，名片里写 text_via 而不是 bind.text。 */}
                          <label className="field-hint"
                            style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <input type="checkbox" checked={textViaStdin}
                              onChange={(e) => setTextVia(e.target.checked)} />
                            {t('Read the text from standard input (this program has no text switch)',
                              '正文从标准输入读（该程序没有文本开关时）')}
                          </label>
                        </>
                      )
                      : input}
              </Cell>
            )
          })}
        </div>

        <div className="form-grid wz-required-row">
          <Cell label={t('Engine directory', '引擎目录')} code="runtime.python"
            unset={!runtime.python}
            badge={defaultedBadge(runtime.python, conv && conv.python)}>
            <input className="control" type="text" placeholder={conv ? conv.python : 'engines/<id>/.venv'}
              value={runtime.python || ''}
              onChange={(e) => setRuntime({ python: e.target.value.trim() })} />
          </Cell>
          <Cell label={t('Start script', '启动脚本')} code="runtime.entry"
            unset={!runtime.entry}
            badge={defaultedBadge(runtime.entry, conv && conv.entry)}
            hint={t('change it only if the engine ships its own server script',
              '仅当引擎附带服务脚本时才需修改')}>
            <input className="control" type="text" placeholder={conv ? conv.entry : ''}
              value={runtime.entry || ''}
              onChange={(e) => setRuntime({ entry: e.target.value.trim() })} />
          </Cell>
          <Cell label={t('Model weights', '模型权重')} code={isCli ? 'call.argv' : 'call.init_args'}
            badge={weightsInferred
              ? <span className="badge badge-warn"
                  title={t(confidence.weights.reason.en, confidence.weights.reason.zh)}>
                  {t('weights switch inferred', '权重开关为推测')}
                </span>
              : null}
            hint={weights.self
              ? null
              : t(`parameter that receives the weights; ${TOKEN} is the step 3 download folder, write ${TOKEN}/<file name> when the engine takes a single file`,
                `引擎从哪个参数读权重；${TOKEN} 是第 3 步的下载目录，引擎只收一个文件时写成 ${TOKEN}/文件名`)}>
            <div style={{ display: 'flex', gap: 6 }}>
              <Select
                editable
                className={overSlot === '__weights' ? 'wz-dropzone-over' : ''}
                style={{ flex: 1, minWidth: 0 }}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOverSlot('__weights') }}
                onDragLeave={() => setOverSlot(null)}
                onDrop={dropWeights}
                disabled={weights.self}
                title={weights.name || undefined}
                placeholder={isCli ? '--model_dir' : t('parameter name', '参数名')}
                value={weights.name}
                onChange={(e) => setWeights({ name: e.target.value })}
                inputProps={{ 'aria-label': t('Weights parameter', '权重参数名') }}>
                {candidateOptions}
              </Select>              <input className="control" style={{ flex: 1, minWidth: 0 }}
                disabled={weights.self || !weights.name}
                placeholder={TOKEN}
                aria-label={t('Weights path', '权重路径')}
                value={weights.name ? weights.value : ''}
                onChange={(e) => setWeights({ value: e.target.value })} />
            </div>
            <label className="field-hint" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={weights.self}
                onChange={(e) => setWeights({ self: e.target.checked })} />
              {t('The engine locates its own weights; the platform passes none',
                '引擎自行定位权重，平台不传入')}
            </label>
          </Cell>
        </div>
      </div>
    </div>
  )
}
