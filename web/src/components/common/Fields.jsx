// AUTO-EXTRACTED from App.jsx (pure mechanical, zero logic change).
function NamingNotePill({ onOpen, className = '' }) {
  return (
    <button
      type="button"
      className={`naming-note-pill ${className}`}
      onClick={onOpen}
      title="Show model naming & metadata notes"
    >
      <span className="nn-i">i</span>
      Model naming &amp; metadata — how renaming works
    </button>
  )
}

function NamingNoteCard({ acked, onAck, onCollapse }) {
  return (
    <div className="naming-note-card">
      <div className="naming-note-hd">
        <span>Model naming &amp; metadata rebuild — read before renaming</span>
        {acked && (
          <button type="button" className="nn-x" title="Collapse" onClick={onCollapse}>×</button>
        )}
      </div>
      <div className="naming-note-body">
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
      </div>
      <div className="naming-note-ft">
        <button type="button" className="btn btn-sm btn-primary" onClick={onAck}>Got it</button>
        {acked && <span className="nn-hint">Acknowledged — kept collapsed from now on.</span>}
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
}
