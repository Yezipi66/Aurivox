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
  NumField,
  TextField,
  SelectField,
}
