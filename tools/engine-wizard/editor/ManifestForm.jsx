// 名片表单编辑器：根据 fieldmeta 分组渲染字段输入，并把值交给调用方处理。
// 渲染只依赖项目现有的 UI 组件与类名，不自造字段含义。
// 本文件不负责合成逻辑，只负责界面层的输入与结构。
import React from 'react'
import { useT } from '../../../web/src/lib/i18n'
import OptionalConfig from './OptionalConfig'
import RequiredFields from './RequiredFields'
import ParamDropZone from './ParamDropZone'
import ParamRow from './ParamRow'
import { shouldAutoFillCheckpoints, withAutoFilledCheckpoints } from './manifestAutoFill'

// 名片填表：两个区。
//   ① 必填字段：5 格（RequiredFields）。
//   ② 可选参数：合成参数（ParamDropZone）+ 引擎配置（OptionalConfig）。
// 渲染只用项目已有的类，不自造 mf-* / pr-*。

// 从源码反射生成 parameters[] 草稿 + 映射候选（第 4 步）。
// 只填表单，不直接写 manifest.json；映射候选只给候选，人点选之后才写 maps。

// 主组件操作流：
// ① 必填字段：call.bind 三槽位 + 引擎目录 + 启动脚本，两行。
// ② 可选参数：左栏扫到的参数拖进来成为 parameters[]；下面是平台有默认的引擎配置。
//
// 扫描发生在左栏（EngineScanZone），扫描结果由页面层持有并传进来。
export default function ManifestForm ({
  manifest, onChange, spec, checkpointsPath, autofill, selectedParam,
  guessed, onParamDropped, onTypeConfirmed,
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
    onChange(withAutoFilledCheckpoints(manifest, checkpointsPath))
    // onChange 不进依赖：它每次渲染都是新函数，进了就变成一直触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkpointsPath, manifest && manifest.id, manifest && manifest.runtime && manifest.runtime.checkpoints])

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

      {/* ② 可选参数：合成参数（左栏扫到的参数拖进来，生成页上给用户调的旋钮）
          + 引擎配置（平台有默认、要改才添加的那几项，用户在生成页看不到）。
          以前的「高级」折叠区整段去掉：前面几步已经定下的不再在这里重复一份，
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
