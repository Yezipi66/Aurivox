// 「可复现性（seed）」那一格的读写。纯函数，单独可测。
//
// 名片里 call.seed 只有三种合法写法（契约 §5.2.1）：
//   "none"                             不可复现，宿主拒收 seed
//   { arg: "<参数名>" }                 引擎自己收，宿主把种子塞进这个参数名
//   { mode: "global", rngs: [...] }    宿主播全局随机源（只对 kind="python" 有效）
//
// 两种 kind 的「参数名」不是同一种东西，这一层必须分开写：
//   python  写的是方法的关键字参数名（kwargs[arg] = seed）
//   cli     写的是 **call.args 里的键**：宿主把种子塞进 params[arg]，
//           再由 build_cli_argv 用 call.args[arg].flag 拼成 `--seed 42`。
//           ⇒ 只写 call.seed 而不补 call.args，合成时会直接报「参数没有在
//             call.args 里说明该变成哪个命令行开关」，属于必然失败。
//           界面上让人填开关（--seed），落盘时补出一条 args 并把它折算成键。

const RNGS = ['python', 'numpy', 'torch', 'torch.cuda']

/** 界面上该显示哪一种（缺省按「不可复现」显示，但写盘要显式补上）。 */
export function seedModeOf (call) {
  const spec = call && call.seed
  if (spec === undefined || spec === null || spec === 'none') return 'none'
  if (spec && spec.arg !== undefined) return 'arg'
  if (spec && spec.mode === 'global') return 'global'
  return 'none'
}

/** 界面上那一格的值：cli 显示开关（--seed），python 显示参数名（seed）。 */
export function seedArgText (call) {
  const spec = call && call.seed
  const arg = spec && spec.arg !== undefined ? String(spec.arg) : ''
  if (!arg) return ''
  const kind = (call && call.kind) || 'python'
  if (kind !== 'cli') return arg
  const entry = ((call.args || {})[arg]) || null
  return (entry && entry.flag) || ('--' + arg)
}

/** 已勾选的随机源。 */
export function seedRngsOf (call) {
  const spec = call && call.seed
  return spec && Array.isArray(spec.rngs) ? spec.rngs.slice() : []
}

/** 随机源白名单，与 host.py 的 _RNG_TABLE 同一份。 */
export function seedRngNames () {
  return RNGS.slice()
}

const flagToKey = (text) => String(text || '').trim()
  .replace(/^-+/, '').replace(/-/g, '_').toLowerCase()

/**
 * 写「种子怎么传」。
 * @param {object} call 名片 call 段
 * @param {'none'|'arg'|'global'} mode
 * @returns {object} 新的 call 段（原对象不动）
 */
export function withSeedMode (call, mode) {
  const c = { ...(call || {}) }
  const args = { ...(c.args || {}) }
  const prev = c.seed
  if (mode === 'arg') {
    const text = seedArgText(c) || '--seed'
    if ((c.kind || 'python') !== 'cli') {
      // python 形态的参数名就是方法关键字，不经过命令行，也就没有 args 表。
      c.seed = { arg: flagToKey(text) }
      return c
    }
    const key = flagToKey(text)
    c.seed = { arg: key }
    args[key] = { ...(args[key] || {}), flag: text.startsWith('-') ? text : '--' + text, style: 'value' }
    c.args = args
    return c
  }
  // 离开 arg 态时把这一条 args 收走：它只服务于种子，留着会变成没人用的参数。
  if (prev && prev.arg !== undefined) {
    const key = String(prev.arg)
    if (args[key] && Object.keys(args[key]).length) delete args[key]
    if (!Object.keys(args).length) delete c.args
    else c.args = args
  }
  if (mode === 'global') {
    c.seed = { mode: 'global', rngs: (prev && Array.isArray(prev.rngs) && prev.rngs.length) ? prev.rngs : ['python'] }
  } else {
    c.seed = 'none'
  }
  return c
}

/**
 * 写参数字。界面上填的是开关（cli）或参数名（python），落盘按 kind 折算。
 * 清空时写空串：由界面提示「不能为空」，不替人补回默认值。
 */
export function withSeedArg (call, text) {
  const c = { ...(call || {}) }
  const kind = c.kind || 'python'
  const raw = String(text == null ? '' : text).trim()
  if (kind !== 'cli') {
    c.seed = { arg: raw }
    return c
  }
  const args = { ...(c.args || {}) }
  const prevKey = c.seed && c.seed.arg !== undefined ? String(c.seed.arg) : ''
  if (prevKey && prevKey !== flagToKey(raw)) delete args[prevKey]
  const key = flagToKey(raw)
  if (!key) {
    c.seed = { arg: '' }
    if (prevKey) {
      delete args[prevKey]
      if (!Object.keys(args).length) delete c.args
      else c.args = args
    }
    return c
  }
  args[key] = { ...(args[key] || {}), flag: raw.startsWith('-') ? raw : '--' + raw, style: 'value' }
  c.args = args
  c.seed = { arg: key }
  return c
}

/** 勾/取消一种随机源。 */
export function withSeedRng (call, name, on) {
  const cur = seedRngsOf(call)
  const next = on ? (cur.includes(name) ? cur : [...cur, name]) : cur.filter((x) => x !== name)
  return { ...(call || {}), seed: { mode: 'global', rngs: next } }
}
