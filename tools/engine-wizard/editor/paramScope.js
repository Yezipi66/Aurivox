// 参数池收窄：认出推理入口后，左栏只列入口文件里的参数。纯函数，单独可测。
//
// 判据落在入口文件上，不按目录名排除：上游把训练、微调脚本放进 train/ 只是习惯，
//   不是契约。按目录名过滤既会漏掉放在别处的推理参数，也挡不住放在别处的训练参数。
// 入口文件本身没有参数（薄 __main__ 只做转调）时退到它所在目录；再没有才保留全部，
//   这时不报错也不提示：扫不到依据就照旧给全量，比给一个空的池子有用。
// 收窄只改变左栏可拖的源，不改变 /wizard/discover 的返回，也不写进名片。

const SEP = /[\\/]+/

/**
 * 路径归一：反斜杠折成正斜杠、去掉 ./ 前缀、统一小写。
 * 上游给的是相对路径，平台不做绝对化，两侧都按同一口径比。
 */
export function normFile (value) {
  return String(value == null ? '' : value)
    .replace(SEP, '/')
    .replace(/^\.\//, '')
    .toLowerCase()
}

function dirOf (file) {
  const i = file.lastIndexOf('/')
  return i < 0 ? '' : file.slice(0, i + 1)
}

/**
 * @param {Array} params 扫描到的参数，每项可能带 source_file
 * @param {string} entryFile 推理入口文件
 * @returns {{params: Array, outside: number, basis: 'entry'|'dir'|'all'}}
 *   outside 是被收窄掉的数量；basis 说明依据：entry 入口文件、dir 入口所在目录、all 未收窄。
 */
export function scopeParams (params, entryFile) {
  const list = Array.isArray(params) ? params.filter(Boolean) : []
  const file = normFile(entryFile)
  if (!file) return { params: list, outside: 0, basis: 'all' }

  const inFile = list.filter((p) => normFile(p.source_file) === file)
  if (inFile.length) {
    return { params: inFile, outside: list.length - inFile.length, basis: 'entry' }
  }

  const dir = dirOf(file)
  if (dir) {
    const inDir = list.filter((p) => normFile(p.source_file).startsWith(dir))
    if (inDir.length) {
      return { params: inDir, outside: list.length - inDir.length, basis: 'dir' }
    }
  }

  return { params: list, outside: 0, basis: 'all' }
}
