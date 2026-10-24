// 名片表单的自动填：判定与填值都是纯函数，好测。
//
// 这一份从 ManifestForm.jsx 里抽出来，因为自动填的判定有四条分支，
// 塞在 React effect 里就只能靠点界面来验，而点界面验不到「不该填的时候没填」。

/**
 * 该不该把 runtime.checkpoints 自动填成落盘路径。
 *
 * @param {object} manifest 当前名片
 * @param {string|null} checkpointsPath 第 3 步的落盘路径（相对项目根，后端送来）
 * @returns {boolean} 该填就 true
 */
export function shouldAutoFillCheckpoints (manifest, checkpointsPath) {
  // 落盘路径还没有 ⇒ 没得填
  if (!checkpointsPath) return false
  // 引擎 id 还没定 ⇒ 算不出这一台引擎的落盘路径
  if (!manifest || !manifest.id) return false
  // 这一格已经有值 ⇒ 使用者填过，不动他填的
  const rt = manifest.runtime || {}
  if (rt.checkpoints) return false
  return true
}

/**
 * 填上 runtime.checkpoints。调用前先问 shouldAutoFillCheckpoints。
 *
 * @param {object} manifest 当前名片
 * @param {string} checkpointsPath 第 3 步的落盘路径
 * @returns {object} 填好的新名片（原对象不动）
 */
export function withAutoFilledCheckpoints (manifest, checkpointsPath) {
  const rt = (manifest && manifest.runtime) || {}
  return {
    ...manifest,
    runtime: { ...rt, checkpoints: checkpointsPath },
  }
}
