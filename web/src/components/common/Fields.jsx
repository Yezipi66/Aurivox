// AUTO-EXTRACTED from App.jsx (pure mechanical, zero logic change).
// Item 17: descriptive prose is localised via useT(); product terms
// (meta.json, GPT, SoVITS, id, v2/v2Pro/v2ProPlus, ckpt, pth, epoch, step) stay English.
import { useT } from '../../lib/i18n'
import { Select } from './Select'

function NamingNotePill({ onOpen, className = '' }) {
  const { t } = useT()
  return (
    <button
      type="button"
      className={`naming-note-pill ${className}`}
      onClick={onOpen}
      title={t('Show model naming & metadata notes', '查看模型命名与元数据说明')}
    >
      <span className="nn-i">i</span>
      {t('Model naming & metadata — how renaming works', '模型命名与元数据 — 重命名的工作方式')}
    </button>
  )
}

function NamingNoteCard({ acked, onAck, onCollapse }) {
  const { lang, t } = useT()
  return (
    <div className="naming-note-card">
      <div className="naming-note-hd">
        <span>{t('Model naming & metadata rebuild — read before renaming', '模型命名与元数据重建 — 重命名前请阅读')}</span>
        {acked && (
          <button type="button" className="nn-x" title={t('Collapse', '折叠')} onClick={onCollapse}>×</button>
        )}
      </div>
      <div className="naming-note-body">
        {lang === 'zh' ? (
          <>
            <p>训练完成的模型会把语言写入文件名中：</p>
            <ul>
              <li><code>&lt;id&gt;_&lt;lang&gt;-e&lt;epoch&gt;.ckpt</code>（GPT）</li>
              <li><code>&lt;id&gt;_&lt;lang&gt;_&lt;version&gt;_e&lt;epoch&gt;_s&lt;step&gt;.pth</code>（SoVITS，例如 <code>_v2Pro_</code>）</li>
            </ul>
            <p>
              SoVITS 文件名还携带底模版本（v2 / v2Pro / v2ProPlus）。版本按以下顺序恢复：
              <strong>meta.json（最高优先）→ 文件名标记 → 权重头</strong>。已存在的元数据永远不会被覆盖。
            </p>
            <p>
              如果某个 Voice 的 <code>meta.json</code> 被删除或缺少字段，语言会依据这些文件名重建。
              已存在的元数据始终最高优先 —— 已有的语言不会被覆盖。<strong>请谨慎重命名：</strong>
              手动修改模型文件名可能破坏语言恢复，重用同一个 id 可能与其它 Voice 冲突。
              在此处重命名会安全地同时更新 id、文件夹与元数据。
            </p>
          </>
        ) : (
          <>
            <p>Trained models are published with the language baked into the filename:</p>
            <ul>
              <li><code>&lt;id&gt;_&lt;lang&gt;-e&lt;epoch&gt;.ckpt</code> (GPT)</li>
              <li><code>&lt;id&gt;_&lt;lang&gt;_&lt;version&gt;_e&lt;epoch&gt;_s&lt;step&gt;.pth</code> (SoVITS, e.g. <code>_v2Pro_</code>)</li>
            </ul>
            <p>
              The SoVITS filename also carries the base-model version (v2 / v2Pro / v2ProPlus). Version is
              recovered in this order: <strong>meta.json (first-truth) → filename token → weight header</strong>.
              Present metadata is never overwritten.
            </p>
            <p>
              If a voice's <code>meta.json</code> is ever deleted or a field is missing, the language is
              rebuilt from these filenames. Existing metadata is always first-truth — a present
              language is never overwritten. <strong>Rename carefully:</strong> hand-editing model
              filenames can break language recovery, and reusing an id can collide with another
              voice. Renaming here safely updates the id, folder and metadata together.
            </p>
          </>
        )}
      </div>
      <div className="naming-note-ft">
        <button type="button" className="btn btn-sm btn-primary" onClick={onAck}>{t('Got it', '知道了')}</button>
        {acked && <span className="nn-hint">{t('Acknowledged — kept collapsed from now on.', '已确认 —— 之后将保持折叠。')}</span>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
//  Broker: OpenAI-compatible speech API notice (acknowledge-able, i18n).
//  Mirrors the Assets naming-note pattern. Explains that the endpoint follows
//  OpenAI's POST /v1/audio/speech shape but with a few Aurivox specifics
//  (voice = recipe id, model ignored, server-side language resolution, etc.)
//  and shows a couple of ready-to-run commands. Product terms stay English.
// ---------------------------------------------------------------------------

function BrokerApiNotePill({ onOpen, className = '' }) {
  const { t } = useT()
  return (
    <button
      type="button"
      className={`naming-note-pill ${className}`}
      onClick={onOpen}
      title={t('Show the request format & fields', '查看请求格式与字段')}
    >
      <span className="nn-i">i</span>
      {t('OpenAI-compatible speech API — request format & fields', '兼容 OpenAI 的语音 API — 请求格式与字段')}
    </button>
  )
}

function BrokerApiNoteCard({ endpoint, acked, onAck, onCollapse }) {
  const { lang, t } = useT()
  const base = String(endpoint || '').replace(/\/v1\/audio\/speech$/, '') || '/…'
  const sampleInput = lang === 'zh' ? '你好，这是一段示例文本。' : 'Hello! This is a sample line.'
  const curl = `curl -X POST ${endpoint || '<host>/v1/audio/speech'} \\
  -H "Content-Type: application/json" \\
  -d '{"model":"tts-1","voice":"narrator/warm","input":"${sampleInput}","response_format":"wav"}' \\
  --output out.wav`
  const py = `from openai import OpenAI
client = OpenAI(base_url="${base}/v1", api_key="unused")
client.audio.speech.create(
    model="tts-1", voice="narrator/warm", input="${sampleInput}",
).stream_to_file("out.wav")`
  return (
    <div className="naming-note-card">
      <div className="naming-note-hd">
        <span>{t('OpenAI-compatible speech API — read before integrating', '兼容 OpenAI 的语音 API — 接入前请阅读')}</span>
        {acked && (
          <button type="button" className="nn-x" title={t('Collapse', '折叠')} onClick={onCollapse}>×</button>
        )}
      </div>
      <div className="naming-note-body">
        {lang === 'zh' ? (
          <>
            <p>
              本接口遵循 OpenAI 的 <code>POST /v1/audio/speech</code> 请求结构，标准 OpenAI 客户端可直接使用，
              但有几处 Aurivox 特有的差异，接入前请留意：
            </p>
            <ul>
              <li><code>voice</code>（<strong>必填</strong>）：最大的差异 —— 它<strong>不是</strong> <code>alloy</code>/<code>nova</code> 这类名字，而是一个 <strong>recipe id</strong> <code>role/name</code>（走 recipe：固定的模型 / 参考音频 / 参数，可复现）；也可只填 <code>role</code>（整声路径，自动挑选最佳 checkpoint）。</li>
              <li><code>input</code>（<strong>必填</strong>）：待合成文本，最长 5000 字符。</li>
              <li><code>model</code>（可选）：仅为兼容 OpenAI 客户端而接受，<strong>会被忽略</strong> —— 实际的 GPT / SoVITS 权重由 recipe 固定。随便填（如 <code>tts-1</code>）即可。</li>
              <li><code>response_format</code>（可选）：默认 <code>wav</code>（无外部依赖）。<code>mp3</code>/<code>opus</code>/<code>aac</code>/<code>flac</code> 需要服务器安装 <code>ffmpeg</code>。</li>
              <li><code>speed</code>（可选）：语速倍率。</li>
            </ul>
            <p>
              <strong>语言不是请求字段</strong>（OpenAI 本身也没有）。语言由服务端“防线栈”解析：
              <strong>recipe.language → 资产语言 → auto</strong>。响应头返回 <code>X-Text-Lang</code>（最终解析结果）；
              若是兜底落到 <code>auto</code>，还会带上 <code>X-Language-Warning</code>。想要确定性输出，
              请在 recipe 上显式设置语言（Save as recipe 时选择，或在本页编辑）。
            </p>
            <p>常见命令：</p>
            <pre className="nn-pre"><code>{curl}</code></pre>
            <pre className="nn-pre"><code>{py}</code></pre>
          </>
        ) : (
          <>
            <p>
              This endpoint follows OpenAI's <code>POST /v1/audio/speech</code> shape and works with
              standard OpenAI clients, but with a few Aurivox-specific specifics — read before integrating:
            </p>
            <ul>
              <li><code>voice</code> (<strong>required</strong>): the biggest difference — it is <strong>not</strong> a name like <code>alloy</code>/<code>nova</code>, but a <strong>recipe id</strong> <code>role/name</code> (recipe path: pinned models / reference / params, reproducible). A bare <code>role</code> also works (whole-voice path, auto-picks the best checkpoint).</li>
              <li><code>input</code> (<strong>required</strong>): the text to synthesize, up to 5000 characters.</li>
              <li><code>model</code> (optional): accepted for OpenAI-client compatibility but <strong>ignored</strong> — the actual GPT / SoVITS weights are pinned by the recipe. Send any value (e.g. <code>tts-1</code>).</li>
              <li><code>response_format</code> (optional): defaults to <code>wav</code> (no external deps). <code>mp3</code>/<code>opus</code>/<code>aac</code>/<code>flac</code> require <code>ffmpeg</code> on the server.</li>
              <li><code>speed</code> (optional): playback speed multiplier.</li>
            </ul>
            <p>
              <strong>Language is not a request field</strong> (OpenAI has none either). It is resolved
              server-side by the defense stack: <strong>recipe.language → asset language → auto</strong>.
              The response returns <code>X-Text-Lang</code> (the resolved mode); when it falls back to
              <code>auto</code> it also sets <code>X-Language-Warning</code>. For deterministic output, set the
              language explicitly on the recipe (choose it in Save-as-recipe, or edit it on this page).
            </p>
            <p>Common commands:</p>
            <pre className="nn-pre"><code>{curl}</code></pre>
            <pre className="nn-pre"><code>{py}</code></pre>
          </>
        )}
      </div>
      <div className="naming-note-ft">
        <button type="button" className="btn btn-sm btn-primary" onClick={onAck}>{t('Got it', '知道了')}</button>
        {acked && <span className="nn-hint">{t('Acknowledged — kept collapsed from now on.', '已确认 —— 之后将保持折叠。')}</span>}
      </div>
    </div>
  )
}

// ===========================
//  TRAINING TAB
// ===========================

function NumField({ label, value, onChange, min, max, step = 1 }) {
  return (
    <div>
      <label style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</label>
      <input className="control" type="number" value={value} min={min} max={max} step={step}
             onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
    </div>
  );
}

function TextField({ label, value, onChange }) {
  return (
    <div>
      <label style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</label>
      <input className="control" value={value} onChange={e => onChange(e.target.value)} />
    </div>
  );
}

// Dropdown counterpart to TextField/NumField. `options` is an array of
// [value, label] pairs. Keeps the same label/control markup so it lines up
// inside a param-grid alongside the number/text fields.
function SelectField({ label, value, onChange, options = [] }) {
  return (
    <div>
      <label style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</label>
      <Select className="control" value={value} onChange={e => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l ?? v}</option>)}
      </Select>
    </div>
  );
}

// ===========================================================================
//  Shared training-parameter source of truth
//  Both the Training page and the Restore/Rebuild modal render the *same*
//  parameter panels and serialise through the *same* builders, so whatever the
//  formal training flow exposes, the rebuild flow exposes identically.
// ===========================================================================

export {
  NamingNotePill,
  NamingNoteCard,
  BrokerApiNotePill,
  BrokerApiNoteCard,
  NumField,
  TextField,
  SelectField,
}
