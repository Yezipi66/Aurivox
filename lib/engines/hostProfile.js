'use strict'

// ---------------------------------------------------------------------------
//  hostProfile.js —— 交给通用宿主 lib/engines/host.py 的那份 JSON
// ---------------------------------------------------------------------------
//
// 为什么这是**单独一个文件**，而不是往 profile.js 上加四个字段：
//
//   量过：`resolveEngineProfile()` 今天有 9 个 JS 消费方（synthesisService /
//   payload / paramTable / envCheck / voices / flowgraph / gsv client /
//   routes/synthesis / server.js）。它们碰 `call` / `params.load_time` /
//   `output_formats` 的次数是 **0**。
//
//   ⇒ 这四段只有 host.py 一个消费者。把它们塞进 resolveEngineProfile，
//     等于为 1 个消费者拓宽 9 个消费者共用的接口，而且每加一个字段，
//     那 9 处的形状假设就多一分漂移的机会 —— 我们刚被形状漂移咬过一次
//     （`requires_reference_audio` 那两道 400 静默消失）。
//
//   ⇒ 所以：**加法，不改动**。profile.js 一个字节不动，这里在它外面套一层。
//     `buildHostProfile()` 的输出 = resolveEngineProfile 的全部 + 这四段。
//
// ⛔ 这个文件里不许出现任何具体引擎的名字。
//
// 谁调它：
//   - launchPlan.js 算 `{profile_json}` 占位符时（把结果落成临时文件）
//   - tools/dev/probe_profile_contract.py 验收时

const { resolveEngineProfile } = require('./profile')
const { requireEngine } = require('./registry')

function bad(id, field, why) {
  const err = new Error(
    `引擎 ${id} 的名片 ${field} ${why} —— 通用宿主靠它才知道怎么调这台引擎，` +
    `请在 engines/${id}/manifest.json 里补上。`)
  err.code = 'ENGINE_HOST_CONTRACT_INVALID'
  err.field = field
  return err
}

// ---------------------------------------------------------------------------
//  call —— 「怎么调这台引擎的 Python 类」
// ---------------------------------------------------------------------------
//
// ⭐⭐ 注意 `call.bind` 和顶层 `maps` 不是一回事，别合并：
//
//     平台 --HTTP(maps / payload_keys)--> host.py --python(call.bind)--> 上游类
//
//   `maps`      管第一段：平台的词 → HTTP JSON 的键名。payload.js 在用。
//   `call.bind` 管第二段：平台的词 → 上游**方法参数**的名字。
//
//   在某些引擎上两者恰好长得一样，那是巧合。删掉 shim 之后两段都还在。
const CALL_KEYS = Object.freeze([
  'kind', 'module', 'class', 'init_args', 'method', 'bind', 'returns', 'seed',
])

// host.py 认得的 bind 槽位。`text` 是唯一无条件必填的
// （没有文本就没有 TTS）；另外两个按条件必填，见下。
const BIND_SLOTS = Object.freeze(['text', 'ref_audio', 'output_path'])

function parseCall(manifest, id) {
  const call = manifest.call
  if (!call || typeof call !== 'object') {
    throw bad(id, 'call', '整段都没有')
  }

  for (const k of Object.keys(call)) {
    if (!CALL_KEYS.includes(k)) {
      throw bad(id, `call.${k}`, `不是认得的键（认得的有：${CALL_KEYS.join(', ')}）`)
    }
  }

  // kind 目前只支持 python。写别的当场喊，不要等到宿主起来才发现。
  const kind = call.kind || 'python'
  if (kind !== 'python') {
    throw bad(id, 'call.kind', `写的是 "${kind}"，通用宿主目前只会 "python"`)
  }

  for (const k of ['module', 'class', 'method']) {
    if (!call[k] || typeof call[k] !== 'string') {
      throw bad(id, `call.${k}`, '缺了或者不是字符串')
    }
  }

  const bind = call.bind
  if (!bind || typeof bind !== 'object') throw bad(id, 'call.bind', '整段都没有')
  for (const k of Object.keys(bind)) {
    if (!BIND_SLOTS.includes(k)) {
      throw bad(id, `call.bind.${k}`, `不是认得的槽位（认得的有：${BIND_SLOTS.join(', ')}）`)
    }
  }
  if (!bind.text) throw bad(id, 'call.bind.text', '缺了 —— 没有文本就没有 TTS')

  const returns = call.returns || 'file'
  if (returns !== 'file' && returns !== 'bytes') {
    throw bad(id, 'call.returns', `写的是 "${returns}"，只能是 "file" 或 "bytes"`)
  }
  // ⭐ returns=file ⇒ 宿主要开一个临时文件塞给上游，它必须知道那个参数叫什么。
  if (returns === 'file' && !bind.output_path) {
    throw bad(id, 'call.bind.output_path',
      '缺了 —— call.returns = "file" 时宿主要把临时文件路径递给上游')
  }

  // ⭐ 参考音频：名片顶层说了要，bind 里就必须有槽位接它。
  //   否则宿主会 400 拦下"没给参考音频"的请求，然后在给了的时候把它丢掉。
  if (manifest.capabilities && manifest.capabilities.requires_reference_audio &&
      !bind.ref_audio) {
    throw bad(id, 'call.bind.ref_audio',
      '缺了 —— 这台引擎声明了 requires_reference_audio，宿主得知道参考音频传给哪个参数')
  }

  // seed 由 host.py 的 SeedPlan 做完整校验（契约 §5.2.1 的三态）。
  // ⛔ 这里**不重复**那套判断 —— 两处各写一遍必然分叉，宿主那份才是唯一权威。
  //   这里只确认它在场：不在场是名片没写完，不是宿主的问题。
  if (call.seed === undefined) {
    throw bad(id, 'call.seed',
      '缺了 —— 契约 §5.2.1 要求每张名片显式声明可复现性（"none" 也是一个合法答案）')
  }

  return JSON.parse(JSON.stringify(call))
}

// ---------------------------------------------------------------------------
//  params —— 加载期 / 调用期两张白名单
// ---------------------------------------------------------------------------
//
// ⭐⭐ 为什么不复用已有的 `payload_keys`：量过两台真引擎，用法不一致 ——
//   一台的 payload_keys 是干净的「引擎私有参数」，另一台却把 text /
//   ref_audio_path / seed 这些核心键也列了进去。拿它当调用期白名单，
//   后者上「加载期参数出现在调用里」和「不认识的参数」两道 400 都会判错。
//   ⇒ 必须是独立的两张表。
//
// 两类的区别是**生命周期**，不是风格：
//   load_time  构造引擎对象时用，改它要重启进程
//   call_time  每次推理都可以不一样
function parseParams(manifest, id) {
  const params = manifest.params || {}
  if (typeof params !== 'object') throw bad(id, 'params', '不是一个对象')

  const out = {}
  for (const slot of ['load_time', 'call_time']) {
    const v = params[slot]
    if (v === undefined) throw bad(id, `params.${slot}`, '缺了（没有就写空数组 []）')
    if (!Array.isArray(v)) throw bad(id, `params.${slot}`, '不是数组')
    for (const k of v) {
      if (typeof k !== 'string' || !k) {
        throw bad(id, `params.${slot}`, '里面有不是字符串的项')
      }
    }
    out[slot] = v.slice()
  }

  // ⛔ 同一个名字不能既是加载期又是调用期 —— 那样两道 400 会互相打架，
  //   而且没人说得清改了它到底要不要重启。
  const both = out.load_time.filter((k) => out.call_time.includes(k))
  if (both.length) {
    throw bad(id, 'params', `这些名字同时出现在 load_time 和 call_time 里：${both.join(', ')}`)
  }

  if (params.schema !== undefined) out.schema = params.schema
  return out
}

// ---------------------------------------------------------------------------
//  output_formats —— 「要 mp3」那条 400 的判据
// ---------------------------------------------------------------------------
// 不写 = 只出 wav。这是安全的默认：宿主本来就只会把字节原样送回，
// 转码是平台上层的事。
function parseOutputFormats(manifest, id) {
  const raw = manifest.output_formats
  if (raw === undefined || raw === null) return ['wav']
  if (!Array.isArray(raw) || !raw.length) {
    throw bad(id, 'output_formats', '要么别写（默认 ["wav"]），要么写一个非空数组')
  }
  return raw.map((f) => String(f).toLowerCase())
}

// ---------------------------------------------------------------------------
//  装配
// ---------------------------------------------------------------------------
function buildHostProfile(id, env = process.env) {
  const profile = resolveEngineProfile(id, env)
  const manifest = requireEngine(id)
  return Object.assign({}, profile, {
    call: parseCall(manifest, id),
    params: parseParams(manifest, id),
    output_formats: parseOutputFormats(manifest, id),
  })
}

module.exports = { buildHostProfile, CALL_KEYS, BIND_SLOTS }
