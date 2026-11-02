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
