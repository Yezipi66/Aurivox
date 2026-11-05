'use strict'
// 「可复现性（seed）」那一格的读写。两种 kind 的参数名不是同一种东西：
//   python 是方法的关键字参数名；
//   cli 是 call.args 的键，宿主还要靠那一条把种子拼成 `--seed 42`。
// 只写 call.seed 而不补 call.args 时，宿主会当场报「参数没有说明该变成哪个开关」，
// 所以这条链必须逐段守住。

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

const {
  seedModeOf, seedArgText, seedRngsOf, seedRngNames,
  withSeedMode, withSeedArg, withSeedRng,
} = load()

const cli = (extra) => ({ kind: 'cli', argv: ['{engine_python}', '-m', 'x.cli'], ...extra })
const py = () => ({ kind: 'python', module: 'm', class: 'C', method: 'infer' })

test('三态认得出：缺省与 "none" 都是不可复现', () => {
  assert.equal(seedModeOf({}), 'none')
  assert.equal(seedModeOf({ seed: 'none' }), 'none')
  assert.equal(seedModeOf({ seed: { arg: 'seed' } }), 'arg')
  assert.equal(seedModeOf({ seed: { mode: 'global', rngs: ['torch'] } }), 'global')
})

test('cli 选「引擎自己收」：参数名是 args 的键，并补出一条开关形状', () => {
  const c = withSeedMode(cli(), 'arg')
  assert.deepStrictEqual(c.seed, { arg: 'seed' })
  assert.deepStrictEqual(c.args.seed, { flag: '--seed', style: 'value' })
  assert.equal(seedArgText(c), '--seed', '界面上显示开关本身')
})

test('python 选「引擎自己收」：写方法参数名，不碰 args', () => {
  const c = withSeedMode(py(), 'arg')
  assert.deepStrictEqual(c.seed, { arg: 'seed' })
  assert.strictEqual(c.args, undefined, 'python 形态没有 args 表')
  assert.equal(seedArgText(c), 'seed')
})

test('从「引擎自己收」切走：那条 args 一起收走', () => {
  const had = withSeedMode(cli(), 'arg')
  for (const mode of ['none', 'global']) {
    const c = withSeedMode(had, mode)
    assert.ok(!c.args || c.args.seed === undefined, mode + ' 状态不该留着只为种子存在的 args 条目')
    assert.ok(c.seed === 'none' || c.seed.mode === 'global')
  }
})

test('改参数字：cli 下键跟着开关走，旧键收走', () => {
  const had = withSeedMode(cli(), 'arg')
  const c = withSeedArg(had, '--random-seed')
  assert.deepStrictEqual(c.seed, { arg: 'random_seed' })
  assert.deepStrictEqual(c.args.random_seed, { flag: '--random-seed', style: 'value' })
  assert.strictEqual(c.args.seed, undefined, '改名字后旧键留着就是一条没人用的开关')
})

test('清空参数字：写空串并把 args 收走，不替人补回默认值', () => {
  const had = withSeedMode(cli(), 'arg')
  const c = withSeedArg(had, '   ')
  assert.deepStrictEqual(c.seed, { arg: '' })
  assert.strictEqual(c.args && c.args.seed, undefined)
})

test('随机源：勾上、取消都写回 mode=global', () => {
  const a = withSeedRng(py(), 'torch', true)
  assert.deepStrictEqual(a.seed, { mode: 'global', rngs: ['torch'] })
  const b = withSeedRng(a, 'torch', false)
  assert.deepStrictEqual(b.seed, { mode: 'global', rngs: [] })
  assert.deepStrictEqual(seedRngsOf(b), [])
})

test('随机源名单与宿主的 _RNG_TABLE 同一份四项', () => {
  assert.deepStrictEqual(seedRngNames(), ['python', 'numpy', 'torch', 'torch.cuda'])
  // 名单是副本：调用方改了它，下一次取到的仍是原样。
  seedRngNames().push('nope')
  assert.equal(seedRngNames().length, 4)
})

test('原对象不被就地改写', () => {
  const before = cli()
  const snapshot = JSON.stringify(before)
  withSeedMode(before, 'arg')
  withSeedArg(before, '--seed')
  assert.equal(JSON.stringify(before), snapshot)
})
