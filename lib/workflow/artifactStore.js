'use strict'

// 只读的 Artifact Store 检索，按 docs/FLOW-D10B-ARTIFACT-STORE-CONTRACT.md §3。
// 只做存在性检查与描述符核对，写入、GC、保留期、谱系版本分配都不在这里：
// 没实现的部分不能由实现细节反推定义。
//
// 这一层能给到的保证是 L1：拿 Store 报出的指纹与快照比对。L1 不消除信任，
// 只是把信任从解析器挪到 Store 身上：允许原地覆盖又不改指纹的 Store，
// 骗过 L1 和骗过 L0 一样容易。字节级确定是 L2（重新计算内容哈希），
// 对模型权重这种体积的产物不划算，这里也没实现。

const ARTIFACT_STORE_ERROR_CODES = Object.freeze({
  NOT_FOUND: 'ARTIFACT_NOT_FOUND',
  TYPE_CONFLICT: 'ARTIFACT_TYPE_CONFLICT',
  FINGERPRINT_CONFLICT: 'ARTIFACT_FINGERPRINT_CONFLICT',
  UNAVAILABLE: 'ARTIFACT_STORE_UNAVAILABLE',
})

// Store 不得提供任何「隐式取最新版本」的方法：恢复时重新绑定的是原始版本，
// 而 artifact_id 本身就命名了一个不可变的版本。只写在文档里的禁止不算禁止，
// 所以在构造时就把这些方法名挡掉。
const FORBIDDEN_STORE_METHODS = Object.freeze([
  'getLatestByLineage',
  'getLatest',
  'resolveLatest',
  'latestRevision',
  'findLatest',
])

function storeError(code, message, details = {}) {
  const err = new Error(message)
  err.code = code
  Object.assign(err, details)
  return err
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// 校验注入进来的 store 形状。在执行器构造时验一次：形状不对要当场失败，
// 而不是等到重启恢复那一刻才炸。
function assertReadOnlyArtifactStore(store) {
  if (!isObject(store) && typeof store !== 'function') {
    throw storeError('ARTIFACT_STORE_INVALID', 'artifactStore must be an object')
  }
  if (typeof store.describe !== 'function') {
    throw storeError('ARTIFACT_STORE_INVALID', 'artifactStore must implement describe(artifact_id)')
  }
  for (const forbidden of FORBIDDEN_STORE_METHODS) {
    if (typeof store[forbidden] === 'function') {
      throw storeError(
        'ARTIFACT_STORE_INVALID',
        `artifactStore must not expose '${forbidden}': implicit latest-revision lookup breaks FLOW-D10 R1 Q5`,
        { forbidden_method: forbidden },
      )
    }
  }
  return store
}

// 把 Store 的一个描述符与 Run Journal 里记的快照条目比对。纯函数：不 IO、不抛，
// 有冲突返回冲突描述符，没有返回 null。诊断信息只带 artifact_id / type /
// fingerprint，都是不透明标识符，不含内容。
function reconcileArtifactDescriptor(key, expected, descriptor) {
  const conflict = (code, extra = {}) => ({ key, code, artifact_id: expected.artifact_id, ...extra })

  if (descriptor === null || descriptor === undefined) {
    return conflict(ARTIFACT_STORE_ERROR_CODES.NOT_FOUND)
  }
  if (!isObject(descriptor)) {
    return conflict(ARTIFACT_STORE_ERROR_CODES.NOT_FOUND, { reason: 'DESCRIPTOR_INVALID' })
  }
  // exists: false 是一个正式的答案，与返回 null 不同：Store 可能知道这个 id，
  // 但内容已经被回收。
  if (descriptor.exists === false) {
    return conflict(ARTIFACT_STORE_ERROR_CODES.NOT_FOUND)
  }
  // 描述符答的却是另一个 id，说明 Store 把这次查找解析成了别的东西，
  // 这正是禁止隐式取最新版本要挡的行为。
  if (descriptor.artifact_id !== undefined && descriptor.artifact_id !== expected.artifact_id) {
    return conflict(ARTIFACT_STORE_ERROR_CODES.NOT_FOUND, {
      reason: 'DESCRIPTOR_ID_MISMATCH',
      store_artifact_id: descriptor.artifact_id,
    })
  }
  if (expected.type !== null && expected.type !== undefined
    && descriptor.type !== null && descriptor.type !== undefined
    && descriptor.type !== expected.type) {
    return conflict(ARTIFACT_STORE_ERROR_CODES.TYPE_CONFLICT, {
      expected: expected.type,
      actual: descriptor.type,
    })
  }
  // 快照里指纹为 null 表示这条记录没有指纹可比：跳过指纹比对是向后兼容所必需，
  // 但跳过存在性检查不是（上面的检查已经跑过了）。
  if (expected.fingerprint !== null && expected.fingerprint !== undefined
    && descriptor.fingerprint !== null && descriptor.fingerprint !== undefined
    && descriptor.fingerprint !== expected.fingerprint) {
    return conflict(ARTIFACT_STORE_ERROR_CODES.FINGERPRINT_CONFLICT, {
      expected: expected.fingerprint,
      actual: descriptor.fingerprint,
    })
  }
  return null
}

// 收集快照里引用到的 artifact_ref 条目。只有 artifact_ref 才是 Store 的事：
// 拿内联的值去问 Store，会把一个完全合法的内联输入报成 ARTIFACT_NOT_FOUND。
function artifactRefsFromSnapshot(snapshot) {
  const refs = []
  for (const [key, entry] of Object.entries(snapshot || {})) {
    if (!isObject(entry) || entry.kind !== 'artifact_ref') continue
    if (!entry.artifact_id) continue
    refs.push({ key, artifact_id: entry.artifact_id, type: entry.type ?? null, fingerprint: entry.fingerprint ?? null })
  }
  return refs
}

// 内存里的参考 Store。只用于测试与本地单进程：没有持久性、没有跨进程可见性，
// 也不是生产用的 Artifact Store（后者按设计尚未实现）。ctx 收下但不用：留着这个
// 位置是为了将来出现用户模型时签名不必改，现在不定义任何权限语义，
// 因为现在定义的以后一定是错的。
function createMemoryArtifactStore(descriptors = {}) {
  const entries = new Map()
  for (const [artifactId, descriptor] of Object.entries(descriptors)) {
    entries.set(artifactId, { artifact_id: artifactId, exists: true, ...descriptor })
  }
  return {
    async describe(artifactId, _ctx = null) {
      if (!entries.has(artifactId)) return null
      return { ...entries.get(artifactId) }
    },
    async openContent(artifactId, _ctx = null) {
      throw storeError(
        'ARTIFACT_CONTENT_UNSUPPORTED',
        'memory artifact store does not serve content; content verification is L2 and out of the D10b slice',
        { artifact_id: artifactId },
      )
    },
  }
}

module.exports = {
  ARTIFACT_STORE_ERROR_CODES,
  FORBIDDEN_STORE_METHODS,
  assertReadOnlyArtifactStore,
  reconcileArtifactDescriptor,
  artifactRefsFromSnapshot,
  createMemoryArtifactStore,
}
