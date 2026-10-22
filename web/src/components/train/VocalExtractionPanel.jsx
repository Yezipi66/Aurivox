// 人声提取（UVR5）面板：清洗方式预设、自定义分离链、模型可用性与按需下载。
// 权重是否齐备与下载任务都由这一页负责，缺权重不会让运行在中途失败。
// 预设与链的草稿只留在本页，不写进配方。
import { useState, useEffect, useMemo, useCallback } from 'react'
import { Select } from '../common/Select'
import { IconTrash } from '../common/Icons'
import { useT } from '../../lib/i18n'
import { api } from '../../lib/api'
import {
  AGG_DEFAULT,
  VOCAL_PRESETS,
  VOCAL_PRESET_BY_ID,
  EXPERT_META,
  EXPERT_KEYS,
  expertKeysForArch,
} from './trainConstants'
import { resolveVocalPipeline } from './trainParams'
import { PresetNameModal } from './trainModals'

// 属性：训练页的持久化表单与两个 setter。
// setField 会把它负责的键的预设名改成 Custom；setForm 是链与预设辅助函数要的原始更新入口。
// askConfirm / closeConfirm 是不可逆删除用的二次确认。
function VocalExtractionPanel({ form, setForm, setField, askConfirm, closeConfirm,
  onMissingChange, download, onDownloadChange, onStartDownload }) {
  const { t: tr } = useT()

  // UVR5 模型可用性（标签与已安装标记）。
  const [uvr5Models, setUvr5Models] = useState(null);   // [{id,label,category,arch,aggApplicable,installed,...}]
  const uvr5ById = useMemo(
    () => Object.fromEntries((uvr5Models || []).map(m => [m.id, m])), [uvr5Models]);
  const loadUvr5Models = useCallback(() => {
    api('/api/uvr5/models')
      .then(r => { if (r.ok && r.data) setUvr5Models(r.data.models || []); })
      .catch(() => {});
  }, []);
  useEffect(() => { loadUvr5Models(); }, [loadUvr5Models]);

  // 按需下载权重的任务状态。由父组件持有，页面级主按钮才能一起换成「下载模型」。
  const uvr5Download = download;
  const startUvr5Download = onStartDownload;
  useEffect(() => {
    const jobId = uvr5Download?.jobId;
    if (!jobId || (uvr5Download.status !== 'running')) return;
    let stop = false;
    const tick = () => {
      api(`/api/uvr5/download/${jobId}`).then(r => {
        if (stop || !r.ok) return;
        onDownloadChange(d => ({ ...(d || {}), ...r.data }));
        if (r.data.status === 'completed' || r.data.status === 'failed') {
          loadUvr5Models(); // 刷新已安装标记
        }
      }).catch(() => {});
    };
    const iv = setInterval(tick, 1200); tick();
    return () => { stop = true; clearInterval(iv); };
  }, [uvr5Download?.jobId, uvr5Download?.status, onDownloadChange, loadUvr5Models]);

  // 当前人声管线需要哪些模型，其中哪些还没装。
  const vocalPipelineNow = form.denoise ? resolveVocalPipeline(form) : [];
  const vocalNeededIds = [...new Set(vocalPipelineNow.map(s => s.model))];
  const vocalMissingIds = uvr5Models
    ? vocalNeededIds.filter(id => { const m = uvr5ById[id]; return m && !m.installed; })
    : [];

  // 把「缺哪些权重 / 怎么下载」同步给外层主动作按钮：权重不齐时它要换成「下载模型」。
  // 用 key 串判等，避免每次渲染都回调。
  const missingKey = vocalMissingIds.join(',');
  useEffect(() => {
    onMissingChange?.(missingKey ? vocalMissingIds : []);
  }, [missingKey]);
  // 面板结构：先选清洗方式预设，展开高级参数区，自定义分离链可存回预设。
  // 模型与激进度直接列在链上，高级参数放进需要确认才可编辑的折叠区。
  const modelLabel = (id) => {
    const m = uvr5ById[id];
    if (m) return tr(m.label.en, m.label.zh);
    return id;
  };
  const modelInstalled = (id) => { const m = uvr5ById[id]; return !uvr5Models || (m && m.installed); };
  const modelAggApplicable = (id) => { const m = uvr5ById[id]; return m ? m.aggApplicable : true; };
  // arch 决定这一级适用哪些高级参数。目录还没加载时退回按注册表推断的 arch，
  // 面板离线也能渲染。
  const modelArch = (id) => {
    const m = uvr5ById[id];
    if (m && m.arch) return m.arch;
    if (id === 'MDX-Net') return 'mdx';
    if (id === 'BS-Roformer') return 'roformer';
    return 'vr';
  };

  // 某一级的通用参数控件。stage 给当前值，applyPatch({key:val}) 写入改动。
  // 只画这一级模型的架构适用的那些旋钮。
  const renderStageExpert = (stage, applyPatch) => {
    const keys = expertKeysForArch(modelArch(stage.model));
    if (!keys.length) return null;
    return (
      <div style={{ marginTop: 6, paddingLeft: 10, borderLeft: '2px solid var(--border)' }}>
        {keys.map(k => {
          const meta = EXPERT_META[k];
          const cur = stage[k] != null ? stage[k] : meta.default;
          const id = `exp-${stage.model}-${k}`;
          return (
            <div key={k} style={{ marginBottom: 6 }}>
              {meta.type === 'bool' ? (
                <label className="toggle-row" style={{ fontSize: 12 }}>
                  <input type="checkbox" checked={!!cur} onChange={e => applyPatch({ [k]: e.target.checked })} />
                  {tr(meta.label[0], meta.label[1])}
                </label>
              ) : (
                <>
                  <label className="field-label" htmlFor={id} style={{ fontSize: 12 }}>{tr(meta.label[0], meta.label[1])}</label>
                  {meta.type === 'enum' ? (
                    <Select id={id} className="control" value={cur} onChange={e => applyPatch({ [k]: e.target.value })}>
                      {meta.options.map(o => <option key={o} value={o}>{o}</option>)}
                    </Select>
                  ) : (
                    <input id={id} type="number" className="control" min={meta.min} max={meta.max} value={cur}
                      onChange={e => {
                        let v = parseInt(e.target.value, 10);
                        if (!Number.isFinite(v)) v = meta.default;
                        v = Math.min(meta.max, Math.max(meta.min, v));
                        applyPatch({ [k]: v });
                      }} />
                  )}
                </>
              )}
              <p style={{ fontSize: 10.5, color: 'var(--muted)', margin: '2px 0 0' }}>{tr(meta.hint[0], meta.hint[1])}</p>
            </div>
          );
        })}
      </div>
    );
  };

  // 某一级的模型下拉，按类别分组，并标出是否已安装。
  const renderModelOptions = () => {
    if (!uvr5Models) return <option value="">{tr('loading…', '加载中…')}</option>;
    const cats = [
      ['keep_vocals', tr('Keep vocals', '保留人声')],
      ['main_vocal', tr('Only main vocal', '仅保留主人声')],
      ['dereverb', tr('De-reverb / de-echo', '去混响 / 去延迟')],
    ];
    return cats.map(([cat, label]) => {
      const items = uvr5Models.filter(m => m.category === cat);
      if (!items.length) return null;
      return (
        <optgroup key={cat} label={label}>
          {items.map(m => (
            <option key={m.id} value={m.id}>
              {tr(m.label.en, m.label.zh)}{m.installed ? '' : tr(' — not installed', '：未安装')}
            </option>
          ))}
        </optgroup>
      );
    });
  };

  const presetOptions = () => {
    const opts = VOCAL_PRESETS.map(p => {
      const ids = p.pipeline ? p.pipeline.map(s => s.model) : [];
      const missing = uvr5Models ? ids.filter(id => uvr5ById[id] && !uvr5ById[id].installed) : [];
      const suffix = missing.length ? tr(' — needs download', '：需下载') : '';
      return <option key={p.id} value={p.id}>{tr(p.label[0], p.label[1])}{suffix}</option>;
    });
    const saved = (form.denoiseSavedPresets || []).map(s => (
      <option key={`saved:${s.name}`} value={`saved:${s.name}`}>{tr('Saved', '已保存')}: {s.name}</option>
    ));
    return saved.length ? [...opts.slice(0, -1), <optgroup key="saved" label={tr('Saved presets', '已保存预设')}>{saved}</optgroup>, opts[opts.length - 1]] : opts;
  };

  // 当前选中的清洗方式预设与可编辑的分离链。
  // custom 与「saved:<name>」预设编辑的是同一份工作缓冲 form.denoisePipeline：
  // 选已保存预设为它填上缓冲，改动只是草稿，点「更新预设」之前不写回已存的那份；
  // 「另存为新预设」分出一份副本，「删除预设」删掉它（带确认）。
  const curPreset = form.denoisePreset || 'bgm';
  const curPresetDef = VOCAL_PRESET_BY_ID[curPreset];
  const isCustom = curPreset === 'custom';
  const savedList = Array.isArray(form.denoiseSavedPresets) ? form.denoiseSavedPresets : [];
  const isSaved = typeof curPreset === 'string' && curPreset.startsWith('saved:');
  const savedName = isSaved ? curPreset.slice(6) : null;
  const savedIdx = isSaved ? savedList.findIndex(s => s.name === savedName) : -1;
  const savedPreset = savedIdx >= 0 ? savedList[savedIdx] : null;
  // 二级分离链编辑器是否可用（自定义或已保存预设）。
  const chainEditable = isCustom || (isSaved && !!savedPreset);

  // 链的各个改写动作都作用于工作缓冲 form.denoisePipeline。
  const chain = Array.isArray(form.denoisePipeline) ? form.denoisePipeline : [];
  const setChain = (next) => setField('denoisePipeline', next);
  // 草稿与已存的那份预设是否有差异：决定「更新预设」按钮是否可用。
  const savedDirty = isSaved && savedPreset
    ? JSON.stringify(savedPreset.pipeline || []) !== JSON.stringify(chain)
    : false;
  const addStage = () => {
    if (chain.length >= 3) return;
    const firstInstalled = (uvr5Models || []).find(m => m.installed) || (uvr5Models || [])[0];
    const id = firstInstalled ? firstInstalled.id : 'HP2';
    setChain([...chain, modelAggApplicable(id) ? { model: id, agg: AGG_DEFAULT } : { model: id }]);
  };
  const removeStage = (i) => setChain(chain.filter((_, k) => k !== i));
  const updateStage = (i, patch) => setChain(chain.map((s, k) => {
    if (k !== i) return s;
    const next = { ...s, ...patch };
    if (patch.model != null) {
      if (modelAggApplicable(patch.model)) { if (next.agg == null) next.agg = AGG_DEFAULT; }
      else { delete next.agg; }
      // 换模型后，丢掉新架构不适用的那些高级参数。
      const keep = new Set(expertKeysForArch(modelArch(patch.model)));
      for (const ek of EXPERT_KEYS) if (!keep.has(ek)) delete next[ek];
    }
    return next;
  }));
  // 清洗方式预设下拉的处理器。选已保存预设为它填上一份拷贝（改动只是草稿，不是就地改），
  // 选 custom 保留缓冲里的内容，选系统预设则不动缓冲（它按模板运行）。
  const applyDenoisePreset = (value) => {
    if (typeof value === 'string' && value.startsWith('saved:')) {
      const name = value.slice(6);
      const saved = (form.denoiseSavedPresets || []).find(s => s.name === name);
      const copy = saved && Array.isArray(saved.pipeline) ? saved.pipeline.map(s => ({ ...s })) : [];
      setForm(f => ({ ...f, denoisePreset: value, denoisePipeline: copy }));
    } else {
      setField('denoisePreset', value);
    }
  };
  const [presetNameOpen, setPresetNameOpen] = useState(false);
  const saveChainAsPreset = () => setPresetNameOpen(true);
  const commitChainPreset = (rawName) => {
    const name = (rawName || '').trim();
    if (!name) return;
    const rest = (form.denoiseSavedPresets || []).filter(s => s.name !== name);
    setForm(f => ({ ...f, denoiseSavedPresets: [...rest, { name, pipeline: chain }], denoisePreset: `saved:${name}` }));
    setPresetNameOpen(false);
  };
  // 明确的「更新预设」：把当前草稿缓冲写回选中的已保存预设。
  // 不点它就不落盘，与训练页预设的「更新」动作一致。
  const updateSavedPreset = () => {
    if (!isSaved || !savedName) return;
    setForm(f => ({
      ...f,
      denoiseSavedPresets: (f.denoiseSavedPresets || []).map(
        s => s.name === savedName ? { ...s, name: savedName, pipeline: chain } : s),
    }));
  };
  // 删除当前选中的已保存预设（带确认），然后退回 custom。
  const deleteSavedPreset = () => {
    if (!isSaved || !savedName) return;
    askConfirm({
      title: tr('Delete vocal-extraction preset', '删除人声提取预设'),
      message: tr(`Delete the saved preset “${savedName}”? This can't be undone.`,
                  `确定删除已保存的预设“${savedName}”吗？此操作不可撤销。`),
      confirmLabel: tr('Delete', '删除'),
      onConfirm: () => {
        setForm(f => ({
          ...f,
          denoiseSavedPresets: (f.denoiseSavedPresets || []).filter(s => s.name !== savedName),
          denoisePreset: 'custom',
        }));
        closeConfirm();
      },
    });
  };

  const dlModels = uvr5Download?.models || {};

  // 每个预设在每一级上的覆盖值，存放在 form.denoisePresetParams[preset][stageIdx]，
  // 形如 {agg?, tta?, ...}，只保留在本页。改动以补丁的方式并进去。
  const presetStageOverride = (i) => {
    const raw = ((form.denoisePresetParams || {})[curPreset] || {})[i];
    return typeof raw === 'number' ? { agg: raw } : (raw || {});
  };
  const patchPresetStage = (i, patch) => setForm(f => {
    const all = { ...(f.denoisePresetParams || {}) };
    const forPreset = { ...(all[curPreset] || {}) };
    const prev = typeof forPreset[i] === 'number' ? { agg: forPreset[i] } : (forPreset[i] || {});
    forPreset[i] = { ...prev, ...patch };
    all[curPreset] = forPreset;
    return { ...f, denoisePresetParams: all };
  });

  // 需要高级参数的级，每一级配一个 apply(patch)。
  // custom 用用户自己的链（updateStage 改），预设用它的模板级（patchPresetStage 改）。
  // 只包含真正暴露了高级参数的级（按架构判定）。
  const advStages = (() => {
    let src;
    if (chainEditable) {
      src = chain.map((stage, i) => ({ stage, i, apply: (patch) => updateStage(i, patch) }));
    } else if (curPresetDef && curPresetDef.pipeline) {
      src = curPresetDef.pipeline.map((stage, i) => ({
        stage: { ...stage, ...presetStageOverride(i) }, i,
        apply: (patch) => patchPresetStage(i, patch),
      }));
    } else {
      src = [];
    }
    return src.filter(({ stage }) => expertKeysForArch(modelArch(stage.model)).length > 0);
  })();
  return (
    <>
      <label className="toggle-row" style={{ marginBottom: 8 }}>
        <input type="checkbox" checked={form.denoise} onChange={e => setField('denoise', e.target.checked)} />
        {tr('Enable vocal extraction', '启用人声提取')}
      </label>

      {form.denoise && (
        <>
          {/* 人声提取后暂停试听：与 ASR 校对门并列，默认开启。分离质量决定训练成败，
              值得停下来听一遍（不满意可直接取消管线）。放在「启用人声提取」正下方，与该步骤的开关相邻。 */}
          <label className="toggle-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.pauseAfterDenoise !== false}
                   onChange={e => setField('pauseAfterDenoise', e.target.checked)} />
            {tr('Pause after vocal extraction to audition', '人声提取后暂停以试听校对')}
          </label>
          <p className="field-hint" style={{ marginTop: -2, marginBottom: 8 }}>
            {tr('When enabled the pipeline stops right after separation so you can listen to the extracted vocals. Continue if they sound clean, or cancel the run if the quality is poor — this is the first GIGO gate.',
                '启用后，流程会在分离完成后立即停止，供试听提取出的人声。音质清晰则继续，质量差就取消本次任务：这是决定成败的第一道 GIGO 门。')}
          </p>

          {/* 提取后，分离出的人声才是真正的 raw（切片/ASR/训练都用它）。提取前的原始混音
              默认归档到资产的 raw_b4_extraction/，便于日后重构或换参重跑。 */}
          <label className="toggle-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={form.keepRawB4Extraction !== false}
                   onChange={e => setField('keepRawB4Extraction', e.target.checked)} />
            {tr('Keep pre-extraction originals (raw_b4_extraction/)', '保留提取前的原始音频（raw_b4_extraction/）')}
          </label>
          <p className="field-hint" style={{ marginTop: -2, marginBottom: 8 }}>
            {tr('After extraction the separated vocals become the asset\u2019s raw/ (they are what slicing, ASR and training use). The original pre-extraction mixdown is archived to raw_b4_extraction/ so the voice folder stays self-contained and can be reconstructed. Turn this off to save disk if you only need the final vocals.',
                '提取完成后，分离出的人声会成为资产的 raw/（切片、ASR、训练都用它）。提取前的原始混音则归档到 raw_b4_extraction/，让音色目录自包含、可随时重构或换参重跑。若只需最终人声、希望节省磁盘空间，可关闭此项。')}
          </p>

          <div className="field">
            <label className="field-label">{tr('Cleanup preset', '清洗方式')}</label>
            <Select className="control" value={curPreset} onChange={e => applyDenoisePreset(e.target.value)}>
              {presetOptions()}
            </Select>
            {curPresetDef && (
              <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>{tr(curPresetDef.hint[0], curPresetDef.hint[1])}</p>
            )}
          </div>

          {/* 普通参数：影响小、经常调，直接显示。对预设来说就是每一级的激进度。 */}
          {!isCustom && curPresetDef && curPresetDef.pipeline &&
            curPresetDef.pipeline.some(s => modelAggApplicable(s.model) && 'agg' in s) && (
            <div className="field" style={{ marginBottom: 8 }}>
              {curPresetDef.pipeline.map((stage, i) => {
                if (!(modelAggApplicable(stage.model) && 'agg' in stage)) return null;
                const merged = { ...stage, ...presetStageOverride(i) };
                return (
                  <div key={i} style={{ marginBottom: 6 }}>
                    <label className="field-label" style={{ fontSize: 12 }}>
                      {curPresetDef.pipeline.length > 1 ? `${i + 1}. ${modelLabel(stage.model)} — ` : ''}
                      {tr('Aggressiveness', '激进度')} ({merged.agg})
                    </label>
                    <input type="range" min={0} max={20} step={1} value={merged.agg} style={{ width: '100%' }}
                      onChange={e => patchPresetStage(i, { agg: parseInt(e.target.value, 10) })} />
                  </div>
                );
              })}
              <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                {tr('Settings are kept on this page only (not saved permanently to the recipe).',
                  '参数仅保存在本页面，不会永久写入配方。')}
              </p>
            </div>
          )}

          {/* 二级分离链编辑器：自定义与已保存预设都用同一套控件，已保存预设还可就地更新或删除。
              模型与激进度直接列在链上，高级参数放进需要确认才可编辑的折叠区。 */}
          {chainEditable && (
            <div className="field" style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 10, marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                {isSaved
                  ? tr(`Editing saved preset “${savedName}”${savedDirty ? ' (unsaved changes)' : ''} — runs top to bottom (each stage feeds the next).`,
                      `正在编辑已保存预设“${savedName}”${savedDirty ? '（有未保存的改动）' : ''}，从上到下逐级串联（上一级输出喂给下一级）。`)
                  : tr('Custom separation chain — runs top to bottom (each stage feeds the next).',
                      '自定义分离链：从上到下逐级串联（上一级输出喂给下一级）。')}
              </div>
              {chain.length === 0 && (
                <p style={{ fontSize: 12, color: 'var(--muted)' }}>{tr('No stages yet. Add one below.', '还没有分级，请在下方添加。')}</p>
              )}
              {chain.map((stage, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{i + 1}</span>
                  <Select className="control" style={{ flex: '1 1 200px' }} value={stage.model} onChange={e => updateStage(i, { model: e.target.value })}>
                    {renderModelOptions()}
                  </Select>
                  {modelAggApplicable(stage.model) && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                      {tr('agg', '激进度')}
                      <input type="range" min={0} max={20} step={1} value={stage.agg != null ? stage.agg : AGG_DEFAULT}
                        onChange={e => updateStage(i, { agg: parseInt(e.target.value, 10) })} />
                      <span style={{ width: 18, textAlign: 'right' }}>{stage.agg != null ? stage.agg : AGG_DEFAULT}</span>
                    </span>
                  )}
                  <button className="btn btn-sm btn-ghost" onClick={() => removeStage(i)} title={tr('Remove', '删除')}><IconTrash /></button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                <button className="btn btn-sm" onClick={addStage} disabled={chain.length >= 3}>{tr('+ Add stage', '+ 添加一级')}</button>
                {isSaved && (
                  <button className="btn btn-sm btn-primary" onClick={updateSavedPreset} disabled={!savedDirty}>
                    {tr('Update preset', '更新预设')}
                  </button>
                )}
                <button className="btn btn-sm" onClick={saveChainAsPreset} disabled={chain.length === 0}>
                  {isSaved ? tr('Save as new preset', '另存为新预设') : tr('Save as preset', '保存为预设')}
                </button>
                {isSaved && (
                  <button className="btn btn-sm btn-danger" onClick={deleteSavedPreset}>{tr('Delete preset', '删除预设')}</button>
                )}
              </div>
              <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                {isSaved
                  ? tr('Up to 3 stages. Edits are a draft — press “Update preset” to save them back, “Save as new preset” to branch a copy, or “Delete preset” to remove it.',
                      '最多 3 级。改动仅为草稿：点“更新预设”才会写回，点“另存为新预设”另存副本，点“删除预设”移除。')
                  : tr('Up to 3 stages. Saved presets are kept on this page only.', '最多 3 级。已保存预设仅保留在本页面。')}
              </p>
            </div>
          )}

          {/* 高级参数：影响大且易出错，折叠并需要确认才可编辑，与 S1 的「高级参数」同一形态。 */}
          {advStages.length > 0 && (
            <details className="expert-block" style={{ marginTop: 4, marginBottom: 8 }}>
              <summary className="expert-summary">{tr('Advanced Parameters — separator internals', '高级参数：分离器内部设置')}</summary>
              <div className="msg msg-danger expert-warning">
                <strong>{tr('⚠ Advanced.', '⚠ 高级参数。')}</strong>{' '}
                {tr('These change speed/precision. fp16 makes HP models emit NaN on many GPUs; TTA roughly doubles time. Most users should leave the defaults.',
                  '这些会影响速度/精度。fp16 会让 HP 系列在很多显卡上出 NaN；TTA 大致会让耗时翻倍。多数用户保持默认即可。')}
              </div>
              <label className="toggle-row expert-unlock">
                <input type="checkbox" checked={!!form.denoiseAdvUnlocked} onChange={e => setField('denoiseAdvUnlocked', e.target.checked)} />
                {tr('I understand — let me edit advanced parameters', '我了解，允许我编辑高级参数')}
              </label>
              <fieldset disabled={!form.denoiseAdvUnlocked} className="expert-fields" style={{ border: 0, padding: 0, margin: 0, minInlineSize: 'auto' }}>
                {advStages.map(({ stage, apply, i }) => {
                  const body = renderStageExpert(stage, apply);
                  if (!body) return null;
                  return (
                    <div key={i} style={{ marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{i + 1}. {modelLabel(stage.model)}</div>
                      {body}
                    </div>
                  );
                })}
                <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                  {tr('Settings are kept on this page only (not saved permanently to the recipe).',
                    '参数仅保存在本页面，不会永久写入配方。')}
                </p>
              </fieldset>
            </details>
          )}

          {/* 模型可用性与按需下载。 */}
          {vocalMissingIds.length > 0 && (
            <div className="msg" style={{ background: 'rgba(255,180,0,0.12)', padding: 10, borderRadius: 6, marginBottom: 8 }}>
              <div style={{ fontSize: 12.5, marginBottom: 6 }}>
                {tr('These models are not installed: ', '以下模型未安装：')}
                <strong>{vocalMissingIds.map(modelLabel).join(', ')}</strong>
              </div>
              {uvr5Download && uvr5Download.status === 'running' ? (
                <div style={{ fontSize: 12 }}>
                  {tr('Downloading…', '下载中…')}{' '}
                  {Object.entries(dlModels).map(([id, s]) => `${id} ${s.pct || 0}%`).join(' · ')}
                </div>
              ) : (
                <button className="btn btn-sm btn-primary" onClick={() => startUvr5Download(vocalMissingIds)}>
                  {tr('Download model', '下载模型')}
                </button>
              )}
              {uvr5Download && uvr5Download.status === 'failed' && (
                <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 4 }}>
                  {tr('Download failed: ', '下载失败：')}{uvr5Download.error || ''}
                </div>
              )}
              <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                {tr('Downloaded from Hugging Face (ModelScope fallback) into uvr5_weights/.',
                  '从 Hugging Face 下载（ModelScope 备用）到 uvr5_weights/。')}
              </p>
            </div>
          )}
        </>
      )}

      {/* 分离链的另存为预设名称输入框：它要快照的缓冲 form.denoisePipeline 由本面板持有。 */}
      <PresetNameModal
        open={presetNameOpen}
        existingNames={(form.denoiseSavedPresets || []).map(s => s.name)}
        onSave={commitChainPreset}
        onClose={() => setPresetNameOpen(false)}
        example="my-vocal-chain"
      />
    </>
  )
}

export {
  VocalExtractionPanel,
}
