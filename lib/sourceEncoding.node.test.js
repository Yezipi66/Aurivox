'use strict'

// 源码编码守卫：本项目的源码一律 UTF-8，且平台自己的 Python 脚本必须自己把
//   stdout 钉成 UTF-8，不依赖调用方传了什么环境。
//
// 为什么单独立一条：
//   中文 Windows 上 Python 的 stdout 默认是 cp936，`print(json.dumps(..., ensure_ascii=False))`
//   只要结果里出现一个 cp936 编不出来的字符就 UnicodeEncodeError，脚本以非零码退出。
//   调用方看到的是「验证器非零退出，这是探针自己出事」，于是去查一台根本没坏的引擎。
//
//   更隐蔽的是源码里混进 U+FFFD（替换字符）：文件在某个环节被按错误编码写过一次，
//   那一行中文就永久变成一串问号方块，而它看起来「只是注释」，没人会发现。
//   两个坑都在这里拦住：前者查 reconfigure，后者查替换字符。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
// 只看本项目自己写的代码。第三方缓存（浏览器用户目录里解出来的扩展）不归这里管。
const SCOPES = ['lib', 'tools/engine-wizard', 'web/src', 'server.js']
const EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.py', '.json', '.css', '.html'])
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv',
  'checkpoints', 'hf_cache', 'assets', 'dist'])
// Edge 的临时用户目录里是别人解压出来的扩展，别把它们算进本项目的账。
const SKIP_PATH = /tools[\\/]dev[\\/]_edge-verify/

function walk (target, out) {
  const abs = path.join(ROOT, target)
  if (!fs.existsSync(abs)) return out
  const st = fs.statSync(abs)
  if (st.isFile()) { out.push(abs); return out }
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const p = path.join(abs, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || SKIP_PATH.test(p)) continue
      walk(path.relative(ROOT, p), out)
    } else if (EXTS.has(path.extname(e.name).toLowerCase())) {
      out.push(p)
    }
  }
  return out
}

const FILES = SCOPES.flatMap((s) => walk(s, []))
const REPLACEMENT = Buffer.from([0xef, 0xbf, 0xbd]) // U+FFFD 的 UTF-8 编码

test('源码里不许有 U+FFFD：那是被错误编码写坏后留下的疤', () => {
  const bad = []
  for (const f of FILES) {
    const raw = fs.readFileSync(f)
    const n = raw.filter((b, i) => b === 0xef && raw[i + 1] === 0xbf && raw[i + 2] === 0xbd).length
    if (n > 0) bad.push(`${path.relative(ROOT, f)} (${n} 处)`)
  }
  assert.deepStrictEqual(bad, [],
    '这些文件里有替换字符 U+FFFD（原文已不可恢复，只能按上下文重写）：\n' + bad.join('\n'))
})

test('平台自己的 Python 脚本：向 stdout 输出就必须自己钉成 UTF-8', () => {
  const dir = path.join(ROOT, 'lib', 'engines')
  const scripts = fs.readdirSync(dir).filter((f) => f.endsWith('.py'))
  const offenders = []
  for (const name of scripts) {
    const src = fs.readFileSync(path.join(dir, name), 'utf8')
    // 有 print(...) 就说明会往 stdout 写；这时必须有 reconfigure。
    if (!/\bprint\(/.test(src)) continue
    if (!/sys\.stdout\.reconfigure\(/.test(src)) offenders.push(name)
  }
  assert.deepStrictEqual(offenders, [],
    '这些脚本会 print 到 stdout，却没有把编码钉成 UTF-8：\n' + offenders.join('\n'))
})

test('Node 侧启动 Python 时统一带 UTF-8 的 I/O 编码', () => {
  // 平台自带的探针都走 cleanPythonEnv；这里守的是「别有人另起一套 spawn 却不设编码」。
  const files = FILES.filter((f) => /\.(js|cjs|mjs)$/.test(f))
  const offenders = []
  for (const f of files) {
    if (/[\\/]test[\\/]/.test(f) || /\.test\.(js|cjs|mjs)$/.test(f)) continue
    const src = fs.readFileSync(f, 'utf8')
    // 只关心「spawn 一个 python 进程」的调用点：命令名里带 python，或参数里有 .py
    const spawnRe = /spawnSync?\([^)]*?(python|PYTHON|\.py['"])/s
    if (!spawnRe.test(src)) continue
    if (/cleanPythonEnv\(|PYTHONIOENCODING/.test(src)) continue
    // 平台解释器探测本身只问版本号，不解析中文输出，允许例外
    if (/pythonResolve\.js$/.test(f)) continue
    offenders.push(path.relative(ROOT, f))
  }
  assert.deepStrictEqual(offenders, [],
    '这些文件起了 Python 子进程却没统一 I/O 编码：\n' + offenders.join('\n'))
})

test('扫描范围本身不是空的（守卫自己别失效）', () => {
  assert.ok(FILES.length > 300, `只扫到 ${FILES.length} 个文件，范围写错了`)
  assert.ok(FILES.some((f) => f.endsWith('verify_audio.py')), '没扫到平台脚本')
  assert.ok(REPLACEMENT.length === 3)
})
