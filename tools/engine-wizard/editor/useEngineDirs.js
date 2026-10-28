import React from 'react'

// 列出 engines/ 下的全部目录，并标出哪些已经有名片。
//
// 单独一个文件：组件与 hook 混在一个模块里，改组件会让整个模块重新加载，
// 编辑时的状态全丢。

/**
 * 统一的引擎下拉的数据源。
 *
 * @returns {{dirs: Array, reload: Function}} dirs 的每一项是
 *   {id, manifestPresent, idMatchesDir} 形状
 */
export function useEngineDirs () {
  const [dirs, setDirs] = React.useState([])
  const reload = React.useCallback(() => {
    fetch('/wizard/installed?all=1').then((r) => r.json())
      .then((j) => setDirs(j.engines || []))
      .catch(() => { /* 拿不到就空着，不报错 */ })
  }, [])
  React.useEffect(() => { reload() }, [reload])
  return { dirs, reload }
}

export default useEngineDirs
