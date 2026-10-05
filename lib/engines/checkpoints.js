'use strict'

// ---------------------------------------------------------------------------
//  底模在哪、齐不齐 —— 名片声明的那一段落到盘上
// ---------------------------------------------------------------------------
// 2026-08-29。Owner 的原话是两句，这个文件回答的是这两句：
//   「你都读不到底模在哪里」
//   「上游要接入进来，他还得手动把模型放对」
//
// 在它之前，「底模」这个概念在平台里是**只属于 GPT-SoVITS 的**：
//   · 目录写死在 lib/paths.js 的 GSV_PRETRAINED_DIR
//   · 版本号（v2 / v2Pro / v2ProPlus）和文件名（s2G2333k.pth 之类）写死在
//     server.js 的 _BASE_SOVITS_DEFS
// 别家引擎的底模路径只活在名片的 runtime.checkpoints 里，而那一行**只有
// 启动器读**（host.py 的 {checkpoints} 占位符），界面上一个字都看不到。
// ⇒ 接入者放对了没有，只能靠引擎起不起得来事后倒推。
//
// ⭐ 本文件的立场和 runtime 那一段完全一致：**只验不建**。
//    它不下载、不创建目录、不移动任何文件，只回答三个问题：
//      在哪（含环境变量覆盖）· 在不在 · 名片说的那几个文件缺不缺
//    以及，缺的时候把名片自己写的那条取回命令**原样打印出来**。
//
// ⛔ 本文件里不许出现任何引擎名、任何下载器名（modelscope / huggingface /
//    git-lfs 一个都不许）。命令是名片写的，平台只填占位符。
//    checkpoints.node.test.js 有一条守卫盯着这件事。
//
// ⚠ 计划与执行分家（同 launchPlan.js）：这里算出来的
//   source.command 是一条**已经填好占位符、可以照抄**的 argv。谁去执行它是
//   另一件事（这一刀是人自己执行；真自动执行要联网，单独一刀）。

const fs = require('fs')
const path = require('path')
const { APP_DIR } = require('../paths')

// 目录里到底有几项。只用来给人一个"是不是空目录"的直觉 ——
// ⛔ 不拿它做任何判断：一个目录里有 16 个文件不代表是对的那 16 个。
function countEntries(abs) {
  try {
    return fs.readdirSync(abs).length
  } catch (_) {
    return null
  }
}

// 名片声明的底模目录 → 绝对路径。
//
// ⭐ 环境变量的规矩逐字照抄 base_url_env（profile.js:110 resolveBaseUrl）：
//   **由名片自己指定变量名**，平台不认识任何具体的变量名。
//   历史引擎靠这个继续工作（它的目录常量本来就是可以被环境变量顶掉的），
//   而 lib/ 里不会因此多出一个写死的变量名。
function resolveCheckpointsDir(profile, env, appDir) {
  const declared = (profile.runtime && profile.runtime.checkpoints) || null
  const envKey = (profile.models && profile.models.checkpoints_env) || null

  if (envKey && env[envKey]) {
    const v = String(env[envKey])
    return {
      declared,
      path: v,
      path_source: `env:${envKey}`,
      abs_path: path.resolve(appDir, v),
    }
  }
  if (!declared) {
    return { declared: null, path: null, path_source: null, abs_path: null }
  }
  return {
    declared,
    path: declared,
    path_source: 'manifest',
    abs_path: path.resolve(appDir, declared),
  }
}

function fillPlaceholders(parts, values) {
  return parts.map((p) =>
    String(p).replace(/\{([a-z_]+)\}/g, (whole, name) =>
      (Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole)))
}

/**
 * 一台引擎的底模现状。
 *
 * ⚠ 三态，别糊成两态（同 probeEngineOnline 的 online）：
 *     ready === true   名片说的文件一个不少
 *     ready === false  目录不在、或者名片点名的文件缺了
 *     ready === null   **说不出来** —— 名片没写路径，或者写了路径但没说
 *                      哪几个文件算齐。⛔ 这不是"齐"，也不是"缺"。
 *   糊成 false，会让一台其实好好的引擎永远挂着红灯；糊成 true，等于替名片
 *   作者担保了一件他从没说过的事。
 *
 * @param {object} profile  resolveEngineProfile() 的产物
 * @param {object} [opts]   { env, appDir } —— 测试用，默认 process.env / APP_DIR
 */
function checkpointStatus(profile, opts = {}) {
  const env = opts.env || process.env
  const appDir = opts.appDir || APP_DIR
  const models = profile.models || null

  const loc = resolveCheckpointsDir(profile, env, appDir)

  const out = {
    id: profile.id,
    // 名片有没有说底模在哪。⛔ 没说 ≠ 这台引擎不需要底模。
    declared: loc.path !== null,
    path: loc.path,
    path_source: loc.path_source,
    abs_path: loc.abs_path,
    exists: false,
    is_dir: false,
    entries: null,
    required: models ? models.required.slice() : [],
    missing: [],
    ready: null,
    reason: null,
    hint: models ? models.hint : null,
    source: null,
  }

  if (!out.declared) {
    out.reason = 'manifest.json 里没写 runtime.checkpoints —— 平台不知道这台引擎的底模该放在哪，也就没法替你检查'
    return out
  }

  let st = null
  try {
    st = fs.statSync(loc.abs_path)
  } catch (_) {}

  out.exists = st !== null
  out.is_dir = st !== null && st.isDirectory()
  if (out.exists && out.is_dir) out.entries = countEntries(loc.abs_path)

  if (!out.exists) {
    out.ready = false
    out.reason = `底模目录不存在：${loc.abs_path}`
  } else if (!out.is_dir) {
    out.ready = false
    out.reason = `底模路径存在但不是目录：${loc.abs_path}`
  } else if (out.required.length === 0) {
    // ⭐ 这一支就是"说不出来"。目录在，但名片没点名任何文件 ——
    //   平台**不猜**哪些文件算齐（猜错的两种表现都很糟：说齐了却起不来，
    //   或者明明齐了却一直红着）。这句话本身就是给名片作者看的催促。
    out.ready = null
    out.reason = `目录在（${out.entries} 项），但 manifest.json 的 models.required 没点名任何文件，平台说不出它齐不齐`
  } else {
    out.missing = out.required.filter((rel) => {
      try {
        fs.statSync(path.resolve(loc.abs_path, rel))
        return false
      } catch (_) {
        return true
      }
    })
    out.ready = out.missing.length === 0
    out.reason = out.ready
      ? null
      : `底模目录在，但少了 ${out.missing.length} 个文件：${out.missing.join(' / ')}`
  }

  // 取回办法。⛔ 平台不生成命令，只把名片写的那条填好占位符搬出来。
  if (models && models.source) {
    const s = models.source
    const engineDirAbs = path.resolve(appDir, profile.dir || path.join('engines', profile.id))
    out.source = {
      url: s.url,
      license_gate: s.license_gate,
      // 已经填好占位符、可以直接照抄的一条 argv。名片没写 command 就是 null
      // ——那表示"这个模型没有能一行拿下的办法"，请看 hint / url。
      command: s.command
        ? fillPlaceholders(s.command, {
          root: appDir,
          engine_dir: engineDirAbs,
          checkpoints: loc.abs_path,
        })
        : null,
      cwd: s.cwd === 'root' ? appDir : engineDirAbs,
    }
  }

  return out
}

// 一句人话。⭐ 单独抽出来，是因为它有两个消费者（安装脚本的收尾提示 +
// 界面的 title），两处各写一遍迟早会分叉成两种说法。
function describeCheckpointStatus(st) {
  if (st.ready === true) return `底模齐（${st.abs_path}）`
  if (st.ready === null) return st.reason || '底模状态未知'
  return st.reason || '底模不齐'
}

module.exports = { checkpointStatus, describeCheckpointStatus, resolveCheckpointsDir }
