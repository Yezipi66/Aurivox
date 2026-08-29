#!/usr/bin/env node
'use strict'
/**
 * emit_profile —— 把一张 manifest.json 解析成 host.py 要的那份「名片解析结果」
 *
 *   node tools/dev/emit_profile.cjs indextts2
 *   node tools/dev/emit_profile.cjs indextts2 --out outputs/ab/indextts2.profile.json
 *   node tools/dev/emit_profile.cjs indextts2 | python lib/engines/host.py --profile-json - --port 9882
 *
 * ⭐ 为什么要有这个文件：
 *   `lib/engines/host.py` 起不来的时候，它自己的报错里写着
 *       node tools/dev/emit_profile.cjs <引擎id> | python lib/engines/host.py --profile-json -
 *   —— 但这个文件**当时并不存在**。报错指向一个不存在的命令，比不报错更糟：
 *   照着敲的人会以为是自己环境的问题。这一笔就是来还这个账的。
 *
 * ⛔ 这里**不重新实现**任何解析逻辑，只是 lib/engines/hostProfile.js 的一层
 *   命令行皮。解析写两遍迟早分叉，而分叉出来的症状是「探针全绿但真机起不来」。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')

function die (code, msg, hint) {
  process.stderr.write('[emit_profile] ' + msg + '\n')
  if (hint) process.stderr.write('   ' + hint + '\n')
  process.exit(code)
}

function main (argv) {
  const args = argv.slice(2)
  if (!args.length || args[0] === '-h' || args[0] === '--help') {
    process.stderr.write(
      'emit_profile —— 把 manifest.json 解析成 host.py 要的名片\n\n' +
      '  node tools/dev/emit_profile.cjs <引擎id> [--out <文件>]\n\n' +
      '不给 --out 就打到 stdout（可以直接管道给 host.py --profile-json -）。\n')
    process.exit(args.length ? 0 : 2)
  }

  const id = args[0]
  if (id.startsWith('-')) {
    die(2, '第一个参数要是引擎 id，不是选项：' + id)
  }

  let out = null
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--out') {
      out = args[i + 1]
      if (!out) die(2, '--out 后面要跟文件名')
      i++
    } else {
      die(2, '不认识的选项：' + args[i])
    }
  }

  let buildHostProfile
  try {
    ({ buildHostProfile } = require(path.join(ROOT, 'lib', 'engines', 'hostProfile.js')))
  } catch (err) {
    die(2, '加载不了 lib/engines/hostProfile.js：' + err.message,
      '这个脚本只是它的命令行皮，解析逻辑只有那一份。')
  }

  let profile
  try {
    profile = buildHostProfile(id)
  } catch (err) {
    // ⭐ hostProfile.js 的报错是**点名的**（哪个引擎、哪个字段、为什么），
    //   原样交出去，别在这里包一层含糊的「解析失败」把它盖掉。
    die(2, '解析 ' + id + ' 的名片失败：' + err.message)
  }

  const text = JSON.stringify(profile, null, 2) + '\n'

  if (!out) {
    process.stdout.write(text)
    return 0
  }

  const abs = path.resolve(out)
  const dir = path.dirname(abs)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(abs, text, 'utf8')
  process.stderr.write('[emit_profile] ' + id + ' → ' + abs +
    '（' + Buffer.byteLength(text) + ' 字节）\n')
  return 0
}

process.exit(main(process.argv))
