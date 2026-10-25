import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import CoreBindings from './CoreBindings'
import RequiredEight from './RequiredEight'

// 必填字段：原来的「核心映射」+「必填 8 项」合成一个区。
//
// 两者是同一件事：缺任何一格，这张名片都接不上平台。
//   核心输入（text / ref_audio / output_path）缺了 ⇒ 平台的三个输入没处去；
//   8 项缺了 ⇒ lib/engines/profile.js 加载时直接抛错。
//   拆成两个区、一个叫「映射」一个叫「必填」，读起来像是两类不同重要性的东西。
//
// 区内分两小段，各用一行小标题，不再各自套一层 .section。
//
// TODO(骨架)：
//   - 平台能预填的格子（runtime.python = 第 2 步的 venv、runtime.checkpoints = 第 3 步的落点、
//     contract_version）在这里标「平台已填」，而不是让人对着空格猜。
//   - 每格的完成度徽标（已填 / 缺），区头给「还差 N 项」。

export default function RequiredFields ({ manifest, onChange, autofill }) {
  const { t } = useT()
  const setCall = (call) => onChange({ ...manifest, call })

  return (
    <div className="section">
      <div className="section-hdr"><h2>{t('Required fields', '必填字段')}</h2></div>
      <div className="section-body">
        <h3 className="wz-subhead">{t('Core inputs', '核心输入')}</h3>
        <CoreBindings bare call={manifest.call} onChange={setCall}
          candidates={(autofill && autofill.argList) || []}
          matched={(autofill && autofill.matched) || null}
          scanned={!!autofill} />

        <h3 className="wz-subhead">{t('Runtime and capabilities', '运行与能力')}</h3>
        <RequiredEight bare manifest={manifest} onChange={onChange} />
      </div>
    </div>
  )
}
