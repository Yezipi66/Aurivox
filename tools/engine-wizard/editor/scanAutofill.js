// 扫描结果转成名片建议值的纯函数。
//
// 不 import react：这个文件只做计算，能单独编译单独测，
// 不必为了跑一个纯函数把组件树拉起来。
//
// 输入是 /wizard/discover 返回的参数表，输出是名片的 call 段建议。
// 纯函数不读组件 state、不调 onChange。

/**
 * 把扫描到的参数转成名片 call 段的建议值。
 *
 * @param params [{source, name, target, kind, style, help, required, group, is_tool}]
 *   cli 路的 name 是开关去掉横线的部分、target 是开关本身，进 call.args；
 *   python 路的 name 与 target 同名，都是上游方法的参数名，不进 call.args。
 * @param currentCall 现有的 call 段，作基底；用户手填的值不被覆盖。
 * @returns {{call, matched, argList, notes}} 或 null（没有参数）；
 *   matched 是 { text, ref_audio, output_path }，认不出时为 null。
 */
export function computeAutoFill (params, currentCall) {
  if (!params || !params.length) return null

  const call = { ...(currentCall || {}) }
  const notes = []

  // kind 由名片说了算，只在只有一条来源时才改它。
  //   探测是同时扫两条路、再把结果合并成一张表的：表里混着两种来源，
  //   「有 cli 参数就置 cli」于是对一张混合表恒真，python 名片被改写成 cli 形态之后，
  //   它的参数名不再是带横线的开关，存下去当场被拒。
  const hasCli = params.some((p) => p.source === 'cli')
  const hasPy = params.some((p) => p.source === 'python')
  if (hasCli && hasPy) {
    notes.push({
      en: 'Both command line flags and Python signature parameters were found. The manifest kind was left as it is: confirm whether this engine runs through the command line or through the Python class.',
      zh: '同时发现了命令行开关和 Python 函数签名参数。名片里的 kind 保持原样：请确认这台引擎走命令行还是走 Python 类。',
    })
  } else if (hasCli) {
    call.kind = 'cli'
  } else if (hasPy) {
    call.kind = 'python'
  }

  // args 与 argv 是 cli 形态才有的两段，python 名片里写它，存的时候直接被拒。
  if (call.kind === 'cli') {
    const oldArgv = call.argv || []
    const idxModule = oldArgv.indexOf('_MODULE_')
    const prefix = idxModule >= 0 ? oldArgv.slice(0, idxModule + 1) : oldArgv.slice(0, 3)
    call.argv = (prefix.length ? prefix : ['{engine_python}', '-m', '_MODULE_'])

    // 只收 cli 来源的参数：python 参数名不是开关，写进去就是一条认不出的开关。
    call.args = call.args || {}
    for (const p of params) {
      if (p.source !== 'cli' || call.args[p.name]) continue
      const entry = { flag: p.target }
      if (p.style) entry.style = p.style
      call.args[p.name] = entry
    }
  }

  // 三个槽位：候选名对的是 name（不带横线的那个词），写进 bind 的是 target
  // （cli 路是开关，python 路是参数名）。索引必须建在 name 上：建在 target 上时，
  // cli 路的 target 是带横线的开关，而候选名不带横线，两边永远不匹配。
  const byName = {}
  const ambiguous = []
  for (const p of params) {
    if (byName[p.name] === undefined) { byName[p.name] = p; continue }
    if (byName[p.name].target !== p.target) ambiguous.push(p.name)
  }
  const findSlot = (...names) => {
    for (const n of names) if (byName[n]) return byName[n].target
    return null
  }

  const matched = {
    text: findSlot('text', 'tts_text', 'prompt_text', 'gen_text'),
    ref_audio: findSlot('voice', 'ref_audio', 'prompt_wav', 'ref_wav', 'spk', 'speaker', 'reference_audio'),
    output_path: findSlot('output', 'output_path', 'out', 'save_path'),
  }

  if (ambiguous.length) {
    notes.push({
      en: `The same name appeared in both sources with different values: ${ambiguous.join(', ')}. The first one was used: confirm each slot by hand.`,
      zh: `同名参数在两种来源里指向的值不一样：${ambiguous.join('、')}。已按先出现的那个填，请逐项确认。`,
    })
  }

  // 复制一份再填：浅拷贝出来的 call 里 bind 还是同一个对象，就地写会把名片原稿也改了。
  call.bind = { ...(call.bind || {}) }
  if (!call.bind.text && matched.text) call.bind.text = matched.text
  if (!call.bind.ref_audio && matched.ref_audio) call.bind.ref_audio = matched.ref_audio
  if (!call.bind.output_path && matched.output_path) call.bind.output_path = matched.output_path

  return { call, matched, argList: params, notes }
}
