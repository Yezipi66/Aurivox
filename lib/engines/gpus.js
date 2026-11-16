'use strict'
// 显卡列表：列出本机装了哪几块卡，各自归哪个厂商。
//
// 放在 lib/ 而不是向导里，是因为两处都要用：9886 主应用的合成页要出设备下拉，
//   接入向导的环境步骤也要。放在工具侧会让主应用反向依赖 tools/，那是没必要的耦合。
//
// 本文件只回答「机器上有什么」，不判断引擎要哪种写法：
//   引擎认 cuda / cuda:1 还是 0 / 1，由 lib/engines/deviceValue.js 换算。
// 探测本身在 lib/system/gpu.js：那里按平台各有判据，并由 lib/system/hardware.js 汇总。
//   这里只做字段搬运，不再自己起子进程，否则同一台机器会有两份答案。

const { detectHardware, clearHardwareCache } = require('../system/hardware')
const { sameGpuName, run, runFirst } = require('../system/gpu')

/**
 * 检测本机 GPU。任何一步失败都不抛，分不清就交给调用方退 CPU。
 * index 是「引擎会认的那个编号」：NVIDIA 取 nvidia-smi 的编号，等于 CUDA 的编号；
 *   其他来源拿不到可靠编号时给 null，调用方按「不指定」处理。
 * @returns {{vendor:string, index:number|null, name:string|null, via:string}[]}
 */
function detectGpus () {
  try {
    return detectHardware().gpus.map((g) => ({
      vendor: g.vendor, index: g.index, name: g.name, via: g.via,
    }))
  } catch (e) {
    return []
  }
}

/** 装完驱动或换卡之后调，让下次检测重新跑。 */
function clearGpuCache () { clearHardwareCache() }

module.exports = { detectGpus, sameGpuName, clearGpuCache, run, runFirst }
