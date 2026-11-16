'use strict'

// 整机硬件：CPU、内存、显卡。回答「本机有什么」，不回答「它能干什么」。
//
// 只问操作系统与 node:os 的内置接口，不问任何 venv：平台与每台引擎各有一份 torch，
// 借引擎的环境回答整机问题，同一台机器会得到两种答案。
// 显卡探测在 lib/system/gpu.js（那里按平台各有判据），本文件补 CPU 与内存并汇总成一份。
// 三个消费方共用这一份结果：/api/health、/api/devices、接入向导的环境步骤。

const os = require('node:os')
const { detectGpu, clearGpuCache } = require('./gpu')

function round1 (n) { return Math.round(n * 10) / 10 }

/**
 * CPU：型号、逻辑线程数、标称主频、架构。
 * 全部来自 node:os，无子进程、无权限要求。型号字符串由系统给出，
 * 工程样机与部分虚拟机会返回占位值，此时如实照抄，不猜。
 */
function cpuInfo () {
  const list = os.cpus() || []
  const first = list[0] || {}
  const model = String(first.model || '').replace(/\s+/g, ' ').trim()
  return {
    model: model || null,
    threads: list.length,
    mhz: typeof first.speed === 'number' && first.speed > 0 ? first.speed : null,
    arch: os.arch(),
  }
}

/** 内存：总量与当前可用量，单位 GB（保留一位小数）。 */
function memoryInfo () {
  const GB = 1024 ** 3
  return {
    total_gb: round1(os.totalmem() / GB),
    free_gb: round1(os.freemem() / GB),
  }
}

/**
 * 汇总本机硬件。
 *
 * gpus[].index 只有 NVIDIA 给：nvidia-smi 的编号与 CUDA 编号一致，是 `cuda:N` 里那个 N
 * 的唯一可靠来源；其他厂商拿不到可靠编号时为 null，调用方按「不指定」处理。
 * gpus[].vram_gb 同样只有 NVIDIA 给，理由见 lib/system/gpu.js 文件头。
 *
 * @returns {{
 * cpu:{model:string|null, threads:number, mhz:number|null, arch:string},
 * memory:{total_gb:number, free_gb:number},
 * gpus:{vendor:string, index:number|null, name:string|null, vram_gb:number|null,
 *       driver:string|null, via:string|null}[],
 * platform:string, probe:string, ready:boolean
 * }}
 */
function detectHardware () {
  const g = detectGpu()
  const gpus = (g.devices || []).map((d) => ({
    vendor: d.vendor || 'unknown',
    index: typeof d.index === 'number' ? d.index : null,
    name: d.name || null,
    vram_gb: d.vendor === 'nvidia' && d.vram_mb ? round1(d.vram_mb / 1024) : null,
    driver: d.driver || null,
    via: d.source || g.probe || null,
  }))
  return {
    cpu: cpuInfo(),
    memory: memoryInfo(),
    gpus,
    // 与显卡探测同一份判据说明：出错时人要知道它问了哪个接口。
    platform: g.platform || process.platform,
    probe: g.probe || 'none',
    ready: g.ready !== false,
  }
}

/** 清缓存（换驱动、插拔卡之后用）。 */
function clearHardwareCache () { clearGpuCache() }

module.exports = { detectHardware, cpuInfo, memoryInfo, clearHardwareCache }
