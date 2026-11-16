'use strict'
// cliDraft：扫描到的 flag → 名片 args 段草稿。
const test = require('node:test')
const assert = require('node:assert')
const { buildCliDraft } = require('../core/cliDraft')

const help = (flags) => ({ ok: true, flags })

test('长开关在前、短别名在后（--text -t）照样进草稿，取的是长开关', () => {
  const d = buildCliDraft(help([
    { flags: ['--text', '-t'], dest: 'text', subcommand: null },
    { flags: ['--prompt-audio', '-pa'], dest: 'prompt_audio', subcommand: null },
    { flags: ['-o', '--output'], dest: 'output', subcommand: 'clone' },
  ]))
  assert.ok(d.ok)
  assert.deepStrictEqual(d.args.map((a) => a.flag), ['--text', '--prompt-audio', '--output'])
  assert.deepStrictEqual(d.args.map((a) => a.name), ['text', 'prompt-audio', 'output'])
})

test('只有短开关的照旧不进草稿（名片 args 段只放长开关）', () => {
  const d = buildCliDraft(help([{ flags: ['-v'], dest: 'v', subcommand: null }]))
  assert.deepStrictEqual(d.args, [])
})

// 位置参数以前在这里被静默丢掉：只取带 -- 的长开关，没有长开关就 continue。
//   结果是一台只收位置参数的引擎扫出来「零个参数」，界面上像是没扫到东西。
test('⭐⭐⭐ 位置参数单列一份，不进 args，nargs 跟着带出来', () => {
  const d = buildCliDraft(help([
    { flags: ['text'], dest: 'text', is_option: false, nargs: '+', help: 'lines to speak' },
    { flags: ['--speed'], dest: 'speed', is_option: true, type: 'float' },
  ]))
  assert.deepStrictEqual(d.args.map((a) => a.flag), ['--speed'],
    'args 每条都要一个开关，位置参数写不进去')
  assert.deepStrictEqual(d.positionals.map((x) => x.name), ['text'])
  assert.strictEqual(d.positionals[0].nargs, '+')
  assert.strictEqual(d.positionals[0].help, 'lines to speak')
})

test('完全没有开关、只有位置参数时也照实交出去，不是空手', () => {
  const d = buildCliDraft(help([
    { flags: ['text'], dest: 'text', is_option: false },
    { flags: ['output'], dest: 'output', is_option: false },
  ]))
  assert.deepStrictEqual(d.args, [])
  assert.deepStrictEqual(d.positionals.map((x) => x.name), ['text', 'output'])
})
