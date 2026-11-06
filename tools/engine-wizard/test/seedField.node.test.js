'use strict'
// 「seed」那一格的读写。两种 kind 的参数名不是同一种东西：
//   python 是方法的关键字参数名；
//   cli 是 call.args 的键，宿主还要靠那一条把种子拼成 `--seed 42`。
// 只写 call.seed 而不补 call.args 时，宿主会当场报「参数没有说明该变成哪个开关」，
// 所以这条链必须逐段守住。界面上只有一个输入框，留空＝不可复现（落盘是显式 "none"）。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const SOURCE = path.join(__dirname, '..', 'editor', 'seedField.js')

function load () {
  const esbuild = require('../../../lib/testDeps.js').esbuild()
  assert.ok(esbuild, '拿不到编译依赖')
  const code = esbuild.transformSync(fs.readFileSync(SOURCE, 'utf8'),
    { loader: 'js', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', code)(
    mod.exports, () => { throw new Error('纯函数模块不该有依赖') }, mod)
  return mod.exports
}

const { seedArgText, withSeedSwitch } = load()

const cli = (extra) => ({ kind: 'cli', argv: ['{engine_python}', '-m', 'x.cli'], ...extra })
const py = () => ({ kind: 'python', module: 'm', class: 'C', method: 'infer' })

test('cli 填开关 ⇒ 参数名是 args 的键，并补出一条开关形状', () => {
  const c = withSeedSwitch(cli(), '--seed')
  assert.deepStrictEqual(c.seed, { arg: 'seed' })
  assert.deepStrictEqual(c.args.seed, { flag: '--seed', style: 'value' })
  assert.equal(seedArgText(c), '--seed', '界面上回显的是开关本身')
})

test('cli 不写横线也认：seed 与 --seed 落盘一致', () => {
  const a = withSeedSwitch(cli(), 'seed')
  const b = withSeedSwitch(cli(), '--seed')
  assert.deepStrictEqual(a.seed, b.seed)
  assert.deepStrictEqual(a.args, b.args)
})

test('cli 改名：键跟着开关走，旧键收走', () => {
  const had = withSeedSwitch(cli(), '--seed')
  const c = withSeedSwitch(had, '--random-seed')
  assert.deepStrictEqual(c.seed, { arg: 'random_seed' })
  assert.deepStrictEqual(c.args.random_seed, { flag: '--random-seed', style: 'value' })
  assert.strictEqual(c.args.seed, undefined, '旧键留着就是一条没人用的开关')
})

test('留空 ⇒ 显式 "none"，那条 args 一起收走', () => {
  const had = withSeedSwitch(cli(), '--seed')
  for (const blank of ['', '   ']) {
    const c = withSeedSwitch(had, blank)
    assert.strictEqual(c.seed, 'none', '删掉这一项会让名片缺必填，落盘要是显式的 none')
    assert.strictEqual(c.args && c.args.seed, undefined)
    assert.strictEqual(seedArgText(c), '')
  }
})

test('cli 的其它 args 不受影响：删的只是为种子补出的那一条', () => {
  const base = cli({ args: { device: { flag: '--device', style: 'value' } } })
  const had = withSeedSwitch(base, '--seed')
  const c = withSeedSwitch(had, '')
  assert.deepStrictEqual(c.args, { device: { flag: '--device', style: 'value' } })
})

test('python 填参数名：只写 call.seed，不建 args 表', () => {
  const c = withSeedSwitch(py(), 'seed')
  assert.deepStrictEqual(c.seed, { arg: 'seed' })
  assert.strictEqual(c.args, undefined, 'python 形态没有命令行，也就没有 args')
  assert.equal(seedArgText(c), 'seed')
})

test('python 留空同样落成 "none"', () => {
  const c = withSeedSwitch(withSeedSwitch(py(), 'seed'), '')
  assert.strictEqual(c.seed, 'none')
})

test('全局播种没有对应输入框：回显为空，且不动原有声明', () => {
  const g = py()
  g.seed = { mode: 'global', rngs: ['torch'] }
  assert.equal(seedArgText(g), '', '全局播种没有开关名可显示')
})

test('原对象不被就地改写', () => {
  const before = cli()
  const snapshot = JSON.stringify(before)
  withSeedSwitch(before, '--seed')
  assert.equal(JSON.stringify(before), snapshot)
})
