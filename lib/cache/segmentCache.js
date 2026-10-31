'use strict';

// 合成结果复用缓存：内容寻址，条目文件名就是指纹，命中 = 文件在盘上，不需要索引文件。
// 指纹的原料是真正发给引擎的那个 payload 对象本身，不枚举参数名：漏掉一个键在构造上不可能发生。
// payload 装不下的三样输入必须显式补：权重（路径+字节数+mtime）、参考音频（内容哈希）、引擎地址；
// 缺一不可：缓存出错的后果不是慢，是返回一段错的音频而且不报错。
// 缓存目录独立于 outputs/：outputs/ 随时可删，命中后把字节交出去，缓存文件从不被引用。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 改了取材方式必须加一：老条目按旧规则算出的文件名依然「正确」，加一让整代自然失效。
// 2 → 3：权重从写死的两个 cfg 字段改成按名片 weight_slots 逐位取。
const FINGERPRINT_VERSION = 3;

// 缓存总量上限。超了就按最后使用时间从旧到新删，降到 90% 为止（不是刚好到线上，否则每存一段都要扫一次盘）。
const DEFAULT_MAX_MB = 2048;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * 稳定序列化：键名排序，保证 {a:1,b:2} 和 {b:2,a:1} 指纹相同。必须自己递归走一遍，不能用
 * JSON.stringify(obj, Object.keys(obj).sort())：后者只排最外层，嵌套对象不排，而键序取决于插入顺序。
 */
function stableStringify (value) {
 if (value === null || typeof value !== 'object') return JSON.stringify(value);
 if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
 const keys = Object.keys(value).sort();
 return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * 文件的「身份」。byContent true = 算内容哈希（小文件，比如参考音频），false = 路径+大小+mtime。
 * 读不出来时返回每次都不同的值，不返回 null 也不跳过这一项：跳过就不知道它变没变。
 */
function fileIdentity (fsImpl, filePath, byContent) {
 if (typeof filePath !== 'string' || filePath === '') return null;
 try {
 const st = fsImpl.statSync(filePath);
 if (byContent) return `sha:${sha256(fsImpl.readFileSync(filePath))}`;
 return `stat:${filePath}:${st.size}:${Number(st.mtimeMs).toFixed(0)}`;
 } catch {
 return `unreadable:${filePath}:${crypto.randomBytes(8).toString('hex')}`;
 }
}

/** 从名片上问出「payload 里哪几个键装的是参考音频的路径」。不许写死某个引擎的私有键名：
 * 名片的 maps.reference_audio / maps.aux_reference_audio 才是权威（平台只搬运，不翻译键名）。 */
function referencePayloadKeys (profile) {
 const maps = (profile && profile.maps) || {};
 return [maps.reference_audio, maps.aux_reference_audio]
 .filter((k) => typeof k === 'string' && k !== '');
}

function createSegmentCache (opts = {}) {
 const {
 dir,
 fsImpl = fs,
 maxBytes = (Number(process.env.AURIVOX_CACHE_MAX_MB) || DEFAULT_MAX_MB) * 1024 * 1024,
 logger = console,
 enabled = true,
 // 指纹算法的版本号。改了取材方式（多算一样、少算一样、换了归一化）就必须加一，否则老条目会继续被命中。
 version = FINGERPRINT_VERSION,
 } = opts;
 if (!dir) throw new Error('createSegmentCache requires a dir');

 // ensured 只保证「本进程启动之后建过一次」，目录在进程活着时也可能消失。消失后每次写入都是 ENOENT，
 // 而「写不进去是小事」的兜底保证合成照常成功，缓存会静默退化成空操作：所以 ENOENT 必须重建目录。
 let ensured = false;
 const ensureDir = () => {
 if (ensured) return;
 fsImpl.mkdirSync(dir, { recursive: true });
 ensured = true;
 };
 /** 承认目录可能已经不在了，下次 ensureDir() 会真的去建。 */
 const forgetDir = () => { ensured = false; };

 const entryPath = (key) => path.join(dir, `${key}.wav`);

/** 每个权重位当前选中的那一份的身份。位名也进指纹：两个位装同一份文件也分得开
 * （onboarding 里同名模型出现在两个位是合法的，换位就是换请求）。 */
 function weightIdentities (profile, cfg) {
 const out = {};
 for (const slot of ((profile && profile.weight_slots) || [])) {
 if (!slot || !slot.name) continue;
 const source = slot.param
 ? cfg[slot.param]
 : (cfg.launch_weights && cfg.launch_weights[slot.name]);
 out[slot.name] = fileIdentity(fsImpl, source, false);
 }
 return out;
 }

/** 一次推理的完整指纹。payload 取的是 buildTtsPayload 与 applyEngineKnobs 之后真正要发出去的那一份，
 * 不自己重拼：重拼就是第二条装配线，迟早和真的那条漂开。cfg 只从里面取权重路径。 */
 function fingerprint ({ profile, payload, cfg = {} }) {
 const refKeys = referencePayloadKeys(profile);
 // payload 的副本，把「路径字符串」换成「那个文件的身份」。
 const shaped = {};
 for (const k of Object.keys(payload || {})) {
 const v = payload[k];
 if (refKeys.includes(k)) {
 shaped[k] = Array.isArray(v)
 ? v.map((p) => fileIdentity(fsImpl, p, true))
 : fileIdentity(fsImpl, v, true);
 } else {
 shaped[k] = v;
 }
 }
 const material = {
 v: version,
 engine: {
 id: (profile && profile.id) || null,
 base_url: (profile && profile.base_url) || null,
 },
 payload: shaped,
 // 权重不走 payload，走切换请求。漏了它 = 换了音色还命中旧音频。
 // 哪些权重位、每个位叫什么，全问名片：call 位的值在 cfg[slot.param]，launch 位的值在
 // cfg.launch_weights[slot.name]。写死两个键名的话，第二台引擎换权重不会让缓存失效。
 weights: weightIdentities(profile, cfg),
 };
 return sha256(stableStringify(material));
 }

 /** 命中就返回音频字节，否则 null。以盘为准：文件在就是在。 */
 function get (key) {
 if (!enabled || !key) return null;
 const p = entryPath(key);
 let buf;
 try {
 buf = fsImpl.readFileSync(p);
 } catch {
 return null;
 }
 if (!buf || buf.length === 0) return null;
 // 记一笔"刚用过"，给淘汰用。失败不影响命中。
 try { const now = new Date(); fsImpl.utimesSync(p, now, now); } catch { /* ignore */ }
 return buf;
 }

/**
 * 存一段。先写临时文件再 rename：直接往目标文件上写，进程写到一半被杀会在盘上留下一个长度不对
 * 但文件名是正确指纹的 wav，下次它会被当成命中，用户听到不完整的音频，而且没有任何东西会报错。
 */
 function put (key, bytes) {
 if (!enabled || !key || !bytes || bytes.length === 0) return false;
 // 两次机会：若因为目录没了而 ENOENT，重建目录再试一次。只自愈一次：目录真的建不出来时重试只会空转两遍。
 for (let attempt = 0; attempt < 2; attempt++) {
 try {
 ensureDir();
 const tmp = path.join(dir, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
 fsImpl.writeFileSync(tmp, bytes);
 fsImpl.renameSync(tmp, entryPath(key));
 return true;
 } catch (e) {
 if (e && e.code === 'ENOENT' && attempt === 0) {
 forgetDir();
 continue;
 }
 // 缓存写不进去是小事，绝不能因此让这次合成失败。
 logger.warn(`[CACHE] 写入失败（不影响本次合成）: ${e.message}`);
 // 重建之后还是 ENOENT，说明这个路径本身就落不了地：把它打出来，它受 CACHE_DIR 环境变量影响。
 if (e && e.code === 'ENOENT') {
 logger.warn(`[CACHE] 缓存目录建不出来，分段复用已失效: ${dir}`);
 }
 return false;
 }
 }
 return false;
 }

 /** 总量超限时按最后使用时间淘汰。返回删掉的条目数。 */
 function sweep () {
 if (!enabled) return 0;
 let entries;
 try {
 entries = fsImpl.readdirSync(dir)
 .filter((n) => n.endsWith('.wav'))
 .map((n) => {
 const p = path.join(dir, n);
 try {
 const st = fsImpl.statSync(p);
 return { p, size: st.size, at: st.mtimeMs };
 } catch { return null; }
 })
 .filter(Boolean);
 } catch { return 0; }
 let total = entries.reduce((s, e) => s + e.size, 0);
 if (total <= maxBytes) return 0;
 const target = maxBytes * 0.9;
 entries.sort((a, b) => a.at - b.at);
 let removed = 0;
 for (const e of entries) {
 if (total <= target) break;
 try { fsImpl.unlinkSync(e.p); total -= e.size; removed++; } catch { /* 别人删了也行 */ }
 }
 if (removed) logger.log(`[CACHE] 清理了 ${removed} 段（总量超过 ${Math.round(maxBytes / 1048576)} MB）`);
 return removed;
 }

 function stats () {
 try {
 const names = fsImpl.readdirSync(dir).filter((n) => n.endsWith('.wav'));
 let bytes = 0;
 for (const n of names) {
 try { bytes += fsImpl.statSync(path.join(dir, n)).size; } catch { /* ignore */ }
 }
 return { enabled, entries: names.length, bytes, maxBytes, dir };
 } catch {
 return { enabled, entries: 0, bytes: 0, maxBytes, dir };
 }
 }

 function clear () {
 let removed = 0;
 try {
 for (const n of fsImpl.readdirSync(dir)) {
 if (!n.endsWith('.wav')) continue;
 try { fsImpl.unlinkSync(path.join(dir, n)); removed++; } catch { /* ignore */ }
 }
 } catch { /* 目录不存在 = 本来就是空的 */ }
 return removed;
 }

 return { fingerprint, get, put, sweep, stats, clear, enabled, dir };
}

module.exports = {
 createSegmentCache,
 stableStringify,
 referencePayloadKeys,
 FINGERPRINT_VERSION,
};
