import React from 'react'

// 保存 Manifest 的 hook，由中栏身份条调用：保存与「选引擎 / 扫描 / 读取」是同一行里的
// 一串动作，不再单独摆一条吸底的栏。
//
// 一律允许覆盖：这一格本来就是「读进来、改完、存回去」，盘上有没有名片都该存得下去。
//   从前按「打开页面时盘上有没有名片」决定让不让覆盖，那个结论是加载时的快照：
//   名片是这之后新建/别处写进来的，快照还说没有，于是第一次存得进、之后每次都报
//   「已存在，且未请求覆盖」。
//   覆盖的危险由服务端兜：写盘前先把旧名片复制成 manifest.<时间戳>.bak，留最近 5 份。
//
// 本模块只导出 hook：组件与 hook 混在一个文件里会让 Fast Refresh 失效。

/**
 * @param {object} manifest 当前名片
 * @param {Function} onSaved 保存成功回调
 * @returns {{save: Function, busy: boolean, result: object|null}}
 */
export function useSaveManifest (manifest, onSaved) {
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState(null)

  // 换了引擎，上一台的保存结果就不该挂在这一台上。
  const id = manifest && manifest.id
  React.useEffect(() => { setResult(null) }, [id])

  // 最新名片跟着渲染走。save 被一次「先扫描、再保存」的流程调用时，扫描结果写回
  //   父层状态之后才轮到保存：闭包里那份 manifest 是调用那一刻的旧值，存下去就是
  //   一张没有扫描结果的名片。读 ref 才能拿到刚刚写回的那一份。
  const latest = React.useRef(manifest)
  latest.current = manifest

  const save = async () => {
    const card = latest.current
    if (!card || !card.id) return
    setBusy(true); setResult(null)
    try {
      const r = await fetch('/wizard/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: card, overwrite: true, allowCreateDir: true }),
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
