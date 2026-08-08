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
  -d '{"model":"tts-1","voice":"narrator/warm","input":"${sampleInput}","response_format":"wav","language":"ja"}' \\
  --output out.wav`
  const streamCurl = `# streaming: chunked, first-byte-fast; nothing saved on server unless persist:true
curl -N -X POST ${endpoint || '<host>/v1/audio/speech'} \\
  -H "Content-Type: application/json" \\
  -d '{"model":"tts-1","voice":"narrator/warm","input":"${sampleInput}","response_format":"wav","stream":true}' \\
  --output out.wav`
  const py = `from openai import OpenAI
client = OpenAI(base_url="${base}/v1", api_key="unused")
client.audio.speech.create(
    model="tts-1", voice="narrator/warm", input="${sampleInput}",
    extra_body={"language": "ja"},   # optional Aurivox extension; omit to use the recipe's language
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
              <li><code>stream</code>（<strong>可选，Aurivox 扩展</strong>）：设 <code>true</code> 分块边合边回、首字节更快；<strong>默认不在服务器落盘</strong>，需归档时再加 <code>persist:true</code>（一边回流一边存档）。<strong>流式仅支持 <code>wav</code> / <code>ogg</code></strong>（<code>mp3</code> 等需整段转码，不走流式）。客户端断开连接即中止本次合成。</li>
              <li><code>speed</code>（可选）：语速倍率。</li>
              <li><code>language</code>（<strong>可选，Aurivox 扩展</strong>）：单次请求指定朗读语言，<strong>优先级最高</strong>。支持 <code>zh</code> / <code>ja</code> / <code>en</code> / <code>auto</code>（裸码 <code>zh</code>/<code>ja</code> 会归一为引擎模式 <code>all_zh</code>/<code>all_ja</code>；也可直接传规范值 <code>all_zh</code>/<code>all_ja</code>/<code>auto_zh_ja_yue</code>，与 recipe 存储一致）；其它值（含暂未维护的 <code>yue</code>/<code>ko</code>）<strong>不报错</strong>，会回落到 <code>auto</code> 并带 <code>X-Language-Warning</code> 提示不支持。OpenAI 官方 SDK 通过 <code>extra_body</code> 传（见下方 Python 示例）。</li>
            </ul>
            <p>
              <strong>语言优先级：请求 <code>language</code> → recipe.language → 资产语言 → auto。</strong>
              OpenAI 本身没有语言字段，故此项为 Aurivox 可选扩展——<strong>不传则行为与以前完全一致</strong>。
              响应头始终返回 <code>X-Text-Lang</code>（最终解析结果）；仅当<strong>既没传 <code>language</code>、
              recipe 也没钉语言</strong>而兜底到 <code>auto</code> 时（或请求了不支持的语言），才带 <code>X-Language-Warning</code>。
              想要确定性输出，请求里显式带 <code>language</code>，或在 recipe 上设置语言。
            </p>
            <p>
              <strong>性能与并发（v1.0.6）：</strong>
              ① <strong>请求内并行</strong> —— 单条较长请求会被切分并行合成以压低时延，默认 <code>batch_size=4</code>；显存吃紧或长文本 OOM 时把服务器环境变量 <code>AURIVOX_TTS_BATCH_SIZE</code> 设为 <code>1</code>（或在 recipe 高级参数里下调），显存富裕可上调（1–16）。
              ② <strong>模型留驻</strong> —— 同一音色连续合成不重载权重；<strong>换参考音频</strong>也走缓存（最近用过的免重抽），多音色 recipe 轮转各自保持热，容量由 <code>AURIVOX_REF_CACHE</code> 控制（默认 8）。
              ③ <strong>过载保护</strong> —— 推理为单卡串行，请求排队积压超上限时立即返回 <code>503</code>（<code>code: generation_queue_full</code>）并带 <code>Retry-After</code> 头，请客户端据此重试；上限 <code>AURIVOX_MAX_QUEUE</code>（默认 32，0=不限）、<code>AURIVOX_RETRY_AFTER</code>（默认 3 秒）。
            </p>
            <p>常见命令：</p>
            <pre className="nn-pre"><code>{curl}</code></pre>
            <pre className="nn-pre"><code>{py}</code></pre>
            <p style={{ marginTop: 8 }}>{t('Streaming (chunked; no server-side file unless you add persist:true):','流式调用（分块；默认不落盘，加 persist:true 才存档）：')}</p>
            <pre className="nn-pre"><code>{streamCurl}</code></pre>
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
              <li><code>stream</code> (<strong>optional, Aurivox extension</strong>): set <code>true</code> to stream audio in chunks (faster first byte); <strong>nothing is written on the server by default</strong> — add <code>persist:true</code> to also archive it while streaming. <strong>Streaming supports <code>wav</code> / <code>ogg</code> only</strong> (<code>mp3</code> etc. need whole-clip transcoding). Disconnecting the client aborts the synthesis.</li>
              <li><code>speed</code> (optional): playback speed multiplier.</li>
              <li><code>language</code> (<strong>optional, Aurivox extension</strong>): pins the reading language for this request at the <strong>highest priority</strong>. Supported: <code>zh</code> / <code>ja</code> / <code>en</code> / <code>auto</code> (bare <code>zh</code>/<code>ja</code> normalise to the engine modes <code>all_zh</code>/<code>all_ja</code>; the canonical <code>all_zh</code>/<code>all_ja</code>/<code>auto_zh_ja_yue</code> forms are accepted too, matching what recipes store); any other value (including the currently-unmaintained <code>yue</code>/<code>ko</code>) is <strong>not an error</strong> — it falls back to <code>auto</code> and sets an <code>X-Language-Warning</code> saying it isn't supported. Pass it via <code>extra_body</code> with the official OpenAI SDK (see the Python sample).</li>
            </ul>
            <p>
              <strong>Language priority: request <code>language</code> → recipe.language → asset language → auto.</strong>
              OpenAI has no language field, so this is an optional Aurivox extension — <strong>omit it and behaviour is
              exactly as before</strong>. The response always returns <code>X-Text-Lang</code> (the resolved mode); an
              <code>X-Language-Warning</code> is set only when it bottoms out to <code>auto</code> with <strong>no request
              <code>language</code> and no recipe/asset language</strong> (or when an unsupported language was requested).
              For deterministic output, send <code>language</code> on the request, or set it on the recipe.
            </p>
            <p>
              <strong>Performance &amp; concurrency (v1.0.6):</strong>
              (1) <strong>Within-request parallelism</strong> — a single long request is split and synthesized in parallel to cut latency; default <code>batch_size=4</code>. On low VRAM or long-text OOM, set the server env var <code>AURIVOX_TTS_BATCH_SIZE</code> to <code>1</code> (or lower it in the recipe's advanced params); raise it (1–16) if you have headroom.
              (2) <strong>Model residency</strong> — consecutive calls to the same voice don't reload weights, and <strong>switching reference audio</strong> is cached too (recently-used refs skip re-extraction), so multi-voice recipe rotation stays warm. Capacity via <code>AURIVOX_REF_CACHE</code> (default 8).
              (3) <strong>Overload protection</strong> — inference is single-GPU serial; when the queue backs up past the limit the server returns <code>503</code> (<code>code: generation_queue_full</code>) with a <code>Retry-After</code> header for the client to honor. Limits: <code>AURIVOX_MAX_QUEUE</code> (default 32, 0 = unbounded), <code>AURIVOX_RETRY_AFTER</code> (default 3s).
            </p>
            <p>Common commands:</p>
            <pre className="nn-pre"><code>{curl}</code></pre>
            <pre className="nn-pre"><code>{py}</code></pre>
            <p style={{ marginTop: 8 }}>{t('Streaming (chunked; no server-side file unless you add persist:true):','流式调用（分块；默认不落盘，加 persist:true 才存档）：')}</p>
            <pre className="nn-pre"><code>{streamCurl}</code></pre>
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
