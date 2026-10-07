// ============================================================================
//  第 5 步（verify）—— ⛔ 暂未实现，见下方说明。
//
//  ⛔⛔ 现行实现是**错的**，已移除。原因有三，每条都实测过：
//
//  ① 判定逻辑错：useEffect 在进入本页时自动跑一遍前三道，并把
//     `verified: true` 无条件上报（StepsExtra.jsx 旧 :262）。
//     而 steps.js 的 stepDone('verify') 判的就是 facts.verified
//     ⇒ **点进这一步就变对勾**，哪怕四项全错。
//     verifyOk 明明已经算出来，却只用于显示、不参与「完成」判定。
//
//  ② 形状错：这里做的是「四道校验」（装没装 / 起不起来 / 权重齐不齐 /
//     出不出声），而 docs/ENGINE_ADOPTION_FLOW.md §四 的裁决是
//     **三块互不依赖的结果**（引擎起没起+状态码 / 音频→复用 Player /
//     ASR 回读），⛔ 且明确「不绑成一个必须全过的门」。
//     两者的分组、单位、结论语义都不一样。
//
//  ③ 依赖阻塞：第二块要复用 web/src/components/common/Player.jsx 出波形，
//     而 verify_audio.py 目前只回报 wav_bytes 数字就丢掉了音频本体
//     ⇒ 波形无数据可画。根因在 lib/engines/，不在本树。
//
//  ⛔ 所以这里只留一个诚实的占位：**不请求、不上报 verified**，
//  ⇒ 这一步不会自己变成对勾。实现见 docs/ENGINE_ADOPTION_FLOW.md §四。
//
//  ⛔ 本文件不许出现任何具体引擎名。
// ============================================================================

import React from 'react'
import { useT } from '../../../web/src/lib/i18n'

export function StepVerify () {
  const { t } = useT()
  return (
    <div className="msg msg-info" style={{ marginBottom: 0 }}>
      {t('This step is not implemented yet.',
        '本步骤尚未实现。')}
      <div className="field-hint">
        {t('Planned content: whether the engine starts and its exit code, '
          + 'the synthesised audio, and the ASR read-back. The three are '
          + 'independent and none of them blocks the others.',
        '计划包含三项：引擎能否启动及其退出码、合成音频、ASR 回读。'
        + '三项互不依赖，任何一项未通过都不影响其余两项。')}
      </div>
    </div>
  )
}
