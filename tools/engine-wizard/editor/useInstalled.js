import React from 'react'

//  不直接用 /api/engines：那个端点返回派生结果，当「名片原文」回填 = 派生当事实。

export function useInstalled () {
  // 不解构 useT()：它返回对象 {lang, setLang, t} 而非函数，
  //   写成 useT()() 得到 undefined，调用时报"t is not a function"，整页白屏。
  const [installed, setInstalled] = React.useState([])

  const loadInstalled = React.useCallback(() => {
    fetch('/wizard/installed').then((r) => r.json())
      .then((j) => setInstalled(j.engines || []))
      .catch(() => { /* 拿不到就空着，不报错 */ })
  }, [])

  React.useEffect(() => { loadInstalled() }, [loadInstalled])

  const loadOne = React.useCallback(async (id) => {
    try {
      const r = await fetch(`/wizard/manifest/${encodeURIComponent(id)}`)
      const j = await r.json()
      if (!r.ok || j.error) {
        return { ok: false, error: j.error || `HTTP ${r.status}`, code: j.code }
      }
      // 原文可能带 _comment_*；回填给表单时保留它们，
      //    存盘那一步会剥掉（save.js 的第 6 步）。
      //    ⇒ 不能在这里剥，否则「读回来再存」会把注释吃掉。
      return { ok: true, text: JSON.stringify(j.manifest, null, 2), path: j.path }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }, [])

  return { installed, loadInstalled, loadOne }
}

export default useInstalled