// =============================================================================
//  start.node.test.js — tools/cli/start.js 的守卫
//
//  这份脚本里**最该被钉住**的不是它怎么起进程（那是 spawnDetached 的事，
//  ports.node.test.js 已经验过），而是两条纪律：
//
//   1. ⛔ 里面不许出现任何一台具体引擎的名字。理由在 start.ps1 时代的注释里：
//      「搬家前这里躺着五个 $ENGINE_* 变量，全是 GPT-SoVITS 专有的 ——
//      那等于一份写在启动脚本里的、谁也改不了的 manifest.json。
//      第三台引擎的作者会发现 manifest.json 写完了引擎还是起不来，因为得改
//      这个文件 —— 而那正是「加一台引擎不碰 lib/」这条标准要挡住的事。」
//   2. ⭐ 端口必须在**启动任何东西之前**全部定下来。后端是从环境变量继承
//      BROKER_PORT 与各台 base_url_env 的；spawn 之后再改就晚了。
//      而 spawnDetached 是**脱离**的 —— 父进程一退，改环境变量对它无效。
// =============================================================================

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const BODY = path.join(ROOT, 'tools', 'cli', 'start.js')
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ⭐⭐ 纪律 1：不许有具体引擎名
test('⛔ start.js 里不许出现任何一台具体引擎的名字', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice',
    'vox' + 'cpm', 'fish' + '-speech', 'chat' + 'tts']
  // ⛔ 只扫**活代码**：注释里说明来历的名字是文档，删了就没法解释为什么这么判。
  //   （这里踩过一次：守卫按整份文本判，结果主体里那段「它读 health.engine_online」
  //   之类的**说明性注释**也能把它判红。）
  const code = read('tools/cli/start.js')
    .split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  for (const bad of FORBIDDEN) {
    assert.ok(!code.toLowerCase().includes(bad),
      `start.js 的活代码里出现了「${bad}」—— 引擎知识只能来自 manifest.json`)
  }
})

// ⭐⭐ 纪律 2：端口必须全部先解完，再启动
test('⭐ 端口在启动任何东西之前就全部定下来', () => {
  const src = read('tools/cli/start.js')
  const firstResolve = src.indexOf('PC.resolvePort(')
  const firstSpawn = src.indexOf('P.spawnDetached(')
  assert.ok(firstResolve > 0, '找不到 resolvePort 调用')
  assert.ok(firstSpawn > 0, '找不到 spawnDetached 调用')
  assert.ok(firstResolve < firstSpawn,
    '⚠️ 有 spawn 发生在 resolvePort 之前。\n'
    + '   端口是通过**环境变量**交给后端与各台引擎的（BROKER_PORT 与各台的\n'
    + '   base_url_env），而 spawnDetached 出来的进程是脱离的 —— 它在启动那一刻\n'
    + '   就把环境变量拷走了。所以端口必须在第一个 spawn 之前全部定完，\n'
    + '   spawn 之后再改环境变量对已经跑起来的进程无效。')
})

// ⭐ 后端端口只能有一个来源：BROKER_PORT。它被 spawn 出来的后端继承。
test('后端端口写进 BROKER_PORT，不是硬塞给某处', () => {
  const src = read('tools/cli/start.js')
  assert.match(src, /process\.env\.BROKER_PORT\s*=/,
    '定下来的后端端口没有写进 BROKER_PORT')
})

// ⭐⭐ 每台引擎的端口通过**它自己的** base_url_env 变量名交给后端。
//   写死成 GPT_SOVITS_BASE_URL 就是「第二台引擎起来后端也连不上」的直接原因。
test('引擎端口经 base_url_env 传递，不写死变量名', () => {
  const src = read('tools/cli/start.js')
  assert.match(src, /e\.BaseUrlEnv/, '没有用名片给的 base_url_env 变量名')
  assert.match(src, /process\.env\[e\.BaseUrlEnv\]\s*=/,
    '没有把 URL 写进那个变量')
  // ⛔ 不许有硬编码的 *_BASE_URL 赋值
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')
  const hard = code.match(/\b[A-Z][A-Z0-9_]*_BASE_URL\s*=/g)
  assert.ok(!hard, '出现了硬编码的 BASE_URL 赋值：' + JSON.stringify(hard))
})

// ⭐ 薄壳纪律：.bat / .sh 都调同一份主体，且不含逻辑
test('start 的薄壳都调同一份 Node 主体，且不含逻辑', () => {
  for (const rel of ['start.bat', 'tools/scripts/start.bat', 'tools/scripts/start.sh']) {
    const src = read(rel)
    assert.match(src, /start\.js/, `${rel} 没有指向主体`)
    assert.ok(!/resolvePort|listenersOnPort|spawnDetached|base_url_env/.test(src),
      rel + ' 薄壳里出现了主体逻辑 ⇒ 两边会行为分叉')
  }
})

// ⭐⭐ .bat 必须纯 ASCII（实测踩过，见 install-torch.bat 头部的长说明）
test('start.bat / tools\\scripts\\start.bat 是纯 ASCII', () => {
  for (const rel of ['start.bat', 'tools/scripts/start.bat', 'tools/scripts/stop.bat',
    'tools/deploy/install-torch.bat']) {
    const buf = fs.readFileSync(path.join(ROOT, rel))
    const bad = [...buf].filter(b => b > 127).length
    assert.equal(bad, 0,
      `${rel} 里有 ${bad} 个非 ASCII 字节。cmd.exe 按系统 OEM 代码页（本机 GBK）`
      + '读 .bat，而本文件是 UTF-8 ⇒ GBK 解码会把行尾 0x0A 当成双字节字符的'
      + '后半截吃掉，换行错位，cmd 于是把注释碎片当命令执行。中文请放 Node 主体。')
  }
})

// ⭐ 反向：旧实现不许复存在（两份实现 = 迟早不一致）
test('旧的 start.ps1 已不存在', () => {
  for (const rel of ['tools/scripts/start.ps1']) {
    assert.ok(!fs.existsSync(path.join(ROOT, rel)),
      rel + ' 又出现了。主体在 tools/cli/start.js，薄壳是 start.bat / start.sh。')
  }
})

// ⭐ --dry-run 必须一个进程都不起。这是它在别人后端正跑着的机器上能被验证的前提。
test('--dry-run 解完端口就退出，不起任何进程', () => {
  const r = spawnSync(process.execPath, [BODY, '--dry-run'], {
    encoding: 'utf8', timeout: 120000, env: Object.assign({}, process.env, { NO_COLOR: '1' }),
  })
  assert.equal(r.status, 0, '--dry-run 不该失败：\n' + (r.stdout || '') + (r.stderr || ''))
  const out = (r.stdout || '') + (r.stderr || '')
  assert.match(out, /--dry-run/,
    '--dry-run 应当在输出里说明它没起任何进程（否则用户无法确认它安全）')
  // ⚠️ 只验证「报告」这一半 —— 「真的没起进程」靠这一行本身：
  //   真去验它得先知道有哪些进程被起了，而 --dry-run 的意义就是不产生它们。
  //   ⇒ 这里断言的是「它走到了 dry-run 的出口那一支」。
  assert.ok(!/Backend started in background/.test(out), 'dry-run 起了后端')
  assert.ok(!/Inference service started/.test(out), 'dry-run 起了引擎')
})