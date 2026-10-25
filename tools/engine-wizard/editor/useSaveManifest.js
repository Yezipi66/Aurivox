import React from 'react'

// 保存名片：原 SaveBar 里的那段逻辑，拆成 hook 交给中栏的身份条用。
//
// 为什么不再是一条吸底的栏：保存是「这张名片」的动作，
//   和「选引擎 / 扫描参数 / 读取参数」是同一行里的一串动作，
//   摆在页面最下面一条孤零零的栏里，跟上面三栏都不对齐。
//
// 覆盖语义：磁盘上已经有名片 ⇒ 用户是先「读取参数」把它读进来、改完再存的，
//   这一步本来就是覆盖，不再弹二次确认（后端 save.js 覆盖前会留一份备份）。
//   磁盘上没有 ⇒ 新建，带 allowCreateDir。
//
// 本模块只导出 hook，不导出组件：组件模块与 hook 混在一个文件里会让
//   Fast Refresh 失效（见 editorModuleShape 守卫）。

/**
 * @param {object} manifest 当前名片
 * @param {boolean} existsOnDisk 磁盘上是否已有这台引擎的名片
 * @param {Function} onSaved 保存成功回调
 * @returns {{save: Function, busy: boolean, result: object|null}}
 */
export function useSaveManifest (manifest, existsOnDisk, onSaved) {
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState(null)

  // 换了引擎，上一台的保存结果就不该挂在这一台上。
  const id = manifest && manifest.id
  React.useEffect(() => { setResult(null) }, [id])

  const save = async () => {
    if (!id) return
    setBusy(true); setResult(null)
    try {
      const r = await fetch('/wizard/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest, overwrite: !!existsOnDisk, allowCreateDir: true }),
      })
      const j = await r.json()
      setResult(j)
      if (j.ok && onSaved) onSaved(j)
    } catch (e) {
      setResult({ ok: false, error: e.message })
    } finally {
      setBusy(false)
    }
  }

  return { save, busy, result }
}
