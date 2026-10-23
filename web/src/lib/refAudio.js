// 参考音频的时长约束、默认选择与路径归一。
// 时长约束是平台侧的硬约束：超出后 /tts 返 400。
const REF_MIN_SEC = 3

const REF_MAX_SEC = 10

const refInRange = (dur) => typeof dur === 'number' && dur >= REF_MIN_SEC && dur <= REF_MAX_SEC

// 选出默认参考音频。segs 是候选参考的数组，每项有 exists / audio / audio_path /
// audio_filename / duration 字段。取第一条时长合规的；没有则取第一条存在的；都没有返回 null。
const pickDefaultRef = (segs) => {
  const usable = (segs || []).filter(s => s.exists !== false && (s.audio || s.audio_path || s.audio_filename))
  return usable.find(s => refInRange(s.duration)) || usable[0] || null
}

// 取最近生成条目里的参考音频文件名。参考音频可能记在 ref_audio 或 params.ref_audio 上。
function refBasename(item) {
  const raw = item?.ref_audio || item?.params?.ref_audio || ''
  if (!raw) return ''
  const parts = String(raw).split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

// 归一参考路径，使字符串、v3 对象与项目相对路径三种写法可以比较相等：
// 统一反斜杠，去掉开头的 "./" 或 "/" 与 assets/ 前缀。
// 托管参考按完整归一路径认定，不按文件名：assets/A/raw/x.wav 与 assets/B/raw/x.wav
// 是两份不同的参考，尽管文件名相同。
function normRefPath(p) {
  if (p == null) return ''
  // 既接受 v3 的托管参考对象 { base, path }，也接受纯字符串。
  const raw = (typeof p === 'object') ? (p.path || '') : p
  return String(raw)
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/^assets\//, '')
}

// 判断两个参考是否指向同一个文件（比较 base 与归一后的路径）。
function sameRefPath(a, b) {
  const na = normRefPath(a), nb = normRefPath(b)
  if (!na || !nb) return false
  return na === nb
}

export {
  REF_MIN_SEC,
  REF_MAX_SEC,
  refInRange,
  pickDefaultRef,
  refBasename,
  normRefPath,
  sameRefPath,
}
