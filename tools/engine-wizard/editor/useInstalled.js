import React from 'react'

// ---------------------------------------------------------------------------
//  已装引擎的清单 + 读一张名片**原文**
//
//  ⛔ 不直接用平台的 /api/engines：那个端点返回解析后的 profile
//    （参数已派生成 5 份视图、_comment_* 已剥掉、路径已变绝对路径）。
//    拿它当「名片原文」回填，等于把派生结果当事实写回去。
//    编辑一份名片要的是磁盘上那份原文。
//
//  ⛔ 本文件不许出现任何具体引擎名。
// ---------------------------------------------------------------------------

export function useInstalled () {
  // ⛔ 不解构 useT()：它返回对象 {lang, setLang, t} 而非函数，
  //   写成 useT()() 得到 undefined，调用时报"t is not a function"，整页白屏。
  //   这里用不到 t，所以干脆不解构。
  const [installed, setInstalled] = React.useState([])

  const loadInstalled = React.useCallback(() => {
    fetch('/wizard/installed').then((r) => r.json())
      .then((j) => setInstalled(j.engines || []))
      .catch(() => { /* 拿不到就空着，不报错 */ })
  }, [])

  React.useEffect(() => { loadInstalled() }, [loadInstalled])

  /**
   * 读一张已装引擎的名片**原文**。
   * @returns {Promise<{ok:boolean, text?:string, error?:string, code?:string}>}
   */
  const loadOne = React.useCallback(async (id) => {
    try {
      const r = await fetch(`/wizard/manifest/${encodeURIComponent(id)}`)
      const j = await r.json()
      if (!r.ok || j.error) {
        return { ok: false, error: j.error || `HTTP ${r.status}`, code: j.code }
      }
      // ⛔ 原文可能带 _comment_*；回填给表单时保留它们，
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