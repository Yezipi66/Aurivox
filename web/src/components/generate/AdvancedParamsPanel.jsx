// AdvancedParamsPanel.jsx — 高级参数面板
//
// 从 GenerateTab.jsx 搬出：可折叠的高级参数区。
// 参数本身全部来自 engine.param_schema（按档位循环渲染），平台自己的
// 开关（Seed、强制重新推理、引擎批量、媒体类型）不属于任何一台引擎，
// 所以不跟着那个循环长。
import { Select } from '../common/Select'
import { ParamField, ToggleField } from '../common/ParamField'
import { TIERS, schemaGap } from '../../lib/engines'
import { AuxReferencePicker } from '../common/RefPickers'
import { useT } from '../../lib/i18n'

export function AdvancedParamsPanel({
  showAdvanced,
  onToggle,
  advTier,
  onTier,
  engine,
  engineName,
  visibleFields,
  paramValues,
  onParam,
  uiLang,
  selectOptions,
  seed,
  onSeed,
  forceResynth,
  onForceResynth,
  engineBatch,
  onEngineBatch,
  mediaType,
  onMediaType,
  hasAuxRefs,
  auxRefs,
  currentRefAudio,
  refVoiceId,
  voices,
  onAuxRefAdd,
  onAuxRefRemove,
}) {
  const { t } = useT()

  return (
    <div className="collapsible" style={{ margin: '6px 0' }}>
      <div className="collapsible-hdr" onClick={onToggle}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Advanced Settings</span>
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>{showAdvanced ? '▲' : '▼'}</span>
      </div>
      {showAdvanced && (
        <div className="collapsible-body">
          {/* Tier tabs，档位也来自名片（TIERS），不是写死两个按钮 */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
            {TIERS.map(tier => (
              <button key={tier} type="button" className="btn btn-sm" onClick={() => onTier(tier)}
                style={{ background: advTier === tier ? 'var(--accent)' : 'var(--surface)', color: advTier === tier ? '#fff' : 'var(--muted)', textTransform: 'capitalize' }}>
                {tier}
              </button>
            ))}
          </div>

          {/* 名片里一个参数都没描述时，说清是哪一种「没有」。
              静默画一个空面板会让人以为这台引擎调不了，实际部署里
              确实有 param_keys 有 12 个、params.schema 却是空的引擎。 */}
          {(() => {
            const gap = schemaGap(engine)
            return gap ? (
              <div style={{ fontSize: 12, color: 'var(--muted)', padding: '8px 0' }}>{gap.message}</div>
            ) : null
          })()}

          {/* 这里原本是两档共 13 个写死的 <input>。全部换成按
              engine.param_schema 循环，装一台谁都没见过的引擎，
              这段代码一个字都不用改（契约 §11 判据 9）。 */}
          {TIERS.map(tier => advTier === tier && (
            <div className="form-grid" key={tier}>
              {/* 五种预设样式全部走同一个 <ParamField>。
                  这里不许再出现 f.type === '...' 的分支：一旦分叉，
                     「换一台引擎，同一种参数长得不一样」就会回来，而且
                     以后生成出来的每台引擎的页面还会各自再抄一份。
                  候选项（select + source）由 selectOptions 扫盘给进来，
                  ParamField 不知道 voices/weights/audio 是什么。 */}
              {visibleFields(tier).map(f => (
                <ParamField key={f.name}
                  field={f}
                  values={paramValues}
                  onChange={onParam}
                  lang={uiLang}
                  options={selectOptions(f)}
                  t={t} />
              ))}

              {/* 平台自己的开关。它们不属于任何一台引擎，所以不在
                  param_schema 里，也就不能跟着上面那个循环长出来。
                  判据很简单：换一台引擎，这几格的含义一个字都不变。 */}
              {tier === 'common' && (
                <div>
                  <label className="field-label">Seed (-1 = random)</label>
                  <input type="number" className="control" value={seed} onChange={e => onSeed(parseInt(e.target.value) || -1)} />
                </div>
              )}
              {tier === 'common' && (
                <div>
                  {/* 强制重新推理。放 Common 档的依据是它比其他格子更基础。
                      它与同排其它格子不是一类东西：那些是引擎参数，会存进
                        /api/advanced-params；这一个是平台开关，存在浏览器本地
                        （generate.forceResynth），绝不进引擎参数表。 */}
                  {/* 走 ToggleField，跟名片长出来的那些勾选框是同一个组件。 */}
                  <ToggleField
                    label={t('Force re-synthesis', '强制重新推理')}
                    help={t('Ignore cached audio and re-run inference', '忽略缓存音频，重新执行推理')}
                    checked={forceResynth}
                    onChange={onForceResynth} />
                </div>
              )}
              {tier === 'advanced' && (
                <div title={t('Engine batch: send the whole text to the engine in ONE call and let the engine split and batch it itself, instead of the platform synthesising each segment one by one. Faster for long text; produces a single audio file with no per-segment files.', '引擎批量：整段文本一次性交给引擎，由引擎自己切分并批量推理，而不是由平台逐段合成。长文本更快；输出为单个音频、无分段文件。')}>
                  <ToggleField
                    label={t('Engine Batch (parallel)', '引擎批量并行')}
                    checked={engineBatch}
                    onChange={onEngineBatch} />
                </div>
              )}
              {tier === 'advanced' && (
                <div>
                  <label className="field-label">Media Type</label>
                  <Select className="control" value={mediaType} onChange={e => onMediaType(e.target.value)}>
                    <option value="wav">WAV</option>
                    <option value="ogg">OGG</option>
                    <option value="aac">AAC</option>
                    <option value="raw">RAW</option>
                  </Select>
                </div>
              )}
            </div>
          ))}

          {/* 这句话原本写死「发送给某一台引擎」。换一台引擎它还是那么说，
              界面公然告诉用户参数发去了一台他没选的引擎。名字问 engine 要。 */}
          <div className="field-hint" style={{ marginTop: 6 }}>
            {t(`These parameters are sent to ${engineName} for this generation only. They do not change the voice config.`,
               `这些参数仅用于本次生成并发送给 ${engineName}，不会更改语音配置。`)}
          </div>

          {/* Auxiliary Reference Audio — shared AuxReferencePicker ():
              This voice (Slices/Raw) · Another voice · Custom files, multi-select
              + audio preview. Identical interaction to Compare Refs.

              这一格是平台的词（aux_reference_audio），不是引擎参数，
                所以它不在 param_schema 里、不跟着上面那个循环长。它的开关
                在名片 maps 上：铺了映射才发得出去。
                之前无条件画：实际部署里有引擎的 maps 没有这一条，使用者
                照样选得出一堆辅助参考音频，然后它们被静默丢掉。 */}
          {hasAuxRefs && (
            <div style={{ marginTop: 10 }}>
              <label className="field-label">
                Auxiliary References
                <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--muted)', marginLeft: 6 }}>
                  {t(`(optional, multi-select${auxRefs.length > 0 ? ` · ${auxRefs.length} selected` : ''})`,
                     `（可选，多选${auxRefs.length > 0 ? ` · 已选 ${auxRefs.length} 项` : ''}）`)}
                </span>
              </label>
              <AuxReferencePicker
                voiceId={refVoiceId}
                voices={voices}
                value={auxRefs}
                mainRef={currentRefAudio}
                onAdd={p => onAuxRefAdd(p)}
                onRemove={i => onAuxRefRemove(i)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
