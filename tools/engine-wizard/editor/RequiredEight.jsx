import React from 'react'
import { useT } from '../../../web/src/lib/i18n'

// 名片必填项的编辑器：只填平台当场校验的那 8 个键，常驻展开在 L1 核心区。
// 这 8 个键缺失或类型不对时，lib/engines/profile.js 加载名片就会抛错，名片装不上。
// 键清单：runtime.python、runtime.entry、runtime.ready_endpoint、runtime.ready_timeout_ms、
// timeout_ms、max_chars、capabilities.requires_reference_audio、capabilities.output_sample_rate。
// runtime 段的全量编辑器（NestedSections 的 RuntimeSection）在 L2 折叠区，verify、checkpoints
// 等可选键也在那里；这里只重复必填的那几格，两处写的是同一张名片。
// 排版用项目已有的类（.section / .section-hdr / .section-body / .field / .field-label /
// .field-hint / .control / .form-grid），不新增 class；不写具体引擎名（有守卫测试）。

export default function RequiredEight ({ manifest, onChange }) {
  const { t } = useT()
  const runtime = (manifest && manifest.runtime) || {}
  const caps = (manifest && manifest.capabilities) || {}

  // 改 runtime / capabilities 段里的一个键：只改该段，别处不动。
  const setRuntime = (patch) => {
    const next = { ...runtime, ...patch }
    // 值为 undefined 时删掉这个键，别把 undefined 写进名片。
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
    onChange({ ...manifest, runtime: Object.keys(next).length ? next : undefined })
  }
  const setCaps = (patch) => {
    const next = { ...caps, ...patch }
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
    onChange({ ...manifest, capabilities: Object.keys(next).length ? next : undefined })
  }
  // 改名片顶层的一个键。
  const setTop = (key, v) => {
    const next = { ...manifest }
    if (v === undefined || v === '') delete next[key]
    else next[key] = v
    onChange(next)
  }

  return (
    <div className="section">
      <div className="section-hdr">
        <h2>{t('Required fields (8)', '必填字段（8 项）')}</h2>
      </div>
      <div className="section-body">
        {/* 平台当场校验的那 8 个必填项，缺一项名片就装不上，
            所以摆在最显眼处常驻展开。
            判据见 lib/engines/profile.js 的 required 与 requiredBool 调用。*/}
        <p className="field-hint" style={{ marginTop: 0 }}>
          {t('These are the fields the platform rejects the manifest without. '
            + 'The scan fills what it can; check the rest and correct anything off.',
            '以下是平台必填的 8 项，缺一项名片就装不上。扫描能填的已自动填好，其余请核对补全。')}
        </p>
        <div className="form-grid">
          <div className="field">
            <label className="field-label"><code>runtime.python</code></label>
            <div className="field-hint">
              {t('the engine’s own environment directory (e.g. engines/<id>/.venv)',
                '这台引擎自己的环境目录（如 engines/<id>/.venv）')}
            </div>
            <input className="control" type="text" placeholder="engines/xxx/.venv"
              value={runtime.python || ''}
              onChange={(e) => setRuntime({ python: e.target.value.trim() })} />
          </div>
          <div className="field">
            <label className="field-label"><code>runtime.entry</code></label>
            <div className="field-hint">
              {t('the script that starts the engine (relative to the engine dir)',
                '启动引擎的脚本（相对引擎目录）')}
            </div>
            <input className="control" type="text"
              value={runtime.entry || ''}
              onChange={(e) => setRuntime({ entry: e.target.value.trim() })} />
          </div>
          <div className="field">
            <label className="field-label"><code>runtime.ready_endpoint</code></label>
            <div className="field-hint">
              {t('the path polled to decide the engine is up (must start with /)',
                '轮询哪个路径判断引擎已就绪（必须以 / 开头）')}
            </div>
            <input className="control" type="text" placeholder="/health"
              value={runtime.ready_endpoint || ''}
              onChange={(e) => setRuntime({ ready_endpoint: e.target.value.trim() })} />
          </div>
          <div className="field">
            <label className="field-label"><code>runtime.ready_timeout_ms</code></label>
            <div className="field-hint">
              {t('how long to wait before giving up', '等多久算超时')}
            </div>
            <input className="control" type="number"
              value={runtime.ready_timeout_ms ?? ''}
              onChange={(e) => setRuntime({
                ready_timeout_ms: e.target.value === '' ? undefined : Number(e.target.value),
              })} />
          </div>
          <div className="field">
            <label className="field-label"><code>timeout_ms</code></label>
            <div className="field-hint">
              {t('request timeout in milliseconds', '单次请求超时（毫秒）')}
            </div>
            <input className="control" type="number"
              value={manifest.timeout_ms ?? ''}
              onChange={(e) => setTop('timeout_ms',
                e.target.value === '' ? undefined : Number(e.target.value))} />
          </div>
          <div className="field">
            <label className="field-label"><code>max_chars</code></label>
            <div className="field-hint">
              {t('longest text accepted per request', '单次请求最长字符数')}
            </div>
            <input className="control" type="number"
              value={manifest.max_chars ?? ''}
              onChange={(e) => setTop('max_chars',
                e.target.value === '' ? undefined : Number(e.target.value))} />
          </div>
          <div className="field">
            <label className="field-label"><code>capabilities.requires_reference_audio</code></label>
            <div className="field-hint">
              {t('whether a reference recording is required', '是否需要参考音频')}
            </div>
            <select className="control"
              value={String(caps.requires_reference_audio ?? '')}
              onChange={(e) => setCaps({
                requires_reference_audio: e.target.value === '' ? undefined : e.target.value === 'true',
              })}>
              <option value="">{t('(unset)', '（不写）')}</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </div>
          <div className="field">
            <label className="field-label"><code>capabilities.output_sample_rate</code></label>
            <div className="field-hint">
              {t('sample rate of synthesized audio in Hz', '合成音频的采样率（Hz）')}
            </div>
            <input className="control" type="number"
              value={caps.output_sample_rate ?? ''}
              onChange={(e) => setCaps({
                output_sample_rate: e.target.value === '' ? undefined : Number(e.target.value),
              })} />
          </div>
        </div>
      </div>
    </div>
  )
}
