'use strict';

// ===========================================================================
//  合成结果复用缓存
// ===========================================================================
//
// 为什么要有它 —— 2026-08-23 真机实测（RTX 3070 Laptop / GPT-SoVITS）：
//
//     耗时 ≈ 2.49 秒（固定开销） + 1.44 秒 × 段数
//
//     64 字  =  3 段 =  6.8 秒
//     640 字 = 30 段 = 45.6 秒
//
// 也就是说 640 字的稿子改一句话，今天要把另外 29 段**一模一样的音频**重新推
// 一遍。而两次推理在输入完全相同时是幂等的（差异只有 ±1 LSB，约 −88 dB，
// 见 lib/services/synthesisService.js 里那段实测注释）。改一句 ⇒ 45.6 秒
// 应该变成 3.9 秒，省 91%。
//
// ⭐ 顺带否掉了一个假两难：曾以为「分段（可复用）」和「engine_batch（快）」
//    必须二选一。实测 engine_batch 只快 5.0%（43.3 vs 45.6 秒，且只跑了一次，
//    落在抖动范围里）—— 它拿「放弃分段文件 + 放弃 silence_ms 控制」换 5%，
//    在 91% 面前不值一提。分段复用可以放心做。
//
// ---------------------------------------------------------------------------
//  ⭐⭐ 指纹怎么算 —— 这是整个文件唯一真正危险的地方
// ---------------------------------------------------------------------------
//
// 缓存出错的后果不是慢，是**返回一段错的音频，而且不报错**。指纹漏掉任何一个
// 会影响输出的输入，就会发生。
//
// 所以这里**不枚举参数名**。曾经的方案是「从名片 param_keys 取并集，逐个塞进
// 指纹」—— 那是第二份参数表（契约 C11 禁止的东西），而且我在别处已经用亲身
// 经历证明过手写键名清单一定会漏（丙刀时手写 6 个字段，当场漏了 batch_size）。
//
// 现在指纹的原料是**真正发给引擎的那个 payload 对象本身**：
//
//     buildTtsPayload(...) 之后、applyEngineKnobs(...) 之后、gsvPost 之前
//
// 在那一刻，payload 里有且仅有这次推理的全部输入。指纹它 ⇒ 「漏一个键」在
// 构造上不可能发生，除非有人主动把键删掉。这也正是缓存挂在 generateOneSegment
// 内部、而不是挂在 synthesisService 分段循环里的原因：分段循环手上只有 cfg，
// 它得自己再拼一次 payload，那就是第二条装配线，迟早和真的那条漂开。
//
// payload 装不下的输入，只有三样，必须显式补：
//
//   1. **权重文件**。它不走 payload，走 switchModels（/set_gpt_weights）。
//      换了权重同一段文本当然是另一个声音。⚠ 权重是 GB 级的，不能算内容哈希
//      （那比推理还慢）⇒ 用 路径 + 字节数 + mtime。
//   2. **参考音频的内容**。payload 里只有一个路径字符串。用户完全可能在同一个
//      路径上换一个 wav —— 路径没变，声音变了。参考音频只有 3~10 秒，
//      内容哈希很便宜，所以这里算真哈希。
//   3. **引擎地址**。同一份名片指到另一台机器上的引擎，payload 一个字都不变，
//      但那可能是另一个版本、另一套模型。
//
// ---------------------------------------------------------------------------
//  为什么没有索引文件
// ---------------------------------------------------------------------------
//
// **内容寻址**：条目的文件名就是指纹。命中 = 那个文件在盘上，miss = 不在。
//
// 于是「索引和盘上文件漂移」这个问题根本不存在，不需要在删除音频、清空历史、
// 用户手删文件之后维护任何东西。GET /api/outputs 那种全目录扫描 + 逐个读
// meta.json 的做法（lib/routes/outputs.js:53）也不会在这里重演。
//
// ⛔ 缓存目录**独立于 outputs/**。outputs/ 是用户的东西，他随时可以删；
//    缓存是平台的东西。引用 outputs/ 里的文件迟早烂掉 —— 这也是 Owner
//    定「复制不引用」的原因：命中后把字节交出去，由调用方照常写进它自己的
//    产物目录，缓存文件从不被别人指着。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FINGERPRINT_VERSION = 2;

// 缓存总量上限。超了就按最后使用时间从旧到新删，直到降到 90%。
// 一段 3~5 秒的 wav 大约 200~400 KB ⇒ 2 GB 约等于五六千段。
const DEFAULT_MAX_MB = 2048;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * 稳定序列化：键名排序，保证 {a:1,b:2} 和 {b:2,a:1} 指纹相同。
 *
 * ⚠ 必须自己递归走一遍，不能用 JSON.stringify(obj, Object.keys(obj).sort())
 *   —— 后者只排最外层，嵌套对象（比如整包 engine_params）不排。键序在
 *   JS 里取决于插入顺序，而 payload 是好几处代码分别往上盖出来的。
 */
function stableStringify (value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * 文件的「身份」。
 *
 * @param {boolean} byContent true = 算内容哈希（小文件，比如参考音频）
 *                            false = 路径+大小+mtime（大文件，比如模型权重）
 *
 * ⛔ 读不到时返回一个**每次都不同**的值，而不是 null，也不是干脆跳过这一项：
 *   文件读不出来时我们并不知道它变没变。让指纹变成一个不可能命中的值，
 *   最坏结果是白推一次（慢）；跳过它的最坏结果是和另一个请求撞上（错音频）。
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

/**
 * 从名片上问出「payload 里哪几个键装的是参考音频的路径」。
 *
 * ⛔ 不许写死 'ref_audio_path' —— 那是 GPT-SoVITS 的私有键名，契约 §5.5
 *   明写平台只搬运不翻译。名片的 maps.reference_audio / maps.aux_reference_audio
 *   才是权威（gpt-sovits 名片里分别是 ref_audio_path / aux_ref_audio_paths）。
 */
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
    // 指纹算法的版本号。改了取材方式（多算一样、少算一样、换了归一化）就必须
    // 把 FINGERPRINT_VERSION 加一，否则老条目会继续被命中 —— 而它们是按旧规则
    // 算出来的，等于用错误的钥匙开对的锁。做成可注入是为了能被测试真的验到：
    // 只写成常量的话，「版本号没进指纹」这个错误在测试里没有任何可观察后果。
    version = FINGERPRINT_VERSION,
  } = opts;
  if (!dir) throw new Error('createSegmentCache requires a dir');

  // ⛔ `ensured` 这个闩锁曾经在说谎：它宣称"目录保证在"，实际只保证
  //   "本进程启动之后建过一次"。目录在进程活着的时候是会消失的 ——
  //   stop.bat 清理、用户手删 cache\、杀软隔离、外置盘掉线。一旦消失，
  //   之后每一段写入都是 ENOENT，而"缓存写不进去是小事"的兜底又保证了
  //   合成照常成功 ⇒ 这一刀会**静默退化成空操作**：日志里一直在喊，
  //   命中率一直是 0%，功能宣称省 91% 而实际省 0%。
  //   所以 ENOENT 必须把闩锁打回去重建目录，而不是余生每段都失败。
  let ensured = false;
  const ensureDir = () => {
    if (ensured) return;
    fsImpl.mkdirSync(dir, { recursive: true });
    ensured = true;
  };
  /** 承认"目录可能已经不在了"，下次 ensureDir() 会真的去建。 */
  const forgetDir = () => { ensured = false; };

  const entryPath = (key) => path.join(dir, `${key}.wav`);

  /**
   * 一次推理的完整指纹。
   *
   * @param {object}  a.profile  引擎名片
   * @param {object}  a.payload  ⭐ 真正要发给引擎的那个对象（承重的就是它）
   * @param {object}  a.cfg      平台侧配置，只从里面取权重路径
   */
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
      // 权重不走 payload，走 /set_*_weights。漏了它 = 换了音色还命中旧音频。
      weights: {
        gpt: fileIdentity(fsImpl, cfg.gpt_model, false),
        sovits: fileIdentity(fsImpl, cfg.sovits_model, false),
      },
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
    // 记一笔"刚用过"，给淘汰用。失败不影响命中（只读盘也无所谓）。
    try { const now = new Date(); fsImpl.utimesSync(p, now, now); } catch { /* ignore */ }
    return buf;
  }

  /**
   * 存一段。
   *
   * ⛔ 先写临时文件再 rename：直接往目标文件上写，进程写到一半被杀
   *   （用户按了 stop.bat）会在盘上留下一个**长度不对但文件名是正确指纹**的
   *   wav —— 下次它会被当成命中，用户听到半截音频，而且没有任何东西会报错。
   *   rename 在同一个文件系统内是原子的。
   */
  function put (key, bytes) {
    if (!enabled || !key || !bytes || bytes.length === 0) return false;
    // 两次机会：第一次照常写；若因为目录没了而 ENOENT，重建目录再试一次。
    // ⛔ 只自愈一次 —— 目录是真的建不出来（盘符不存在、无权限、路径非法）时，
    //   重试只会让每一段都空转两遍，而且把真正的错误刷屏两次。
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
        // ⭐ 重建之后还是 ENOENT，说明不是"目录被删了"这么简单，
        //   而是这个路径本身就落不了地。把它打出来 —— 它受 CACHE_DIR
        //   环境变量影响（lib/paths.js），排障时第一个要看的就是它。
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
    // 降到 90%，不是刚好降到线上 —— 否则每存一段都要扫一次盘。
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

  /** 统计，给设置页和验收脚本用。 */
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

  /** 全清。 */
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
