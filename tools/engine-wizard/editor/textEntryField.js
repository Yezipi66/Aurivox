// 合成文本从哪进：call.bind.text 的开关，或 call.text_via="stdin" 的标准输入。
//
// 宿主 lib/engines/host.py 两种都认，但二者互斥：两个都写会当场报错，
//   text_via 写成 "stdin" 以外的值也会报错。所以这里写一边就摘掉另一边，
//   名片里永远只有一种文本入口。
//
// 纯函数：不读盘、不碰 React，单独验。

export const TEXT_VIA_STDIN = 'stdin'

// 名片是不是把正文走标准输入。
export function readTextVia (call) {
  const c = (call && typeof call === 'object') ? call : {}
  return c.text_via === TEXT_VIA_STDIN
}

// 打开 / 关掉标准输入入口。返回新的 call，不改入参。
export function withTextVia (call, on) {
  const c = (call && typeof call === 'object') ? call : {}
  const next = { ...c }
  const bind = { ...(c.bind || {}) }
  const hadBind = !!c.bind && typeof c.bind === 'object'
  if (on) {
    // 互斥：留着 bind.text 与 text_via 并存会让宿主拒掉每一次请求。
    delete bind.text
    next.text_via = TEXT_VIA_STDIN
  } else {
    delete next.text_via
  }
  // bind 在传入时已有时保留（哪怕是空的）：名片形状跟着人改，不自己长键也不自己删键。
  if (hadBind) next.bind = bind
  return next
}
