import React from 'react'

// 保存 Manifest 的 hook，由中栏身份条调用：保存与「选引擎 / 扫描 / 读取」是同一行里的
// 一串动作，不再单独摆一条吸底的栏。
//
// 盘上已有 Manifest ⇒ 是读进来改完再存，这一步本来就是覆盖，不再弹二次确认；
// 盘上没有 ⇒ 新建，带 allowCreateDir。
//
// 本模块只导出 hook：组件与 hook 混在一个文件里会让 Fast Refresh 失效。

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
