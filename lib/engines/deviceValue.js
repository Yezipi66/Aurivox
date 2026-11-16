'use strict'
// 运行设备的取值换算：使用者挑的是「哪块卡」，引擎要的是它自己的写法。
//
// 同一个 --device，引擎之间不通用：
//   torch 系（IndexTTS2 等）要类型字符串：cpu / cuda / cuda:1 / mps / xpu
//   有的引擎要编号整数：0 / 1 / 2（Spark-TTS 的 type=int）
//   有的引擎自己列了 choices，只能照它给的值填
// 所以界面统一按「设备名」呈现，落进名片前才换算成这台引擎认的写法。
//
// 未指定（auto）一律返回 null，表示「这个参数不出现在命令行里」：
//   让引擎走它自己的默认值。猜一个值填上去，比不填更容易出错。

// 引擎声明的取值形式。名片没写时由扫描结果的类型推断（int ⇒ index，str ⇒ torch）。
const FORMATS = ['torch', 'index', 'enum']

// 厂商 → torch 设备名。AMD 在 torch 里没有自己的设备名：ROCm 构建复用 cuda，
//   ZLUDA 也是。漏了这一条，装了 ROCm 的机器在设备列表里整块消失，界面上看着
//   像平台没认出那块卡，根源是映射表里没有它。
const BACKEND_BY_VENDOR = {
  nvidia: 'cuda',
  amd: 'cuda',
  intel: 'xpu',
  apple: 'mps',
}

/**
 * 从扫描到的参数类型推断取值形式。
 * @param {string|null} type argparse 的 type= 原值（int / str / Path …）
 * @param {string[]|null} choices 引擎自己列的可选值
 * @returns {'torch'|'index'|'enum'}
 */
function inferFormat (type, choices) {
  if (Array.isArray(choices) && choices.length) return 'enum'
  const t = String(type || '').toLowerCase()
  if (t === 'int' || t === 'integer' || t === 'number' || t === 'float') return 'index'
  return 'torch'
}

/**
 * 使用者选的设备 → 这台引擎 device 参数的取值。
 *
 * @param {object} opts
 * @param {{kind:'auto'}|{kind:'cpu'}|{kind:'gpu', index:number, backend?:string}} opts.pick
 *   界面上选中的那一项。backend 是 cuda / mps / xpu，缺省按 cuda 处理。
 * @param {'torch'|'index'|'enum'} opts.format 引擎认哪种写法
 * @param {Array|null} opts.choices 引擎声明的可选值，有就优先照它挑
 * @returns {string|null} null 表示不传这个参数
 */
function deviceValue (opts) {
  const pick = (opts && opts.pick) || { kind: 'auto' }
  const format = (opts && opts.format) || 'torch'
  const choices = (opts && Array.isArray(opts.choices) && opts.choices.length)
    ? opts.choices.map((c) => String(c))
    : null

  if (pick.kind === 'auto') return null

  // 原样下发：使用者自己写了引擎认的值（多卡串 cuda:0,1、npu、引擎私有词）。
  //   平台不知道它是什么意思，也不该猜，照抄就是唯一正确的做法。
  if (pick.kind === 'raw') {
    const raw = pick.value
    if (raw === undefined || raw === null || String(raw).trim() === '') return null
    return String(raw).trim()
  }

  if (pick.kind === 'cpu') {
    if (choices) return choices.find((c) => /^cpu$/i.test(c)) || null
    // 编号写法下 CPU 无从表达：把 'cpu' 交给一个 type=int 的参数，引擎当场报类型错，
    //   而使用者以为自己选了 CPU。不发这个开关，让引擎走自己的默认值。
    if (format === 'index') return null
    return 'cpu'
  }

  if (pick.kind !== 'gpu') return null
  const index = Number(pick.index)
  if (!Number.isInteger(index) || index < 0) return null
  const backend = String(pick.backend || 'cuda').toLowerCase()

  if (choices) {
    // 引擎自己列了取值：只认表里真实存在的那一项，不拼一个它没写过的值。
    const exact = choices.find((c) => c === String(index))
    if (exact) return exact
    const tagged = choices.find((c) => new RegExp('[:=_-]' + index + '$').test(c))
    if (tagged) return tagged
    const byType = choices.find((c) => new RegExp('^' + backend + '$', 'i').test(c))
    if (byType && index === 0) return byType
    return null
  }

  if (format === 'index') {
    // 编号写法只对 CUDA 有意义。mps / xpu 没有「第几块」这个概念，
    //   把 0 传过去会被引擎当成 CUDA 编号，静默用了另一块设备，
    //   而使用者以为跑的就是自己选的那块。宁可返回 null 让它用默认值。
    return backend === 'cuda' ? String(index) : null
  }

  if (backend === 'mps') return 'mps'
  if (backend === 'xpu') return index === 0 ? 'xpu' : 'xpu:' + index
  // torch 的 cuda 不写序号时就是第 0 块，写全了反而多余，多卡时再带序号
  return index === 0 ? 'cuda' : 'cuda:' + index
}

/**
 * 界面上的设备清单：自动、CPU，然后本机每一块卡各占一行。
 *
 * 编号按列举顺序连续给（GPU 0、GPU 1、…），这样独显与核显能并排列出来。
 *   但 NVIDIA 真正传给引擎的是 CUDA 编号，两者未必一致（核显排在前面时就会错位），
 *   所以不一致的那一行把真实编号标出来，避免使用者以为选的 GPU 1 就是 cuda:1。
 *
 * 能不能选取决于它需不需要编号：CUDA 有第几块的概念，没编号就分不清选的是哪一块；
 *   MPS 与 XPU 不写编号就是第 0 块，没有编号也能用。
 *
 * @param {{vendor:string, index:number|null, name:string}[]} gpus detectGpus() 的结果
 * @param {{format?:string, choices?:string[]|null, flag?:string}} [opts]
 *   引擎声明的取值形状。玩法只有三种，界面直接按它摆选项：
 *     torch  设备名（cpu / cuda:1 / xpu），最常见
 *     index  编号整数（Spark-TTS 的 type=int）。这一档表达不了 CPU
 *     enum   引擎自己列了候选值，只能照它给的挑，硬件枚举对它没有意义
 *   不传时按 torch 摆，与「名片没声明形状」时下发侧的默认一致。
 * @returns {{value:object, labelZh:string, labelEn:string, selectable:boolean, sends:string}[]}
 *   sends 是这一项真发下去时命令行上会出现什么，界面原样显示，不做换算。
 */
function deviceOptions (gpus, opts) {
  const format = (opts && opts.format) || 'torch'
  const choices = (opts && Array.isArray(opts.choices) && opts.choices.length)
    ? opts.choices.map((c) => String(c))
    : null
  const flag = (opts && opts.flag) || ''

  // 预览串：换算只在 deviceValue 里做一次，界面拿到的是结论而不是规则。
  // 不知道开关名时不编一句预览：没有 flag 就没有「这次下发什么」这回事，
  //   显示一个孤零零的 cpu 反而像是平台已经决定了。
  const tag = (value) => {
    const sent = deviceValue({ pick: value, format, choices })
    if (!flag) return ''
    return sent === null ? '不传这个开关，引擎用自己的默认值' : flag + ' ' + sent
  }

  const auto = {
    value: { kind: 'auto' }, labelZh: '自动（不指定）', labelEn: 'Auto (unset)', selectable: true,
  }
  auto.sends = tag(auto.value)

  // 引擎自己列了候选值：只有它列的那些是真的。拿 GPU 0 这种名字喂过去只会被当场拒，
  //   所以这一档既不列 CPU 也不列显卡，只列它自己的词。
  if (format === 'enum' && choices) {
    return [auto, ...choices.map((c) => {
      const value = { kind: 'raw', value: c }
      return { value, labelZh: c, labelEn: c, selectable: true, sends: tag(value) }
    })]
  }

  const out = [auto]
  const cpu = { value: { kind: 'cpu' }, labelZh: 'CPU', labelEn: 'CPU', selectable: format !== 'index' }
  if (format === 'index') {
    cpu.labelZh = 'CPU（本引擎只收显卡编号，选不了）'
    cpu.labelEn = 'CPU (this engine takes a GPU index only)'
  }
  cpu.sends = tag(cpu.value)
  out.push(cpu)

  let seq = 0
  for (const g of (gpus || [])) {
    const backend = BACKEND_BY_VENDOR[g.vendor] || null
    if (!backend) continue
    const hasIndex = Number.isInteger(g.index) && g.index >= 0
    const show = seq
    seq += 1
    const head = 'GPU ' + show + ': ' + (g.name || g.vendor)
    const offset = backend === 'cuda' && hasIndex && g.index !== show
    const value = { kind: 'gpu', index: hasIndex ? g.index : 0, backend }
    // 编号写法只对 CUDA 成立（见 deviceValue 里的同一条判断）。其余卡列出来但选不了，
    //   否则使用者选了 xpu，拿到的是「不发这个开关」，而界面看着像成功了。
    // 编号只有 NVIDIA 必需：ROCm 与 ZLUDA 复用 cuda 设备名，但不写编号就是第 0 块，
    //   与 XPU 同理。按厂商判而不是按 backend 判，否则 AMD 卡会因为「缺编号」被置灰。
    const needsIndex = g.vendor === 'nvidia'
    const usable = format === 'index'
      ? backend === 'cuda' && hasIndex
      : (needsIndex ? hasIndex : true)
    out.push({
      value,
      labelZh: head + (offset ? '（CUDA ' + g.index + '）' : '')
        + (usable ? '' : (format === 'index' ? '（本引擎只收 NVIDIA 编号）' : '')),
      labelEn: head + (offset ? ' (CUDA ' + g.index + ')' : '')
        + (usable ? '' : (format === 'index' ? ' (NVIDIA index only)' : '')),
      // 只有 CUDA 必须知道是第几块；MPS / XPU 不写编号就落到第 0 块
      selectable: usable,
      sends: tag(value),
    })
  }
  return out
}

/**
 * 从名片里找出声明为运行设备的参数，按使用者选中的设备算成这台引擎认的写法。
 *
 * 名片里的样子：
 *   "call": { "args": { "device": { "flag": "--device", "role": "device",
 *                                  "device_format": "torch" } } }
 * 一个引擎理论上可以有多个参数标 device（少见），所以按名字逐个算；
 * 算不出来的（没选、格式不符、引擎没列这个值）就不出现在结果里，
 * 等于这个参数这次不上命令行，由引擎自己决定。
 *
 * @param {object} call 名片的 call 段
 * @param {object} picked 使用者选中的设备，形状同 deviceOptions 里的 value
 * @returns {Object<string,string>} 参数名 → 要下发的值；没声明 device 时返回空对象
 */
function resolveDeviceArgs (call, picked) {
  const args = (call && call.args) || {}
  const out = {}
  for (const [name, entry] of Object.entries(args)) {
    if (!entry || entry.role !== 'device') continue
    const value = deviceValue({
      pick: picked,
      format: entry.device_format || 'torch',
      choices: Array.isArray(entry.choices) ? entry.choices : null,
    })
    if (value !== null) out[name] = value
  }
  return out
}

module.exports = { FORMATS, inferFormat, deviceValue, deviceOptions, resolveDeviceArgs }
