'use strict'

// 各计算后端对 Torch 版本的支持边界。
//
// 问题形状：XPU、ROCm 这类加速后端不是「所有 torch 版本都能用」，
//   而是有明确的**下界**：从某个版本起才有该后端的官方轮子，
//   低于那个版本的 torch **永远不会**被这个后端支持。
//   方向是单向的：后端只会往更高的 torch 版本扩，不会回头兼容更老的。
//
//   典型例子：XPU 的官方二进制轮子从 torch 2.6.0 起才有
//   （2.5 只有源码层面的上游支持，官方不发二进制轮子），
//   所以上游把 torch 钉在 2.5.1 时，在 XPU 机器上一定装不上。
//
// 所以判据是**查表比大小**，不是联网爬 index：
//   上游声明的版本 < 这个下界 ⇒ 不兼容，给出下界作为建议版本。
//   弹窗与判断都不需要联网。
//
// 下界精确到 (官方 index, 平台族, Python ABI) 三元组。
//   不能简化成「后端下界 + ABI 下界取大者」：那样会误报。
//     cu121+cp312 实际从 2.2.0 起，不是 2.1.0；
//     cpu+cp313 实际从 2.6.0 起，不是 2.5.0；
//     rocm6.4 在 Windows 上一个轮子都没有。
//   也不能取小者：那样会漏报（把本来装不上的版本说成装得上）。
//
// 表里的值是官方 index 页面的实际内容（每个 index、每个平台族、
//   每个 ABI，从哪个 torch 版本起有轮子），不是推算的。
//   事实来源：
//     https://download.pytorch.org/whl/<index>/torch/  （逐个 index 读取）
//     bitsandbytes 官方发布说明写明「The current minimum is PyTorch 2.6.0」
//       （针对 Intel XPU），与表里 xpu 的 2.6.0 一致；
//     PyTorch 2.6 发布博客记明 Intel GPU 的 Windows 二进制自 2.6 起提供。
//
// 事实表会过时：上游发新版本时不需要改这张表（下界不变），
//   只有上游**回补**老版本的轮子时才需要更新。

// 后端 key → 官方 index 目录名。
const BACKEND_INDEX = {
  cuda: 'cu121',
  ipex: 'xpu',
  rocm: 'rocm6.4',
  cpu: 'cpu',
}

// 平台族 → 该族在 wheel 文件名里的兼容 tag。
//   pip 会在同族里挑最优先的 tag，「某个版本有没有可用轮子」
//   = 该族里任一 tag 存在即可。
const PLATFORM_FAMILY = {
  win: ['win_amd64', 'win_arm64'],
  linux: [
    'manylinux_2_28_x86_64', 'manylinux_2_17_x86_64',
    'manylinux2014_x86_64', 'manylinux1_x86_64', 'linux_x86_64',
  ],
  mac: ['macosx_11_0_arm64', 'macosx_10_9_x86_64'],
}

// 官方 index → 平台族 → Python ABI → 该组合下可用的最低 torch 版本。
//   值是「这个组合的第一个有轮子的 torch 版本」。
//   某个组合没列 ⇒ 这个组合一个轮子都没有（换 torch 版本也解决不了）。
const INDEX_MIN_TORCH = {
  cpu: {
    win: {
      cp38: '1.4.0', cp39: '1.7.1', cp310: '1.11.0', cp311: '2.0.0',
      cp312: '2.2.0', cp313: '2.6.0', cp314: '2.9.0', cp315: '2.14.0',
    },
    linux: {
      cp38: '1.4.0', cp39: '1.7.1', cp310: '1.11.0', cp311: '1.13.0',
      cp312: '2.2.0', cp313: '2.5.0', cp314: '2.9.0', cp315: '2.13.0',
    },
    mac: {},
  },
  cu121: {
    win: {
      cp38: '2.1.0', cp39: '2.1.0', cp310: '2.1.0', cp311: '2.1.0',
      cp312: '2.2.0',
    },
    linux: {
      cp38: '2.1.0', cp39: '2.1.0', cp310: '2.1.0', cp311: '2.1.0',
      cp312: '2.2.0', cp313: '2.5.0',
    },
    mac: {},
  },
  rocm5_7: {
    win: {},
    linux: {
      cp38: '2.2.0', cp39: '2.2.0', cp310: '2.2.0', cp311: '2.2.0', cp312: '2.2.0',
    },
    mac: {},
  },
  rocm6_0: {
    win: {},
    linux: {
      cp38: '2.3.0', cp39: '2.3.0', cp310: '2.3.0', cp311: '2.3.0', cp312: '2.3.0',
    },
    mac: {},
  },
  rocm6_1: {
    win: {},
    linux: {
      cp38: '2.4.0', cp39: '2.4.0', cp310: '2.4.0', cp311: '2.4.0',
      cp312: '2.4.0', cp313: '2.6.0',
    },
    mac: {},
  },
  rocm6_2: {
    win: {},
    linux: {
      cp39: '2.5.0', cp310: '2.5.0', cp311: '2.5.0', cp312: '2.5.0',
    },
    mac: {},
  },
  rocm6_3: {
    win: {},
    linux: {
      cp39: '2.7.0', cp310: '2.7.0', cp311: '2.7.0', cp312: '2.7.0',
      cp313: '2.7.0', cp314: '2.9.0',
    },
    mac: {},
  },
  rocm6_4: {
    win: {},
    linux: {
      cp39: '2.8.0', cp310: '2.8.0', cp311: '2.8.0', cp312: '2.8.0',
      cp313: '2.8.0', cp314: '2.9.0',
    },
    mac: {},
  },
  xpu: {
    win: {
      cp39: '2.6.0', cp310: '2.6.0', cp311: '2.6.0', cp312: '2.6.0',
      cp313: '2.6.0', cp314: '2.9.0', cp315: '2.14.0',
    },
    linux: {
      cp39: '2.6.0', cp310: '2.6.0', cp311: '2.6.0', cp312: '2.6.0',
      cp313: '2.6.0', cp314: '2.9.0', cp315: '2.13.0',
    },
    mac: {},
  },
}

// index 目录名 → 表里的键（目录名里的点改成下划线）。
const INDEX_KEY_ALIAS = {
  'rocm5.7': 'rocm5_7',
  'rocm6.0': 'rocm6_0',
  'rocm6.1': 'rocm6_1',
  'rocm6.2': 'rocm6_2',
  'rocm6.3': 'rocm6_3',
  'rocm6.4': 'rocm6_4',
}

/**
 * 比较两个版本号（形如 2.5.1 / 2.6）。
 * @returns {number} a<b ⇒ 负数；a===b ⇒ 0；a>b ⇒ 正数
 */
function cmpVersion (a, b) {
  const pa = String(a || '0').split('.').map(Number)
  const pb = String(b || '0').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x !== y) return x - y
  }
  return 0
}

/**
 * Node 的 platform → 平台族。
 * @param {string} platform process.platform（'win32' / 'linux' / 'darwin'）
 * @returns {string|null} 平台族（win / linux / mac）；认不出 ⇒ null
 */
function platformFamily (platform) {
  if (platform === 'win32') return 'win'
  if (platform === 'linux') return 'linux'
  if (platform === 'darwin') return 'mac'
  return null
}

/**
 * 某个后端 + 平台族 + Python ABI 上，能用的最低 torch 版本。
 *
 * @param {string} backend 后端 key（cuda / ipex / rocm / cpu）
 * @param {string} abi Python ABI tag（cp311 这种）
 * @param {string} family 平台族（win / linux / mac）
 * @returns {string|null} 最低可用版本；这个组合一个轮子都没有 ⇒ null
 */
function minTorchFor (backend, abi, family) {
  const index = BACKEND_INDEX[backend]
  if (!index) return null
  const tableKey = INDEX_KEY_ALIAS[index] || index
  const perFamily = INDEX_MIN_TORCH[tableKey]
  if (!perFamily) return null
  const perAbi = perFamily[family]
  if (!perAbi) return null
  return perAbi[abi] || null
}

module.exports = {
  BACKEND_INDEX,
  PLATFORM_FAMILY,
  INDEX_MIN_TORCH,
  minTorchFor,
  cmpVersion,
  platformFamily,
}
