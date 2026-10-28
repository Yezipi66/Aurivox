'use strict'

// 各计算后端对 Torch 版本的支持边界：每个 (官方 index, 平台族, Python ABI) 组合，
//   从某个版本起才有官方轮子；低于那个下界的版本这个后端永远不支持。
// 方向单向：后端只往更高的 torch 版本扩，不回头兼容更老的。
// 所以判据是查表比大小，不是联网爬 index：上游声明的版本低于下界 ⇒ 不兼容，下界即建议版本。
// 下界不能拆成「后端下界 + ABI 下界」再取大或取小：取大会误报，取小会漏报。
// 表里的值是各官方 index 页面的实际内容；上游补发老版本的轮子时才需要更新这张表。

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
