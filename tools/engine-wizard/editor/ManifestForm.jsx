// Manifest 表单编辑器：按 fieldmeta 分组渲染输入，值交给调用方。只做界面层的输入与
// 结构，不做合成逻辑、不写 manifest.json；渲染只用项目已有的类与组件，不自造 mf-* / pr-*。
//
// 两区：① 必填字段 6 格（RequiredFields）；② 可选参数：合成参数（ParamDropZone）+
// 引擎配置（OptionalConfig）。扫描发生在左栏 EngineScanZone，结果由页面层传进来。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import OptionalConfig from './OptionalConfig'
import RequiredFields from './RequiredFields'
import EntryChoice from './EntryChoice'
import ParamDropZone from './ParamDropZone'
import ParamRow from './ParamRow'
import { shouldAutoFillCheckpoints, withAutoFilledCheckpoints } from './manifestAutoFill'
import {
  shouldFillModelsRequired, withModelsRequired, requiredFromFiles,
  shouldFillVerify, withAutoFilledVerify,
} from './declarationFill'

// 反射生成的 parameters[] 草稿与映射候选只填表单，映射候选要人点选之后才写进 maps。
export default function ManifestForm ({
  manifest, onChange, spec, checkpointsPath, autofill, selectedParam,
  guessed, onParamDropped, onTypeConfirmed, modelFiles, entryCandidates,
}) {
  const { t } = useT()

  // runtime.checkpoints 自动填成第 3 步的下载落点。
  //
  // 为什么自动填：第 3 步把权重下到哪儿是后端定的（core/checkpointsPath.js），
  //   第 4 步的名片要声明同一处。不自动填的话，使用者得自己把这两个界面里的
  //   路径对上，而两个路径长得极像（engines/<id>/checkpoints 与 models/tts/<id>），
  //   填错时当场没有报错，症状是「第 3 步说下好了、第 5 步说目录不存在」。
  //
  // 只在两个条件下填：引擎 id 已经定了（否则算不出路径），且这一格要么空着，
  //   要么指着一台别的引擎（换引擎时留下的上一台残留）。
  //   使用者填过、指的又是当前这台，就不动他填的。
  //   落盘路径由后端送来，前端不自己拼。
  // 判定与填值在 manifestAutoFill.js 里，是纯函数，可以单独测。
  React.useEffect(() => {
    if (!shouldAutoFillCheckpoints(manifest, checkpointsPath)) return
    // 交函数，基于最新名片合并：同一次提交里 RequiredFields 也在代填 runtime，
    //   拿快照整份写回会把它刚写的引擎目录与启动脚本冲掉。
    onChange((cur) => (shouldAutoFillCheckpoints(cur, checkpointsPath)
      ? withAutoFilledCheckpoints(cur, checkpointsPath) : cur))
    // onChange 不进依赖：它每次渲染都是新函数，进了就变成一直触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkpointsPath, manifest && manifest.id, manifest && manifest.runtime && manifest.runtime.checkpoints])

  // models.required 自动填成第 3 步实际下到盘上的文件清单。
  //
  // 为什么自动填：不声明 required，平台只能说「权重目录在不在」，
  //   说不出「齐不齐」（checkpoints.js 的 ready:null）。齐不齐的判据
  //   就是「声明的文件是不是一个不少」，而声明素材使用者刚下过一遍：
  //   下过什么就声明什么（剔掉 README / 校验和这类杂质）。
  // 只在 id 定了、盘上有可声明的文件、且这一格空着时填：
  //   使用者声明过（哪怕只写一个文件）是他的判断，不覆盖。
  // 判定与填值在 declarationFill.js 里，是纯函数，可以单独测。
  React.useEffect(() => {
    if (!shouldFillModelsRequired(manifest, modelFiles)) return
    // 交函数，基于最新名片合并：同一次提交里别的自动填也在写名片，
    //   拿快照整份写回会冲掉别人刚写的段。
    onChange((cur) => (shouldFillModelsRequired(cur, modelFiles)
      ? withModelsRequired(cur, requiredFromFiles(modelFiles)) : cur))
    // onChange 不进依赖：它每次渲染都是新函数，进了就变成一直触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelFiles, manifest && manifest.id, manifest && manifest.models && manifest.models.required])

  // runtime.verify 自动填：sys_path 与 imports 两格。
  //
  // 为什么自动填：verify 是「拿这台引擎的解释器 import 哪些模块」的第二道校验，
  //   空着时 env_deep 没有 spec 可验（起不起来永远「说不出来」）。
  //   imports 照 call 段已定下的模块（module-only，env_probe 认的最小形状）；
  //   sys_path 按克隆根猜（src 布局的引擎要改），猜得对不对由第 5 步 env_deep 兜底。
  // 各自只填空格：使用者或扫描写过的（sys_path 或 imports 非空）不覆盖。
  React.useEffect(() => {
    if (!shouldFillVerify(manifest)) return
    onChange((cur) => (shouldFillVerify(cur) ? withAutoFilledVerify(cur) : cur))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest && manifest.id, manifest && manifest.call,
    manifest && manifest.runtime && manifest.runtime.verify])

  if (!spec) {
    return <p className="field-hint" style={{ margin: 0 }}>
      {t('Loading field spec…', '正在读字段规格…')}
    </p>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* ① 必填字段：三个输入槽位一行，引擎目录与启动脚本一行 */}
      <RequiredFields manifest={manifest} onChange={onChange} autofill={autofill}
        bindSlots={spec && spec.bindSlots} />

      {/* 推理入口：扫描认不出时从候选清单里选，或直接输入。它决定 call.argv 里
          跑的是哪个模块或脚本，与下面的合成参数是两件事，单独占一段。 */}
      <EntryChoice manifest={manifest} onChange={onChange}
        candidates={entryCandidates || []} />

      {/* ② 可选参数：合成参数（左栏扫到的参数拖进来，生成页上给用户调的旋钮）
          + 引擎配置（平台有默认、要改才添加的那几项，用户在生成页看不到）。
          这里只放合成参数与引擎配置两类，前面几步已定下的不再重复一份，
          要改它们走 JSON 视图。 */}
      <ParamDropZone manifest={manifest} onChange={onChange}
        params={manifest.parameters || []} selectedParam={selectedParam}
        spec={spec} ParamRow={ParamRow}
        guessed={guessed} onParamDropped={onParamDropped}
        onTypeConfirmed={onTypeConfirmed}>
        <OptionalConfig manifest={manifest} onChange={onChange} />
      </ParamDropZone>
    </div>
  )
}
