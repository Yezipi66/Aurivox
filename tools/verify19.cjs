#!/usr/bin/env node
/**
 * verify19 —— 19 号包（刀 B1：名片顶层键白名单 + verify17 的 SKIP 修复）的逐项验收。
 *
 * ⛔ 这个脚本验的是「装完之后仓库长什么样」，⛔ 不是「测试跑没跑过」。
 *    测试归 tools/run_tests.cjs。两者都要跑。
 *
 * 用法：node tools/verify19.cjs
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const R = (...p) => path.join(ROOT, ...p)
const read = (p) => { try { return fs.readFileSync(R(p), 'utf8') } catch { return null } }
const exists = (p) => fs.existsSync(R(p))

let pass = 0
const failed = []
function chk(name, ok, detail) {
  if (ok) { pass++; console.log(`  \u2714 ${name}`) }
  else { failed.push(`${name}${detail ? ` \u2014\u2014 ${detail}` : ''}`); console.log(`  \u2718 ${name}${detail ? ` \u2014\u2014 ${detail}` : ''}`) }
}

// ---------------------------------------------------------------------------
console.log('\n[B1] 名片顶层的键：认识的就这些')

const profile = read('lib/engines/profile.js')
chk('B1-1 profile.js 在', profile !== null)

chk('B1-2 有一张具名的 TOP_KEYS 顶层白名单',
  !!profile && /const\s+TOP_KEYS\s*=/.test(profile))

// ⭐ 名单必须是一张**明表**（字面量数组），⛔ 不许写成「以某个对象的键为准」。
//   写成 Object.keys(某schema) 的话，那个 schema 一动，闸门的松紧就跟着变，
//   而没有任何一处会提醒你「你刚刚放行了一个新键」。
{
  const m = profile && profile.match(/const\s+TOP_KEYS\s*=\s*([\s\S]{0,900}?)\)\s*\n/)
  const body = m ? m[1] : ''
  chk('B1-3 \u2b50 名单是字面量明表，\u26d4 不是 Object.keys(...) 推出来的',
    !!body && body.includes("'contract_version'") && !/Object\.keys/.test(body))
}

// 三张真名片上出现过的顶层键，一个都不许缺（缺一个 = 装不上）
{
  const need = ['contract_version', 'id', 'label', 'dir', 'upstream', 'local_changes',
    'install', 'models', 'weights', 'default_base_url', 'base_url_env', 'max_chars',
    'timeout_ms', 'capabilities', 'runtime', 'call', 'maps', 'payload_keys',
    'defaults', 'defaults_env', 'param_keys', 'params', 'output_formats']
  const missing = need.filter((k) => !profile || !profile.includes(`'${k}'`))
  chk(`B1-4 \u2b50\u2b50 23 个键一个不少（名单是量出来的，\u26d4 不是想出来的）`,
    missing.length === 0, missing.length ? `缺: ${missing.join(', ')}` : '')
}

chk('B1-5 有编辑距离，才给得出「你是不是想写 X」',
  !!profile && /function\s+editDistance/.test(profile))

// ⛔ 距离太远还硬猜会把人带沟里 —— 必须有上限。
chk('B1-6 \u26d4 建议有距离上限（距离太远就不猜）',
  !!profile && /nearestKey/.test(profile) && /best\s*[<>]=?\s*[0-9]|>\s*3|<=\s*3/.test(profile))

chk('B1-7 resolveEngineProfile 真的调了这道闸（\u26d4 不是写完没接上）',
  !!profile && /checkTopKeys\s*\(\s*manifest\s*\)/.test(profile))

// ⭐ 顺序：先查拼写、再查内容。反过来的话作者看到「缺少 max_chars」会去**再加一个**键，
//   于是 max_char 和 max_chars 并排躺着，前者永远没人读。
{
  const iCheck = profile ? profile.search(/checkTopKeys\s*\(\s*manifest\s*\)/) : -1
  const iCaps = profile ? profile.search(/const\s+caps\s*=/) : -1
  chk('B1-8 \u2b50\u2b50\u2b50 先查拼写、再查内容（checkTopKeys 在读内容之前）',
    iCheck > 0 && iCaps > 0 && iCheck < iCaps)
}

chk('B1-9 \u26d4 这道闸里不许出现任何一台引擎的 id',
  !!profile && !/gpt-sovits|gpt_sovits|indextts/i.test(
    (profile.match(/const\s+TOP_KEYS[\s\S]{0,3000}?function\s+checkTopKeys[\s\S]{0,2500}?\n}/) || [''])[0]))

chk('B1-10 B1 的守卫测试文件在', exists('lib/engines/profileTopKeys.node.test.js'))

// ---------------------------------------------------------------------------
console.log('\n[B1 顺带照出来的账] 夹具里那三个「写了没人读」的键')

// ⭐ 判据：一个键「写了没人读」和「根本不存在」，在今天之前的仓库里长得一模一样。
{
  const cli = read('lib/engines/hostProfileCli.node.test.js') || ''
  const fake = read('lib/engines/fakeEngine.node.test.js') || ''
  chk('X-1 hostProfileCli 夹具改用 contract_version（原本写的 manifest_version 契约里没有）',
    /contract_version:\s*2/.test(cli) && !/^\s*manifest_version:/m.test(cli))
  chk('X-2 \u26d4 两个名片夹具里不许再写 hard_max_chars（那是 max_chars\u00d72 算出来的）',
    !/^\s*hard_max_chars:/m.test(cli) && !/^\s*hard_max_chars:/m.test(fake))
  chk('X-3 hard_max_chars 仍然是 profile.js 算出来的（\u26d4 别把它一起删了）',
    !!profile && /hard_max_chars:\s*max_chars\s*\*\s*2/.test(profile))
}

// ---------------------------------------------------------------------------
console.log('\n[verify17] 假红修复：「全仓库」的单位是「会被跑到的文件」')

{
  const v17 = read('tools/verify17.cjs') || ''
  // cache/patch-backup/20260803-*/web/src/ 里躺着三周前的旧副本，
  // 被 FE 那条「全 web/src 没有裸读」当成活代码 ⇒ 假红。
  // ⛔ 不许因为沙箱树里没有 cache/ 就以为这条 SKIP 多余 —— 沙箱恒绿正是它被漏写的原因。
  chk('V-1 \u2b50\u2b50\u2b50 verify17 的 walk() 跳过 cache/（旧副本不是活代码）',
    /SKIP[\s\S]{0,200}?'cache'/.test(v17))
  chk('V-2 verify17 的 walk() 跳过 dist/（构建产物不是活代码）',
    /SKIP[\s\S]{0,200}?'dist'/.test(v17))
}

// ---------------------------------------------------------------------------
console.log('\n[契约] 裁决必须落在 docs/，\u26d4 不是聊天记录')

{
  const c = read('docs/ENGINE_CONTRACT.md') || ''
  chk('C-1 \u00a712.14 在（B1 的正文）', /##\s*\u00a712\.14/.test(c))
  chk('C-2 \u00a70 修订记录有修订 11 那一行', /\u4fee\u8ba2\s*11\uff09/.test(c))
  chk('C-3 \u00a712.14 里把 23 个键的名单写全了', /output_formats/.test(c) && /payload_keys/.test(c))
  chk('C-4 \u26a0 那条「顶层没有退休路」的冲突被记成【\u26d4 未裁决】，\u26d4 不是悄悄按一边实现',
    /\u9876\u5c42\u6ca1\u6709\u9000\u4f11\u8def[\s\S]{0,120}?\u672a\u88c1\u51b3/.test(c))
  chk('C-5 \u53f0\u8d26 B1 \u90a3\u4e00\u683c\u5df2\u6539\u6210 \u2705',
    /\|\s*\*\*B1\*\*[^\n]*\u2705\s*\*\*\u5b8c\u6210 2026-08-31\*\*/.test(c))
}

// ---------------------------------------------------------------------------
console.log('\n[\u7eb5\u8f74] \u9489\u5b50\u6570')

{
  const c = read('docs/ENGINE_CONTRACT.md') || ''
  // B1 这道闸里没有任何引擎名字 ⇒ 钉子数**不该变**。
  chk('N-1 \u5951\u7ea6\u7684 NAILS \u6807\u8bb0\u4ecd\u662f 22 \u884c / 12 \u6587\u4ef6（B1 \u4e0d\u5e94\u8be5\u6539\u53d8\u5b83）',
    /<!--\s*NAILS:\s*code=22\s+files=12\s*-->/.test(c))
}

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(62))
console.log(`verify19: ${pass} \u9879\u8fc7 / ${failed.length} \u9879\u6ca1\u8fc7 \uff08\u5171 ${pass + failed.length} \u9879\uff09`)
if (failed.length) {
  console.log('\n\u6ca1\u8fc7\u7684\uff1a')
  for (const f of failed) console.log(`  \u2718 ${f}`)
}
console.log('\n\u26a0 \u8fd9\u4e2a\u811a\u672c\u9a8c\u4e0d\u4e86\u7684\uff08\u5fc5\u987b\u771f\u673a\u4eba\u8089\u8d70\uff09\uff1a')
console.log('  \u00b7 \u62ff\u4e00\u5f20\u771f\u540d\u7247\u6545\u610f\u5199\u9519\u4e00\u4e2a\u9876\u5c42\u952e\uff0c\u754c\u9762\u4e0a\u770b\u5230\u7684\u62a5\u9519\u597d\u4e0d\u597d\u61c2')
console.log('  \u00b7 \u4e24\u53f0\u771f\u5f15\u64ce\u88c5\u5b8c\u4e4b\u540e\u662f\u4e0d\u662f\u4e00\u53f0\u90fd\u6ca1\u88ab\u8fd9\u9053\u95f8\u62e6\u4e0b')
process.exitCode = failed.length ? 1 : 0
