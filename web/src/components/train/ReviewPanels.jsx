// AUTO-EXTRACTED from TrainingTab.jsx (pure mechanical, zero logic change).
import { useState, useEffect } from 'react'
import { useT } from '../../lib/i18n'
import { api } from '../../lib/api'
import { PronPanel } from '../pron/PronProofing'
import { Player } from '../common/Player'
import { Select } from '../common/Select'
import { basename } from '../../lib/format'
import { usePreviewMode } from '../../lib/previewMode'
import { ReviewRowAudio, ConfBadge, WordConf, CONF_COLORS, confTierLabel } from './TrainPanels'

// GIGO 门 1：人声提取试听面板。管线在分离完成后暂停时显示。加载分离产物音频，
// Vocal-extraction audition gate (GIGO gate 1). Auditions each separated stem
// with the shared dark-theme <Player> (seek bar + waveform, same as Generate):
// continue if clean, cancel the whole run if not. Sits alongside the ASR proofing
// panel as the two make-or-break review gates.
function DenoiseReviewPanel({ taskId, onResumed, onCancel }) {
  const { t: tr } = useT();
  const [files, setFiles] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // Audition players inherit the app-wide preview mode (bar vs. waveform). Expose a
  // small inline toggle here too so you can flip it right where you're listening,
  // without hunting for the global switch in the status bar.
  const [previewMode, setPreviewMode] = usePreviewMode();

  useEffect(() => {
    let dead = false;
    setLoading(true);
    api(`/api/train/review/${taskId}`).then(r => {
      if (dead) return;
      if (r.ok) setFiles(r.data.files || []);
      else setErr(r.data?.error || 'Failed to load extracted vocals');
      setLoading(false);
    }).catch(e => { if (!dead) { setErr(String(e)); setLoading(false); } });
    return () => { dead = true; };
  }, [taskId]);

  const resume = async () => {
    setBusy(true); setErr(null);
    const r = await api(`/api/train/resume/${taskId}`, { method: 'POST', body: {} });
    setBusy(false);
    if (r.ok) { if (onResumed) onResumed(); }
    else setErr(r.data?.error || 'Resume failed');
  };

  return (
    <div className="denoise-review">
      <div className="denoise-review-hdr">
        <span>{tr('Audition extracted vocals', '试听提取的人声')}</span>
        <span className="denoise-review-hdr-right">
          <span className="pvmode-toggle" role="group" aria-label={tr('Preview style', '预览样式')}>
            <button type="button" className={`pvmode-toggle-btn ${previewMode === 'bar' ? 'active' : ''}`}
                    onClick={() => setPreviewMode('bar')} title={tr('Seek bar', '进度条')}>
              {tr('Bar', '进度条')}
            </button>
            <button type="button" className={`pvmode-toggle-btn ${previewMode === 'waveform' ? 'active' : ''}`}
                    onClick={() => setPreviewMode('waveform')} title={tr('Waveform', '波形')}>
              {tr('Waveform', '波形')}
            </button>
          </span>
          <span className="muted">{files ? `${files.length} ${tr('file(s)', '个文件')}` : ''}</span>
        </span>
      </div>
      <p className="denoise-review-hint">
        {tr('Listen to the separated vocals. Continue if they sound clean; cancel if the quality is poor — garbled, muffled, or with obvious background music left in.',
            '试听分离出来的人声：音质清晰则继续；如果质量不好（模糊、沉闷，或还留着明显的伴奏），就取消。')}
      </p>
      {loading && <div className="msg">{tr('Loading audio…', '加载音频…')}</div>}
      {err && <div className="msg msg-error">{err}</div>}
      {files && files.length > 0 && (
        <div className="denoise-review-list">
          {files.map(f => (
            <div className="denoise-review-row" key={f.path}>
              <div className="arr-path" title={f.path}>{f.name}</div>
              <Player size="sm"
                      src={`/api/train/review/${taskId}/audio?path=${encodeURIComponent(f.path)}`} />
            </div>
          ))}
        </div>
      )}
      {files && files.length === 0 && (
        <div className="msg msg-warn">{tr('No separated audio was produced.', '没有生成分离后的音频。')}</div>
      )}
      <div className="denoise-review-ftr">
        <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => onCancel && onCancel()}>
          {tr('Cancel', '取消')}
        </button>
        <button className="btn btn-sm btn-primary" disabled={busy || loading} onClick={resume}>
          {busy ? tr('Working…', '处理中…') : tr('Continue', '继续')}
        </button>
      </div>
    </div>
  );
}

// P6: manual proofreading panel shown while the pipeline is paused after ASR.
// Loads the recognised .list, lets the user correct text/pronunciation per line,
// then saves + resumes (or resumes without changes).
// PG: per-line reading proofing inside the ASR review. Reuses the shared PronPanel
// so the user can, right after ASR, both fix the transcript text AND correct
// polyphonic/kana/phoneme readings — saving them to the personal lexicon
// (data/pron_lexicon/{lang}.json), which the g2p layer applies on the next
// training/inference run. Overrides are per-line and transient; only the lexicon
// save persists (that's the closed loop; see PG-1a).
// ：`engineId` 一路传到 PronPanel，/api/pron/preview
//   现在 engine_id 必传。不传的表现是"这里的读音校对安静地不工作"。
function AsrRowProof({ text, lang, onChange, disabled, engineId }) {
  const [open, setOpen] = useState(false)
  const [overrides, setOverrides] = useState({})
  return (
    <div className="arr-proof">
      <button type="button" className="btn btn-sm btn-ghost" disabled={disabled} onClick={() => setOpen(o => !o)}>
        {open ? 'Hide reading proofing' : 'Proof reading'}
      </button>
      {open && (
        <PronPanel text={text} setText={onChange} lang={lang} overrides={overrides} setOverrides={setOverrides} layout="wide" engineId={engineId} />
      )}
    </div>
  )
}

function AsrReviewPanel({ taskId, onResumed, lang, engineId }) {
  const { t: tr } = useT();
  const [rows, setRows] = useState(null);
  const [listName, setListName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let dead = false;
    setLoading(true);
    api(`/api/train/review/${taskId}`).then(r => {
      if (dead) return;
      if (r.ok) { setRows(r.data.rows || []); setListName(r.data.listName || ''); }
      else setErr(r.data?.error || 'Failed to load review list');
      setLoading(false);
    }).catch(e => { if (!dead) { setErr(String(e)); setLoading(false); } });
    return () => { dead = true; };
  }, [taskId]);

  const setText = (idx, val) => setRows(rs => rs.map(r => r.index === idx ? { ...r, text: val } : r));
  const setLang = (idx, val) => setRows(rs => rs.map(r => r.index === idx ? { ...r, lang: val } : r));

  const save = async () => {
    setBusy(true); setErr(null); setMsg(null);
    const r = await api(`/api/train/review/${taskId}`, { method: 'POST', body: { rows } });
    setBusy(false);
    if (r.ok) setMsg(`Saved ${r.data.saved} line(s).`);
    else setErr(r.data?.error || 'Save failed');
  };

  const resume = async () => {
    setBusy(true); setErr(null); setMsg(null);
    const r = await api(`/api/train/resume/${taskId}`, { method: 'POST', body: { rows } });
    setBusy(false);
    if (r.ok) { setMsg('Resumed.'); if (onResumed) onResumed(); }
    else setErr(r.data?.error || 'Resume failed');
  };

  return (
    <div className="asr-review">
      <div className="asr-review-hdr">
        <span>Proofread transcription{listName ? ` · ${listName}` : ''}</span>
        <span className="arr-hdr-right">
          {rows && rows.some(r => typeof r.confidence === 'number') && (
            <span className="arr-legend">
              {tr('Confidence', '置信度')}:
              {['hi', 'mid', 'lo'].map(tier => (
                <span key={tier} style={{ color: CONF_COLORS[tier].fg }}>
                  <span aria-hidden="true" style={{ fontWeight: 700 }}>{CONF_COLORS[tier].sym}</span>
                  {' '}{confTierLabel(tier, tr)}
                </span>
              ))}
            </span>
          )}
          <span className="muted">{rows ? `${rows.length} lines` : ''}</span>
        </span>
      </div>
      {/* Option A: when the engine returns no usable confidence (FunASR/Paraformer is
          non-autoregressive and doesn't expose per-token posteriors), the badges are
          blank — say so explicitly so a blank column doesn't read as "broken". */}
      {rows && rows.length > 0 && !rows.some(r => typeof r.confidence === 'number') && (
        <div className="asr-review-note">
          {tr('The current ASR engine (FunASR) does not provide confidence scores, so lines are not color-coded this run. Switch to Faster Whisper if you want confidence highlighting.',
              '当前 ASR 引擎（FunASR）不提供置信度，本次不做颜色标注。若需要置信度着色，请改用 Faster Whisper。')}
        </div>
      )}
      {loading && <div className="msg">Loading transcript…</div>}
      {err && <div className="msg msg-error">{err}</div>}
      {msg && <div className="msg msg-success">{msg}</div>}
      {rows && rows.length > 0 && (
        <div className="asr-review-list">
          {rows.map(r => (
            <div className="asr-review-row" key={r.index}>
              <div className="arr-meta">
                <div className="arr-path" title={r.audio_path}>{basename(r.audio_path) || r.audio_path}</div>
                <ReviewRowAudio taskId={taskId} relPath={r.audio_path} />
                <ConfBadge conf={r.confidence} tr={tr} />
              </div>
              <div className="arr-main">
                <div className="arr-input-grid">
                  <Select className="control" value={(r.lang || (lang === 'auto' ? '' : lang) || 'zh').toLowerCase()} disabled={busy} onChange={e => setLang(r.index, e.target.value)}>
                    <option value="zh">Mandarin</option><option value="yue">Cantonese</option><option value="ja">Japanese</option><option value="en">English</option><option value="ko">Korean</option>
                  </Select>
                <textarea className="arr-text" rows={1} value={r.text}
                          disabled={busy}
                          onChange={e => setText(r.index, e.target.value)} />
                </div>
                <WordConf words={r.words} tr={tr} />
                <AsrRowProof text={r.text} disabled={busy} engineId={engineId}
                             lang={(r.lang || (lang === 'auto' ? '' : lang) || '').toLowerCase()}
                             onChange={val => setText(r.index, val)} />
              </div>
            </div>
          ))}
        </div>
      )}
      {rows && rows.length === 0 && <div className="msg msg-warn">The transcript is empty.</div>}
      <div className="asr-review-ftr">
        <button className="btn btn-sm" disabled={busy || loading} onClick={save}>Save corrections</button>
        <button className="btn btn-sm btn-primary" disabled={busy || loading} onClick={resume}>
          {busy ? 'Working…' : 'Save & resume pipeline'}
        </button>
      </div>
    </div>
  );
}

export {
  DenoiseReviewPanel,
  AsrRowProof,
  AsrReviewPanel,
}
