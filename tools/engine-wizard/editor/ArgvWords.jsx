// 第 4 步的「命令行词序」：把 call.argv 摊成一串词，位置参数在这里放。
//
// 为什么单独一块：argv 是一张有序词表，「第几个词」这件事没有任何别的字段表达得了。
// 上游把文本或输出写成位置参数时（命令行上没有开关名），只能写在 argv 里，
// 写成 {text} / {ref_audio} / {ref_text} / {output_path} 这类占位符；
// 有开关名的那些留在必填区的 call.bind 里。同一个槽位两处都写，宿主会拒。
//
// 此处只在「有位置参数」时才摊开：扫描确认命令行上一个位置参数都没有的引擎，
//   四个槽位按钮全是灰的（都绑在开关上）、只剩一个「加一个词」，
//   占着首屏却不给人任何可填的东西。那种引擎收成一行，把命令骨架念出来即可。
//
// 本组件只改 call.argv 整个数组，别的段一概不碰；词按数组顺序拼，所以上下次序就是命令行次序。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { POSITIONAL_SLOT, isMultiValue, normName } from './scanAutofill'

const SLOTS = [
  { name: 'text', en: 'text', zh: '文本' },
  { name: 'ref_audio', en: 'reference audio', zh: '参考音频' },
  { name: 'ref_text', en: 'reference text', zh: '参考文本' },
  { name: 'output_path', en: 'output path', zh: '输出路径' },
]

const slotFor = (name) => POSITIONAL_SLOT[normName(name)] || null

export default function ArgvWords ({ manifest, onChange, positionals }) {
  const { t } = useT()
  const call = (manifest && manifest.call) || {}
  const argv = Array.isArray(call.argv) ? call.argv.map(String) : []
  const bind = call.bind || {}
  const [draft, setDraft] = React.useState('')
  // null 表示还没人点过开合：开合跟着扫描结论走。
  const [opened, setOpened] = React.useState(null)

  // 函数式更新：同一次提交里别的区也在改名片，用快照整份写回会互相盖掉。
  const write = (next) => onChange((cur) => {
    const m = cur || {}
    return { ...m, call: { ...(m.call || {}), argv: next } }
  })
  const hasSlot = (name) => argv.some((w) => w.indexOf('{' + name + '}') >= 0)

  const move = (i, delta) => {
    const j = i + delta
    if (j < 0 || j >= argv.length) return
    const next = argv.slice()
    const tmp = next[i]
    next[i] = next[j]
    next[j] = tmp
    write(next)
  }
  const remove = (i) => write(argv.filter((_, k) => k !== i))
  const append = (word) => {
    const w = String(word || '').trim()
    if (!w) return
    write([...argv, w])
  }

  // 位置参数清单：null 表示这次还没扫过（结论未知），数组则是扫描的结论。
  const posList = Array.isArray(positionals) ? positionals : null
  const usedSlots = SLOTS.filter((s) => hasSlot(s.name))
  // 词序区值得摊开的三个条件：扫描说有位置参数、词里已经写着槽位占位符、
  //   或者还没扫过（那时给不出结论，摊开比收起更安全）。
  const wanted = posList === null || posList.length > 0 || usedSlots.length > 0
  const open = opened === null ? wanted : opened

  // 收起态：一行念出这条命令，留一个展开入口。收起不等于「没有位置参数」，
  //   扫描结论有几种就念几种：把有无位置参数混成一句话，人会被引到错的结论上。
  if (!open) {
    const posNames = (posList || []).map((p) => String((p && p.name) || '')).filter(Boolean)
    const summary = posList === null
      ? t('Not scanned yet: open this to edit the command words.',
        '还没扫描：展开可以编辑命令词。')
      : (posNames.length
          ? t('Scan found ' + posNames.length + ' positional argument(s): ' + posNames.join(', ')
            + '. Open this to see how each one is connected.',
            '扫描到 ' + posNames.length + ' 个位置参数：' + posNames.join('、')
            + '。展开可以看到每一条接成了什么。')
          : (usedSlots.length
              ? t('Positional placeholders are in the command words.',
                '命令词里有位置参数占位符。')
              : t('No positional arguments: every value this engine takes has a switch name.',
                '没有位置参数：这台引擎要的每个值都带开关名。')))
    return (
      <div className="card" style={{ padding: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="wz-subhead" style={{ margin: 0 }}>{t('Command words', '命令行词序')}</span>
          <span className="field-hint" style={{ margin: 0 }}>{summary}</span>
          <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
            {argv.map((word, i) => (
              <code key={i} className="badge" style={{ fontFamily: 'inherit' }}>{word}</code>
            ))}
          </span>
          <button className="btn btn-sm" type="button" onClick={() => setOpened(true)}>
            {t('Edit', '展开编辑')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="card" style={{ padding: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span className="wz-subhead" style={{ margin: 0 }}>{t('Command words', '命令行词序')}</span>
        {/* 展开就一直能收起：开合是同一个动作，只能开不能合等于单向阀门。
            有位置参数时也要留这条路，那正是最需要看完整命令的人。 */}
        <button className="btn btn-sm" type="button" onClick={() => setOpened(false)}>
          {t('Collapse', '收起')}
        </button>
      </div>
      <div className="field-hint">
        {t('These words are the command run on every synthesis, in this order. Positional arguments go here: add a placeholder such as {text} with the buttons below, and the host replaces it with the value from the request. Slots that have a switch stay in the required fields; one slot is declared in one place only.',
          '这一串词就是每次合成时执行的命令，按上下的次序拼。位置参数写在这里：点下面的按钮把 {text} 这类占位符加进来，宿主会用请求里的值替换它。带开关名的槽位留在必填区，同一个槽位只能写一处。')}
      </div>

      {argv.length === 0 && (
        <div className="field-hint">
          {t('No command words yet: this card has no argv (python form).', '这份名片还没有命令词（python 形态没有 argv）。')}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0' }}>
        {argv.map((word, i) => (
          <span key={i} className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 2, padding: '2px 4px' }}>
            <code style={{ fontFamily: 'inherit' }}>{word}</code>
            <button className="btn btn-sm" type="button" title={t('move left', '前移')}
              disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button className="btn btn-sm" type="button" title={t('move right', '后移')}
              disabled={i === argv.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button className="btn btn-sm" type="button" title={i === 0
              ? t('The first word is the interpreter; it cannot be removed.', '第一个词是解释器，不能删。')
              : t('remove this word', '删掉这个词')}
            disabled={i === 0} onClick={() => remove(i)}>×</button>
          </span>
        ))}
      </div>

      {/* 扫描到的位置参数：逐条列出它是什么、几个词、接到哪个槽位。
          没有对应槽位的也列出来，只是说明平台没有值可填，不假装能接。 */}
      {posList && posList.length > 0 && (
        <div style={{ margin: '6px 0' }}>
          <div className="field-hint">
            {t('The scan found positional arguments on this command line. Those with a matching slot are connected below; the rest have no value on this platform.',
              '扫描到这条命令行上有位置参数。有对应槽位的在下面逐条接上；没有对应槽位的平台没有值可填。')}
          </div>
          {posList.map((p) => {
            const slot = slotFor(p && p.name)
            const linked = slot && hasSlot(slot)
            return (
              <div key={String(p.name)} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                <code className="badge" style={{ fontFamily: 'inherit' }}>{String(p.name)}</code>
                {p.nargs !== undefined && p.nargs !== null && (
                  <span className="badge" title={isMultiValue(p.nargs)
                    ? t('This argument takes more than one word.', '这个参数要收多个词。')
                    : t('This argument may be omitted.', '这个参数可以不给。')}>
                    nargs {String(p.nargs)}
                  </span>
                )}
                {slot
                  ? (linked
                      ? <span className="badge">{t('connected as ', '已接成 ')}{'{' + slot + '}'}</span>
                      : (
                        <button className="btn btn-sm" type="button"
                          title={bind[slot]
                            ? t('This slot is bound to ' + bind[slot] + ' in the required fields: clear it there first.',
                              '这一项在必填区绑了开关 ' + bind[slot] + '，先清掉那一格再接。')
                            : t('Append {' + slot + '} to the command words', '把 {' + slot + '} 加到命令行末尾')}
                          disabled={!!bind[slot]}
                          onClick={() => append('{' + slot + '}')}>
                          {t('connect as ', '接成 ')}{'{' + slot + '}'}
                        </button>
                      ))
                  : <span className="field-hint">{t('no slot on this platform', '平台没有对应的值可填')}</span>}
                {p.help && <span className="field-hint" style={{ margin: 0 }}>{String(p.help)}</span>}
              </div>
            )
          })}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {SLOTS.map((s) => {
          const bound = String(bind[s.name] || '').trim()
          const used = hasSlot(s.name)
          // 已经由位置参数供值时，按钮也说清是哪一个词供的：否则人以为是开关供的。
          const fromPos = posList && posList.find((p) => slotFor(p && p.name) === s.name)
          const off = used || !!bound
          return (
            <button key={s.name} className="btn btn-sm" type="button" disabled={off}
              title={used
                ? (fromPos
                    ? t('Already in the command words, supplied by the positional argument "' + fromPos.name + '".',
                      '已经在下面的词里，由位置参数「' + fromPos.name + '」供值。')
                    : t('Already in the command words below.', '已经在下面的词里了。'))
                : (bound
                    ? t('This slot is bound to ' + bound + ' in the required fields: clear it there first.',
                      '这一项在必填区绑了开关 ' + bound + '，先清掉那一格再加。')
                    : t('Append ' + '{' + s.name + '} to the command words',
                      '把 {' + s.name + '} 加到命令行末尾'))}
              onClick={() => append('{' + s.name + '}')}>
              + {t(s.en, s.zh)}
            </button>
          )
        })}
        <input className="control" style={{ maxWidth: 220 }} value={draft}
          placeholder={t('a literal word, e.g. --language', '一个固定词，如 --language')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            append(draft)
            setDraft('')
          }} />
        <button className="btn btn-sm" type="button" disabled={!draft.trim()}
          onClick={() => { append(draft); setDraft('') }}>
          {t('Add word', '加一个词')}
        </button>
      </div>
    </div>
  )
}
