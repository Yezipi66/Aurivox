// 必填区「模型权重」那一格的读写。纯函数，单独可测。
//
// 名片里没有专门的「权重」键：权重怎么交给引擎，本来就写在调用方式里。
//   python 形态 ⇒ call.init_args 里值带 {checkpoints} 的那一项（构造引擎时传进去）
//   cli 形态    ⇒ call.argv 里「开关 + 带 {checkpoints} 的词」那一对
//   引擎自己找  ⇒ call.weights = "self"
// 这一格只是把这三种写法摊成「参数名 + 值」两个输入框和一个勾选，不另存一份。
// 判据（缺没缺）在平台 hostProfile.js 的 weightsProblem，这里不重写。

export const TOKEN = '{checkpoints}'

const has = (v) => typeof v === 'string' && v.includes(TOKEN)

/**
 * @param {object} call 名片的 call 段（可为空）
 * @returns {{ self: boolean, name: string, value: string }}
 */
export function readWeights (call) {
  const c = call || {}
  if (c.weights === 'self') return { self: true, name: '', value: '' }
  if ((c.kind || 'python') === 'cli') {
    const argv = Array.isArray(c.argv) ? c.argv : []
    const i = argv.findIndex(has)
    if (i < 0) return { self: false, name: '', value: '' }
    const prev = i > 0 ? String(argv[i - 1]) : ''
    return { self: false, name: prev.startsWith('-') ? prev : '', value: argv[i] }
  }
  const init = (c.init_args && typeof c.init_args === 'object') ? c.init_args : {}
  const key = Object.keys(init).find((k) => has(init[k]))
  if (!key) return { self: false, name: '', value: '' }
  return { self: false, name: key, value: init[key] }
}

/**
 * 写回 call 段。原对象不动。
 * - self=true：写 call.weights="self"，并去掉原来那一项权重参数（两种说法不能同时在）。
 * - name 为空：只去掉原来那一项（这一格清空了）。
 * - 其余：原来那一项换成 name = value（value 空就用 {checkpoints}）。
 *
 * @param {object} call
 * @param {{ self?: boolean, name?: string, value?: string }} next
 * @returns {object} 新的 call 段
 */
export function writeWeights (call, next) {
  const c = { ...(call || {}) }
  const cur = readWeights(c)
  const name = String((next && next.name) || '').trim()
  const value = String((next && next.value) || '').trim() || TOKEN
  delete c.weights

  if ((c.kind || 'python') === 'cli') {
    let argv = Array.isArray(c.argv) ? [...c.argv] : []
    const i = argv.findIndex(has)
    if (i >= 0) {
      const withFlag = cur.name && i > 0 && argv[i - 1] === cur.name
      argv.splice(withFlag ? i - 1 : i, withFlag ? 2 : 1)
    }
    if (!(next && next.self) && name) argv = [...argv, name, value]
    c.argv = argv
  } else {
    const init = { ...((c.init_args && typeof c.init_args === 'object') ? c.init_args : {}) }
    if (cur.name) delete init[cur.name]
    if (!(next && next.self) && name) init[name] = value
    if (Object.keys(init).length) c.init_args = init
    else delete c.init_args
  }
  if (next && next.self) c.weights = 'self'
  return c
}
