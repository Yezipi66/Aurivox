// 第 4 步的「命令行词序」：把 call.argv 摊成一串词，位置参数在这里放。
//
// 为什么单独一块：argv 是一张有序词表，「第几个词」这件事没有任何别的字段表达得了。
// 上游把文本或输出写成位置参数时（命令行上没有开关名），只能写在 argv 里，
// 写成 {text} / {ref_audio} / {ref_text} / {output_path} 这类占位符；
// 有开关名的那些留在必填区的 call.bind 里。同一个槽位两处都写，宿主会拒。
//
// 本组件只改 call.argv 整个数组，别的段一概不碰；词按数组顺序拼，所以上下次序就是命令行次序。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'

const SLOTS = [
  { name: 'text', en: 'text', zh: '文本' },
  { name: 'ref_audio', en: 'reference audio', zh: '参考音频' },
  { name: 'ref_text', en: 'reference text', zh: '参考文本' },
  { name: 'output_path', en: 'output path', zh: '输出路径' },
]

export default function ArgvWords ({ manifest, onChange }) {
  const { t } = useT()
  const call = (manifest && manifest.call) || {}
  const argv = Array.isArray(call.argv) ? call.argv.map(String) : []
  const bind = call.bind || {}
  const [draft, setDraft] = React.useState('')

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

  return (
    <div className="card" style={{ padding: 10 }}>
      <div className="wz-subhead">{t('Command words', '命令行词序')}</div>
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

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {SLOTS.map((s) => {
          const bound = String(bind[s.name] || '').trim()
          const used = hasSlot(s.name)
          const off = used || !!bound
          return (
            <button key={s.name} className="btn btn-sm" type="button" disabled={off}
              title={used
                ? t('Already in the command words below.', '已经在下面的词里了。')
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
