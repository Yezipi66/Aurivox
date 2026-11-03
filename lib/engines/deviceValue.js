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

  if (pick.kind === 'cpu') {
    if (choices) return choices.find((c) => /^cpu$/i.test(c)) || null
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
 * @returns {{value:object, labelZh:string, labelEn:string, selectable:boolean}[]}
 */
function deviceOptions (gpus) {
  const out = [
    { value: { kind: 'auto' }, labelZh: '自动（不指定）', labelEn: 'Auto (unset)', selectable: true },
    { value: { kind: 'cpu' }, labelZh: 'CPU', labelEn: 'CPU', selectable: true },
  ]
  let seq = 0
  for (const g of (gpus || [])) {
    const backend = g.vendor === 'apple' ? 'mps'
      : g.vendor === 'intel' ? 'xpu'
        : g.vendor === 'nvidia' ? 'cuda' : null
    if (!backend) continue
    const hasIndex = Number.isInteger(g.index) && g.index >= 0
    const show = seq
    seq += 1
    const head = 'GPU ' + show + ': ' + (g.name || g.vendor)
    const offset = backend === 'cuda' && hasIndex && g.index !== show
    out.push({
      value: { kind: 'gpu', index: hasIndex ? g.index : 0, backend },
      labelZh: head + (offset ? '（CUDA ' + g.index + '）' : ''),
      labelEn: head + (offset ? ' (CUDA ' + g.index + ')' : ''),
      // 只有 CUDA 必须知道是第几块；MPS / XPU 不写编号就落到第 0 块
      selectable: backend === 'cuda' ? hasIndex : true,
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
