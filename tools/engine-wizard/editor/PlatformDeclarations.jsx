// 第 4 步「平台声明」区：编辑名片上的能力声明。
// 这里是编辑声明的地方，不是消费声明的地方。9886 前端「没声明就不长控件」，
//   向导若也不给添加入口，那份声明就永远无法产生。所以本区只摆「已声明的项」
//   与一个添加按钮；没声明时不画任何输入控件。
//
// 三类声明：音频类输入（call.args.*.role=audio_ref）、多权重位（weights[]）、
//   输出格式（output_formats[]）。平台不解释它们的上游语义，名字与标签都由名片写。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'

const APPLIES = ['call', 'launch']

export default function PlatformDeclarations ({ manifest, onChange }) {
  const { t } = useT()
  const m = manifest || {}
  const call = m.call || {}
  const audio = Object.entries(call.args || {}).filter(([, e]) => e && e.role === 'audio_ref')
  const weights = Array.isArray(m.weights) ? m.weights : []
  const formats = Array.isArray(m.output_formats) ? m.output_formats : []

  // 全部走函数式更新：同一次提交里别的区也在改名片，用快照整份写回会互相盖掉。
  const patch = (fn) => onChange((cur) => fn(cur || {}))

  const setAudio = (name, key, value) => patch((cur) => {
    const c = cur.call || {}
    const args = { ...(c.args || {}) }
    const old = args[name] || {}
    const next = { ...old, [key]: value }
    if (key === 'label' && !String(value).trim()) delete next.label
    if (key === 'label_en' && !String(value).trim()) delete next.label_en
    args[name] = next
    return { ...cur, call: { ...c, args } }
  })

  const addAudio = () => patch((cur) => {
    const c = cur.call || {}
    const args = { ...(c.args || {}) }
    let n = 1
    while (args['audio_ref_' + n]) n += 1
    const name = 'audio_ref_' + n
    // 只声明角色与占位开关：开关名、标签、单值多值都留给使用者改。
    args[name] = { flag: '--' + name.replace(/_/g, '-'), style: 'value', role: 'audio_ref' }
    // host 只把 params.call_time 白名单里的键交给引擎。不写进去，
    //   界面选了音频、请求也带了，命令行上却不会出现，而且不报错。
    const p = { ...(cur.params || {}) }
    const ct = Array.isArray(p.call_time) ? p.call_time : []
    if (!ct.includes(name)) p.call_time = [...ct, name]
    return { ...cur, call: { ...c, args }, params: p }
  })

  const dropAudio = (name) => patch((cur) => {
    const c = cur.call || {}
    const args = { ...(c.args || {}) }
    delete args[name]
    return { ...cur, call: { ...c, args } }
  })

  const setWeights = (list) => patch((cur) => ({ ...cur, weights: list.length ? list : undefined }))
  const setFormats = (list) => patch((cur) => ({ ...cur, output_formats: list.length ? list : undefined }))
  const setWeight = (i, key, value) => {
    // launch 位的参数是开进程那一步吃进去的，写 param 永远发不出去，平台会拒收。
    // 切到 launch 时把 param 一并清掉，别让使用者存下一张装不上的名片。
    const next = weights.map((w, j) => (i === j ? { ...w, [key]: value } : w))
    if (key === 'applies_at' && value === 'launch') delete next[i].param
    setWeights(next)
  }

  return (
    <div className="section" style={{ marginTop: 8 }}>
      <div className="section-hdr"><h2>{t('Platform declarations', '平台声明')}</h2></div>
      <div className="section-body">
        <div className="field-hint" style={{ marginBottom: 8 }}>
          {t('A control appears only when its declaration exists. Fill in a declaration to enable the corresponding front-end control.',
            '填了声明才有对应的前端控件；不声明，前端就没有那一格。')}
        </div>

        {/* 音频类输入：一行一个声明，开关名与标签都可改 */}
        {audio.map(([name, e]) => (
          <div key={name} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 6 }}>
            <div className="field" style={{ flex: '1 1 150px', minWidth: 0, marginBottom: 0 }}>
              <label className="field-label">{t('Audio input', '音频输入')}</label>
              <input className="control" value={e.flag || ''}
                title={t('The switch that receives the selected audio path', '接收所选音频路径的开关')}
                onChange={(ev) => setAudio(name, 'flag', ev.target.value)} />
            </div>
            <div className="field" style={{ flex: '1 1 150px', minWidth: 0, marginBottom: 0 }}>
              <label className="field-label">{t('Label', '显示名')}</label>
              <input className="control" value={e.label || ''}
                placeholder={name}
                onChange={(ev) => setAudio(name, 'label', ev.target.value)} />
            </div>
            <button type="button" className="btn btn-sm" style={{ marginBottom: 0 }}
              onClick={() => dropAudio(name)}>{t('Remove', '移除')}</button>
          </div>
        ))}
        <button type="button" className="btn btn-sm" onClick={addAudio}>
          + {t('Add audio input', '添加音频输入')}
        </button>

        {/* 多权重位：平台有几个可选模型位，9886 就长几个下拉 */}
        {weights.length > 0 && (
          <div style={{ marginTop: 10 }}>
            {weights.map((w, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 6 }}>
                <div className="field" style={{ flex: '1 1 150px', minWidth: 0, marginBottom: 0 }}>
                  <label className="field-label">{t('Slot name', '权重位名')}</label>
                  <input className="control" value={w.name || ''}
                    onChange={(ev) => setWeight(i, 'name', ev.target.value)} />
                </div>
                <div className="field" style={{ flex: '1 1 150px', minWidth: 0, marginBottom: 0 }}>
                  <label className="field-label">{t('Label', '显示名')}</label>
                  <input className="control" value={w.label || ''}
                    onChange={(ev) => setWeight(i, 'label', ev.target.value)} />
                </div>
                <div className="field" style={{ flex: '1 1 150px', minWidth: 0, marginBottom: 0 }}>
                  <label className="field-label">{t('Parameter', '参数名')}</label>
                  <input className="control" value={w.param || ''}
                    placeholder={t('empty: not switchable at run time', '留空：运行时不可换')}
                    onChange={(ev) => setWeight(i, 'param', ev.target.value)} />
                </div>
                <div className="field" style={{ flex: '0 0 110px', marginBottom: 0 }}>
                  <label className="field-label">{t('Applies at', '生效时机')}</label>
                  <select className="control" value={w.applies_at || 'call'}
                    onChange={(ev) => setWeight(i, 'applies_at', ev.target.value)}>
                    {APPLIES.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                </div>
                <button type="button" className="btn btn-sm" style={{ marginBottom: 0 }}
                  onClick={() => setWeights(weights.filter((_, j) => j !== i))}>{t('Remove', '移除')}</button>
              </div>
            ))}
          </div>
        )}
        <button type="button" className="btn btn-sm" style={{ marginTop: 6 }}
          onClick={() => setWeights([...weights, { name: 'model_' + (weights.length + 1), label: '', applies_at: 'launch' }])}>
          + {t('Add weight slot', '添加权重位')}
        </button>

        {/* 输出格式：平台据此判「要 mp3」该不该 400，前端据此长格式下拉 */}
        {formats.length > 0 && (
          <div className="field" style={{ marginTop: 10, marginBottom: 0 }}>
            <label className="field-label">{t('Output formats', '输出格式')}</label>
            <input className="control" value={formats.join(', ')}
              placeholder="wav, mp3"
              title={t('Comma-separated. Leave empty to keep only wav.', '逗号分隔；留空则只出 wav。')}
              onChange={(ev) => setFormats(ev.target.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))} />
          </div>
        )}
        {formats.length === 0 && (
          <button type="button" className="btn btn-sm" style={{ marginTop: 6 }}
            onClick={() => setFormats(['wav'])}>+ {t('Declare output formats', '声明输出格式')}</button>
        )}
      </div>
    </div>
  )
}
