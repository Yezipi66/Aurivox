'use strict'

// 这台引擎的底模（权重）从哪来、齐不齐。
// 路径只写在 runtime.checkpoints 里，而那一行只有启动器读，界面上零展示 ⇒ 装的人
// 根本不知道该往哪儿放；安装计划（installPlan.js）从头到尾没有「拉底模」这一步 ⇒
// 放没放对、放齐没有，平台既不查也不说。表现是引擎起不来，而报错来自上游代码深处。
// 路径不在这里重写一遍，它就是 runtime.checkpoints：同一个事实两处写，迟早会不一致。
// 这一段只回答另外三个问题：听不听环境变量、哪几个文件算齐、拿不到时怎么办。
//
// source.command 是名片自己写的一条 argv，平台不认识任何下载器：HF、ModelScope、直链、
// 网盘，各家不同；平台一旦替谁生成命令，就等于把那一家写进 lib/，而且生成错了不会
// 报错，只会下到一半或者下错版本。名片说什么就打印什么，只打印不执行。
//
// external：有些运行必需的权重不是引擎自己带的，而是它的第三方包在 import 或运行时
// 拉下来的。引擎自己声明的那些之外，这一整类默认隐形：平台校验会通过，用户和平台
// 都不知道它存在。external 就是把它从隐形变成声明：名字、谁拉的、缺了会怎样。
// （parseUpstream 的「上游从哪来、钉在哪一版」也住在这里：同属「这台引擎的成品从哪
//   来」。）
const { plainObject, stringArray, profileError } = require('./fields')

const MODELS_KEYS = Object.freeze(['checkpoints_env', 'required', 'hint', 'source', 'external'])

// external 里每一项的键，刻意很少：它回答的是「这东西是什么」，不是「怎么装」。
const MODELS_EXTERNAL_KEYS = Object.freeze(['name', 'label', 'via', 'needed_by'])
const MODELS_SOURCE_KEYS = Object.freeze(['url', 'license_gate', 'command', 'cwd'])

// command 里允许出现的占位符。和 launchPlan.js 的那一套是同一批名字，但故意不 require
// 它：那个文件回答的是「怎么起进程」，跟下模型无关，为了共用三个字符串把两件事绑在
// 一起，改一边就得动另一边。
const MODELS_PLACEHOLDERS = Object.freeze(['root', 'engine_dir', 'checkpoints'])

const MODELS_SOURCE_CWDS = Object.freeze(['engine_dir', 'root'])

function parseModelsSource(manifest, raw) {
  if (raw === undefined || raw === null) return null
  const s = plainObject(manifest, 'models.source', raw)

  for (const k of Object.keys(s)) {
    if (!MODELS_SOURCE_KEYS.includes(k)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 manifest.json 里 models.source.${k} 平台不认识` +
        `认识的只有 ${MODELS_SOURCE_KEYS.join(' / ')}。`,
        { id: manifest.id, key: `models.source.${k}` })
    }
  }

  let command = null
  if (s.command !== undefined && s.command !== null) {
    if (!Array.isArray(s.command) || s.command.length === 0 ||
        s.command.some((x) => typeof x !== 'string' || !x.trim())) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 models.source.command 必须是一个非空的字符串数组` +
        '（argv 形式，例如 ["modelscope","download","--model","作者/仓库","--local_dir","{checkpoints}"]）' +
        '写成一整行命令会在带空格的路径上被拆错，那种错很难查。',
        { id: manifest.id, key: 'models.source.command', value: s.command })
    }
    command = s.command.map((x) => x.trim())
    // 占位符写错必须当场抛。写错了的表现是「命令原样打出来，用户照抄，下到一个叫
    // {checkpoint} 的目录里」：没有任何一步会报错。
    for (const part of command) {
      const found = String(part).match(/\{([a-z_]+)\}/g) || []
      for (const tok of found) {
        const name = tok.slice(1, -1)
        if (!MODELS_PLACEHOLDERS.includes(name)) {
          throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
            `引擎 ${manifest.id} 的 models.source.command 里有平台不认识的占位符 ${tok}` +
            `认识的只有 ${MODELS_PLACEHOLDERS.map((n) => `{${n}}`).join(' / ')}。`,
            { id: manifest.id, key: 'models.source.command', value: tok })
        }
      }
    }
    if (!command.some((x) => x.includes('{checkpoints}'))) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 models.source.command 里没有出现 {checkpoints}` +
        '那这条命令不会把模型下到平台要找的那个目录里，下完平台照样说"底模没放"。' +
        '如果这个下载器真的不接收目标目录，请去掉 command 只留 hint，把话说清楚让人手动放。',
        { id: manifest.id, key: 'models.source.command', value: command })
    }
  }

  const cwd = s.cwd === undefined || s.cwd === null ? 'engine_dir' : s.cwd
  if (!MODELS_SOURCE_CWDS.includes(cwd)) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 models.source.cwd 只能是 ${MODELS_SOURCE_CWDS.join(' / ')}，` +
      `现在写的是 ${JSON.stringify(s.cwd)}`,
      { id: manifest.id, key: 'models.source.cwd', value: s.cwd })
  }

  return {
    url: typeof s.url === 'string' && s.url.trim() ? s.url.trim() : null,
    // 「要先去网站上点同意才能下」。显式写出来，是因为它的失败长得像网络故障
    // （401/403），而真正的解法是去开一次浏览器：猜不出来的。
    license_gate: s.license_gate === true,
    command,
    cwd,
  }
}

/** models.external：第三方包在运行时拉的、但运行必需的权重。 */
function parseModelsExternal(manifest, raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 models.external 必须是一个数组`,
      { id: manifest.id, key: 'models.external' })
  }
  return raw.map((e, i) => {
    const o = plainObject(manifest, `models.external[${i}]`, e)
    for (const k of Object.keys(o)) {
      if (!MODELS_EXTERNAL_KEYS.includes(k)) {
        throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
          `引擎 ${manifest.id} 的 models.external[${i}].${k} 平台不认识` +
          `认识的只有 ${MODELS_EXTERNAL_KEYS.join(' / ')}。`,
          { id: manifest.id, key: `models.external[${i}].${k}` })
      }
    }
    for (const k of ['name', 'via', 'needed_by']) {
      if (typeof o[k] !== 'string' || !o[k].trim()) {
        throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
          `引擎 ${manifest.id} 的 models.external[${i}].${k} 缺了` +
          ' 这三项都是「缺了就说不清」的：名字是给人看的，via 是谁拉的，' +
          'needed_by 是缺了会怎样（不写就变成「不知道重不重要」）。',
          { id: manifest.id, key: `models.external[${i}].${k}` })
      }
    }
    return {
      name: o.name,
      label: o.label || o.name,
      via: o.via,
      needed_by: o.needed_by,
    }
  })
}

function parseModels(manifest) {
  const raw = manifest.models
  // 没写 models 段是合法的：那表示这台引擎没有需要单独放置的底模，或者作者还没
  // 来得及说。不能当成「底模缺失」：那是把「没说」当成「没有」。
  if (raw === undefined || raw === null) return null
  const m = plainObject(manifest, 'models', raw)

  for (const k of Object.keys(m)) {
    if (!MODELS_KEYS.includes(k)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 manifest.json 里 models.${k} 平台不认识` +
        `认识的只有 ${MODELS_KEYS.join(' / ')}。` +
        '通常是拼写错误（拼写错误被静默忽略，表现为体检一直说底模就绪，而实际未放置）。',
        { id: manifest.id, key: `models.${k}` })
    }
  }

  const required_files = stringArray(manifest, 'models.required', m.required)
  for (const f of required_files) {
    if (/^([A-Za-z]:[\\/]|[\\/])/.test(f)) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 models.required 里 ${JSON.stringify(f)} 是绝对路径` +
        '这里每一项都是**相对底模目录**的路径（例如 "config.yaml" 或 "v2/s2G2333k.pth"）。',
        { id: manifest.id, key: 'models.required', value: f })
    }
  }

  return {
    // 听哪个环境变量报底模目录（名字，不是值）。规矩与 base_url_env 一致：平台不认识
    // 任何具体的变量名，名片说听谁才去读谁。
    checkpoints_env: typeof m.checkpoints_env === 'string' && m.checkpoints_env.trim()
      ? m.checkpoints_env.trim() : null,
    // 哪几个文件在了才算「底模齐」。空数组 = 名片没说，平台只能报「目录在不在」。
    // 平台不替任何引擎猜必需文件名。
    required: required_files,
    hint: typeof m.hint === 'string' && m.hint.trim() ? m.hint.trim() : null,
    source: parseModelsSource(manifest, m.source),
    // 第三方包在运行时拉的、但运行必需的权重。空数组 = 这台引擎没有这一类。平台不去
    // 查它们在不在（那是那个包自己的事），只负责把它们说出来，让「隐形」变成「声明」。
    external: parseModelsExternal(manifest, m.external),
  }
}

// upstream：上游从哪来、钉在哪一版。上游源码不进仓库，commit 号是唯一必须留在 git 里
// 的上游信息：删了上游的 .git 之后再也拿不回来，丢了它安装脚本就不知道该拉哪一版。
// 严格程度故意分两处，不要合并：
// - 这里（合成路径要走的解析器）宽松：读不出来就交 null。一台引擎已经安装完成、
//   正在运行，不该因为「commit 未记录」而无法合成：那是把「档案不全」当成「引擎坏了」。
// - 拉源码那一侧严格：钉不出 commit 就不能把那一版确定下来。严格检查在
//   tools/engine-wizard/core/（clone.js / env.js，顺序在前、目录必须空）。
// - 真名片另有守卫测试（realManifests）盯着，保证我们自己这两台不许漏。
//
// 兼容旧写法：`"upstream": "https://..."` 这种裸字符串只有地址没有版本号。
// 不抛错，但 commit 交 null ⇒ 拉源码那一侧会拦下来并说清楚。
function parseUpstream(manifest) {
  const raw = manifest.upstream
  if (raw === undefined || raw === null) return null

  if (typeof raw === 'string') {
    const url = raw.trim()
    if (!url) return null
    return { url, commit: null, commit_unknown_reason: null, license: null }
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 manifest.json 里 upstream 必须是一个对象（或旧写法的地址字符串），` +
      `现在写的是 ${JSON.stringify(raw)}`,
      { id: manifest.id, key: 'upstream', value: raw })
  }

  const url = typeof raw.url === 'string' ? raw.url.trim() : ''
  if (!url) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 manifest.json 里 upstream.url 是空的` +
      '不写地址，安装的人无从知道这台引擎的源码该去哪儿拉。',
      { id: manifest.id, key: 'upstream.url', value: raw.url })
  }

  // commit 只认完整 40 位 sha。短 sha 会随仓库长大而歧义，标签和分支会移动，三者
  // 都答不了「半年后我还能不能装回一模一样的版本」。
  let commit = null
  if (raw.commit !== undefined && raw.commit !== null) {
    if (typeof raw.commit !== 'string' || !/^[0-9a-f]{40}$/.test(raw.commit.trim())) {
      throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
        `引擎 ${manifest.id} 的 upstream.commit 必须是完整的 40 位十六进制 sha，` +
        `现在写的是 ${JSON.stringify(raw.commit)}` +
        '短 sha 会随仓库长大而变得有歧义，分支和标签会移动，' +
        '这三种都回答不了「半年后还能不能装回一模一样的版本」。' +
        '真的没有就写 null，并在 upstream.commit_unknown_reason 里说清为什么。',
        { id: manifest.id, key: 'upstream.commit', value: raw.commit })
    }
    commit = raw.commit.trim()
  }

  // 写了 null 就必须说明为什么，与「这类数填了要说出处」是同一条道理。空着不是
  // 错，但空着而没有解释，半年后没人分得清是「拿不回来了」还是「忘了写」。
  const reason = typeof raw.commit_unknown_reason === 'string'
    ? raw.commit_unknown_reason.trim() : ''
  if (commit === null && 'commit' in raw && !reason) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 upstream.commit 写了 null 却没写 upstream.commit_unknown_reason` +
      '「拿不回来了」和「忘了写」必须能区分开：前者是既成事实，后者是待办。',
      { id: manifest.id, key: 'upstream.commit_unknown_reason' })
  }

  return {
    url,
    commit,
    commit_unknown_reason: reason || null,
    license: typeof raw.license === 'string' && raw.license.trim()
      ? raw.license.trim() : null,
  }
}

module.exports = {
  parseModelsSource, parseModelsExternal, parseModels, parseUpstream,
}
