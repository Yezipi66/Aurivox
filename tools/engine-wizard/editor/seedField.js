// 「seed」那一格的读写。纯函数，单独可测。
//
// 名片里 call.seed 只有三种合法写法（契约 §5.2.1）：
//   "none"                             不可复现，宿主拒收 seed
//   { arg: "<参数名>" }                 引擎自己收，宿主把种子塞进这个参数名
//   { mode: "global", rngs: [...] }    宿主播全局随机源（只对 kind="python" 有效）
//
// 界面只给一个输入框：填开关名 = 引擎自己收，留空 = 不可复现。
//   「留空」在别的格是「不声明」，在这一格不行：名片缺了 call.seed，存盘与启动都会被拒。
//   所以留空落盘是显式的 "none"，而不是删掉这一项。
//   全局播种（mode:"global"）没有对应的界面，只认名片里原本写着的那一份，写回时不动它。
//
// 两种 kind 的「参数名」不是同一种东西，这一层必须分开写：
//   python  写的是方法的关键字参数名（kwargs[arg] = seed）
//   cli     写的是 **call.args 里的键**：宿主把种子塞进 params[arg]，
//           再由 build_cli_argv 用 call.args[arg].flag 拼成 `--seed 42`。
//           ⇒ 只写 call.seed 而不补 call.args，合成时会直接报「参数没有在
//             call.args 里说明该变成哪个命令行开关」，属于必然失败。
//           界面上让人填开关（--seed），落盘时补出一条 args 并把它折算成键。

const flagToKey = (text) => String(text || '').trim()
  .replace(/^-+/, '').replace(/-/g, '_').toLowerCase()

/**
 * 界面上那一格的值：cli 显示开关（--seed），python 显示参数名（seed）。
 * 全局播种没有对应的开关，显示为空（那一份只能到 JSON 视图里改）。
 */
export function seedArgText (call) {
  const spec = call && call.seed
  if (!spec || spec === 'none' || spec.arg === undefined) return ''
  const arg = String(spec.arg)
  if (!arg) return ''
  const kind = (call && call.kind) || 'python'
  if (kind !== 'cli') return arg
  const entry = ((call.args || {})[arg]) || null
  return (entry && entry.flag) || ('--' + arg)
}

/**
 * 写「seed」那一格。原对象不动。
 * 空字符串 ⇒ 落盘 "none"（显式声明不可复现），并把为种子补出的那条 args 收走。
 *
 * @param {object} call 名片 call 段
 * @param {string} text 界面上填的开关名或参数名
 * @returns {object} 新的 call 段
 */
export function withSeedSwitch (call, text) {
  const c = { ...(call || {}) }
  const kind = c.kind || 'python'
  const raw = String(text == null ? '' : text).trim()
  const args = { ...(c.args || {}) }
  const prevKey = c.seed && c.seed.arg !== undefined ? String(c.seed.arg) : ''

  // 先把上一次为种子补出的那条 args 收走：改名后留着它就是一条没人用的开关。
  if (prevKey && kind === 'cli' && args[prevKey]) delete args[prevKey]

  if (!raw) {
    c.seed = 'none'
    if (!Object.keys(args).length) delete c.args
    else if (kind === 'cli') c.args = args
    return c
  }

  if (kind !== 'cli') {
    // python 形态的参数名就是方法关键字，不经过命令行，也就没有 args 表。
    c.seed = { arg: flagToKey(raw) }
    if (Object.keys(args).length) c.args = args
    else delete c.args
    return c
  }

  const key = flagToKey(raw)
  args[key] = { ...(args[key] || {}), flag: raw.startsWith('-') ? raw : '--' + raw, style: 'value' }
  c.args = args
  c.seed = { arg: key }
  return c
}
