import React from 'react'
import { useT } from '../../../web/src/lib/i18n'

// 全局逃生口：选择向导作用在哪台引擎目录上。
//
// 之前顶部有一个「当前引擎」下拉，但「当前」读起来像状态，而它实际是
// 自由切换的全局目标选择器（绑 wz.id，完成状态、权重路径、会话段、名片
// 编辑对象全跟它走），逻辑和心智对不上。改成在每一步（除第 1 步）各放一个
// 同样的下拉，明确它是「操作哪台」的选择器，切换即全局重定向。
//
// 只渲染一个下拉（一列），不套第二列：选择器与逃生口是同一个东西。
// dirs 由外层传入（App 已用 useEngineDirs 取过一次，不重复请求）。
// onPick(id) 由外层决定怎么落（App 里就是 setWz({...cur, id})）。

export default function EngineEscapeHatch ({ id, dirs, onPick }) {
  const { t } = useT()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <label className="field-label" style={{ margin: 0 }} htmlFor="wz-escape-pick">
        {t('Engine target', '操作引擎')}
      </label>
      <select id="wz-escape-pick" className="control" style={{ minWidth: 240 }}
        value={id || ''}
        onChange={(e) => onPick(e.target.value)}>
        <option value="">
          {t('Pick a directory under engines/', '选择 engines/ 下的目录')}
        </option>
        {(dirs || []).map((d) => (
          <option key={d.id} value={d.id}
            style={d.usable ? { color: '#4caf50', fontWeight: 600 } : undefined}>
            {d.usable ? '✓ ' : ''}{d.id}
            {d.manifestPresent ? ` · ${t('manifest', '有名片')}` : ''}
          </option>
        ))}
      </select>
      <span className="field-hint" style={{ margin: 0 }}>
        {t('Escape hatch: switch to any engine under engines/. Every step follows this target.',
          '逃生口：可切到 engines/ 下的任意一台，向导每一步都作用于这台。')}
        {' '}
        {t('A green check marks an engine that is usable (has a valid manifest and weights ready).',
          '绿勾 = 这台能用（有名片且底模就绪）。')}
      </span>
    </div>
  )
}
