// 界面上「有哪些模型可用」的取数层。
//
// ⭐⭐ 只做一件事：把后端算好的清单**取回来**。清单里有什么、按什么筛，
//   一律在 modelPickers.pure.js 里（纯函数，可以直接跑测试）。
//   这里不许出现任何引擎的名字、任何模型位的名字、任何路径长相的判断。
//
// 2026-08-30 改造前这个文件是这样的（记下来是为了别再走回去）：
//   * 一条正则认路径 assets/<角色>/gpt_checkpoints|sovits_models/ —— 把一台
//     引擎的目录名焊进了前端；
//   * 一条正则靠**底模的版本目录名**认「这是不是底模」—— 用户换个底模目录
//     就认错，而且第二台引擎的底模长什么样它压根不知道；
//   * gptGroups / sovitsGroups 两个函数 —— 界面上写死两个下拉的根源。
//   现在：谁是谁看它**在不在候选清单里**（ownerOfPath），下拉几个看**名片**。
import { useState, useEffect } from 'react'
import { api } from './api'

// ⚠ 同一个模块里的 import 必须带 .js 后缀（Vite + node --test 两边都要能跑，
//   见 engines.js 顶部那段注释）。
import { assetIdFromModelPath } from './modelPickers.pure.js'

// 内置底模在清单里是一个「虚拟角色」的 id。它盘上没有目录，但在每台引擎的
// 每个下拉里都该出现 —— 底模是**来源无关**的：官方发的、社区微调的、用户
// 自己手放进去的，平台一律当候选，永远不问是谁训的。
export const BASE_VOICE_ID = '__base__'

// 从一个模型路径倒推它属于哪个角色（Rerun / 恢复选择时用来回填角色）。
// 底模不在 assets/ 下 ⇒ 这里返回 ''。
// ⭐ 判「这是不是底模」不要用路径长相，用 ownerOfPath(候选清单, 路径)。
export { assetIdFromModelPath }

/**
 * 一次性取回「谁有哪些模型」的整份清单。
 *
 * 返回：[{ voiceId, displayName, builtin?, engines:[引擎id], models:{引擎:{位:[…]}} }]
 * 内置底模是其中一条 builtin:true 的记录，排在最前。
 *
 * ⭐ 这是界面上**唯一**的模型来源。⛔ 不许再有第二处去 meta 里翻。
 */
export function useAssetsWithModels() {
  const [assets, setAssets] = useState([])
  useEffect(() => {
    let cancelled = false
    api('/api/assets/voices-with-models').then(r => {
      if (cancelled) return
      setAssets((r.ok && r.data && r.data.voices) ? r.data.voices : [])
    }).catch(() => { if (!cancelled) setAssets([]) })
    return () => { cancelled = true }
  }, [])
  return assets
}

/**
 * 取回单个角色的完整 meta（有些界面要的不只是模型：素材数量、参考文本状态…）。
 *
 * ⚠ 加载中返回的是**空的**（不是上一个角色的），这样「等清单到齐再对齐选择」
 *   的那些地方才不会拿旧角色的清单去判断新角色的选择有没有失效。
 */
export function useAssetMeta(voiceId) {
  const [meta, setMeta] = useState(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!voiceId) { setMeta(null); return }
    let cancelled = false
    setLoading(true)
    setMeta(null)
    api(`/api/assets/${voiceId}`).then(r => {
      if (cancelled) return
      setMeta((r.ok && r.data && r.data.ok && r.data.meta) ? r.data.meta : null)
    }).catch(() => { if (!cancelled) setMeta(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [voiceId])
  return { meta, loading }
}
