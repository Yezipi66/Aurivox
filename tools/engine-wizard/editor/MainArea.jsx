import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import { Select } from '../../../web/src/components/common/Select'
// 名片字段的本地化走平台的 fieldLabel/fieldHelp（web/src/lib/engines.js）。
// 名片里 label 与 help 有两种写法：{en,zh} 对象或纯字符串，自己拼 `w.label || w.id`
// 会在对象写法下渲染出 [object Object]。
import { fieldLabel, fieldHelp } from '../../../web/src/lib/engines'

// 合成页主区域的无数据预览：按 GenerateTab 的真实结构画出同样的格子。
// 不 import GenerateTab：它是整页组件（音色库、参考音频切片、缓存、活动日志），
// 依赖后端数据，预览没有后端，import 它会把整个 web 的数据层拖进来。
// 形状由平台定，不由名片定：换一台引擎，这几行一个字都不变。
// 所以它只能预览，不能拿来推断名片该填什么。

export default function MainArea ({ manifest }) {
  const { t, lang } = useT()
  const weights = Array.isArray(manifest.weights) ? manifest.weights : []
  const caps = manifest.capabilities || {}

  return (
    /* 容器用项目现成的 .card，不自己画 */
    <div className="card">
      {/* 真界面里这一段没有标题，预览也不加：
             加一条只会让人多读一句话。*/}
      <div className="form-grid">
        // 音色：平台扫盘才有，这里显示形状
        <div>
          <label className="field-label">{t('Voice', '音色')}</label>
          <Select className="control" value="" onChange={() => {}} disabled>
            <option value="">{t('(populated at runtime)', '（运行时扫盘才有值）')}</option>
          </Select>
        </div>

        {/* 目标语言：语言名是平台词表里的固定内容，名片改不了，
             中英文两套都要给全，不能只翻一半。 */}
        <div>
          <label className="field-label">{t('Language', '目标合成语言')}</label>
          <Select className="control" value="auto" onChange={() => {}} disabled>
            <option value="auto">{t('Auto', '自动')}</option>
            <option value="zh">中文</option>
            <option value="yue">粤语</option>
            <option value="en">English</option>
            <option value="ja">日本語</option>
          </Select>
        </div>

        {/* 文本 */}
        <div style={{ gridColumn: '1 / -1' }}>
          <label className="field-label">{t('Text', '文本')}</label>
          <textarea className="control" rows={2} disabled
            placeholder={t('(fixed by the platform, not from the manifest)',
              '（平台固定，不来自名片）')} />
        </div>

        // 权重位：这一格的数量真的来自名片
        {weights.length > 0
          ? weights.map((w, i) => (
            <div key={i}>
              <label className="field-label" title={fieldHelp(w, lang)}>
                {fieldLabel(w, lang) || `${t('model slot', '模型位')} ${i + 1}`}
              </label>
              <Select className="control" value="" onChange={() => {}} disabled>
                <option value="">{t('(models in this slot)', '（该位已有的模型）')}</option>
              </Select>
              {w.applies_at === 'launch'
                ? (
                  <span className="badge badge-info"
                    title={t('applies_at=launch in the manifest means changing it restarts the engine',
                      '名片里 applies_at=launch ⇒ 换模型要重启引擎')}>
                    {t('changing it restarts the engine', '换它要重启引擎')}（launch）
                  </span>
                  )
                : (
                  <span className="badge badge-muted"
                    title={t('applies_at=call in the manifest means one request swaps it',
                      '名片里 applies_at=call ⇒ 发一次请求就换')}>
                    {t('changeable at run time', '运行时可换')}（call）
                  </span>
                  )}
            </div>
          ))
          : (
            <div style={{ gridColumn: '1 / -1' }}>
              <label className="field-label">{t('Model slot', '模型位')}</label>
              <p className="field-hint" style={{ marginTop: 0 }}>
                {t('This engine has no user-selectable weight slot (weights is empty). '
                  + 'Simply leave weights out of the manifest.',
                  '该引擎没有可供选择的权重位（weights 为空），Manifest 中不声明 weights 即可')}
              </p>
            </div>
            )}

        // 参考音频：只有声明了才出现
        {caps.requires_reference_audio && (
          <div style={{ gridColumn: '1 / -1' }}>
            <label className="field-label">{t('Reference audio', '参考音频')}</label>
            <p className="field-hint" style={{ marginTop: 0 }}>
              {t('the manifest sets capabilities.requires_reference_audio = true',
                '名片里 capabilities.requires_reference_audio = true')}
              {' '}
              {t('but the platform only has one global switch — if this engine needs '
                + 'it per method, the manifest cannot express that.',
                '但平台只有一个总开关，若该引擎的不同方法需求不同，'
                + '名片表达不了。')}
            </p>
          </div>
        )}
      </div>

      <p className="msg msg-info" style={{ marginBottom: 0, marginTop: 12 }}>
        {t('Notice: the shape above is decided by the platform. Switching engines '
          + 'does not change a single character of it. Only the “Advanced Settings” '
          + 'block below comes from the manifest.',
          '注意：以上格子的形式由平台决定，更换引擎时不会发生变化。'
          + '只有下面 Advanced Settings 里的格子来自名片。')}
      </p>
    </div>
  )
}
