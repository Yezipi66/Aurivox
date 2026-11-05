// 第 4 步「推理入口」那一格的读写。纯函数，单独可测。
//
// 名片里没有专门的入口键：命令行形态写在 call.argv 的 -m 目标或脚本路径上，
// Python 类形态写在 call.module。这一格只把这三种写法摊成「一个可选可填的值」。
// 选中的是候选里的文件时，写进去的仍是模块名，工作目录按 src 布局一并定下；
// 直接输入的值按原样写，平台不替使用者改写他自己写的模块名。

const MODULE_TOKENS = ['_MODULE_', '__MODULE__']

function argvEntry (argv) {
  const mIdx = argv.indexOf('-m')
  if (mIdx >= 0 && mIdx + 1 < argv.length) {
    return { kind: 'module', index: mIdx + 1, value: String(argv[mIdx + 1]) }
  }
  const sIdx = argv.findIndex((w, i) => i > 0 && typeof w === 'string' && w.endsWith('.py'))
  if (sIdx > 0) return { kind: 'script', index: sIdx, value: String(argv[sIdx]) }
  return null
}

/**
 * @returns {{target:'argv'|'module', kind:'module'|'script', value:string}}
 */
export function readEntry (manifest) {
  const call = (manifest && manifest.call) || {}
  const argv = Array.isArray(call.argv) ? call.argv : []
  const hit = argvEntry(argv)
  if (hit) return { target: 'argv', ...hit }
  if (call.kind === 'python' || typeof call.module === 'string') {
    return { target: 'module', kind: 'module', value: typeof call.module === 'string' ? call.module : '' }
  }
  return { target: 'argv', kind: 'module', value: '' }
}

/** 输入框里显示的值：能对应到候选文件就显示文件，便于核对选的是哪一个。 */
export function displayEntry (manifest, candidates = []) {
  const cur = readEntry(manifest)
  if (!cur.value || MODULE_TOKENS.includes(cur.value)) return ''
  const hit = (Array.isArray(candidates) ? candidates : [])
    .find((c) => c && (c.file === cur.value || c.module === cur.value))
  return hit && hit.file ? hit.file : cur.value
}

/**
 * 写回名片。原对象不动。
 * 候选命中时写它声明的模块名，并按 srcRoot 设定 cwd；
 * 手输的值按原样写，cwd 保持使用者已经填过的那一份。
 *
 * @param {object} manifest
 * @param {string} shown 输入框里的值（文件路径、模块名或脚本路径）
 * @param {Array} candidates discover 回传的 entry_candidates
 * @param {string} engineId
 * @returns {object} 新名片
 */
export function writeEntry (manifest, shown, candidates = [], engineId = '') {
  const raw = String(shown == null ? '' : shown).trim()
  const hit = (Array.isArray(candidates) ? candidates : [])
    .find((c) => c && (c.file === raw || c.module === raw)) || null
  const isScript = !hit && raw.endsWith('.py')
  const target = hit ? (hit.module || hit.file) : raw

  const m = { ...(manifest || {}) }
  const call = { ...(m.call || {}) }
  const cur = readEntry(m)
  const useModule = cur.target === 'module'

  if (useModule) {
    if (target && !MODULE_TOKENS.includes(target)) call.module = target
    else delete call.module
  } else {
    const argv = Array.isArray(call.argv) ? [...call.argv] : ['{engine_python}']
    const value = target || '_MODULE_'
    const mIdx = argv.indexOf('-m')
    const sIdx = argv.findIndex((w, i) => i > 0 && String(w).endsWith('.py'))
    if (isScript) {
      if (mIdx >= 0) argv.splice(mIdx, 2)
      const again = argv.findIndex((w, i) => i > 0 && String(w).endsWith('.py'))
      if (again > 0) argv[again] = value
      else argv.splice(1, 0, value)
    } else if (mIdx >= 0) {
      argv[mIdx + 1] = value
    } else if (sIdx > 0) {
      argv.splice(sIdx, 1, '-m', value)
    } else {
      argv.splice(1, 0, '-m', value)
    }
    call.argv = argv
  }

  if (hit && engineId) {
    call.cwd = 'engines/' + engineId + (hit.srcRoot ? '/' + hit.srcRoot : '')
  }
  m.call = call
  return m
}
